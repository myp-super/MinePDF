import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type {
  AnnotationRecord,
  AppInfo,
  AppSettings,
  ImportResult,
  NewAnnotation,
  PdfRecord,
  PdfiumOpenResult,
  PdfiumRenderResult,
  SearchResult,
} from '../../src/shared/types';
import { getDataDir, getLibraryPdfDir, getLibraryRoot } from '../db/database';
import { repository } from '../db/repository';
import { backupData } from '../services/backup';
import { importPdfs } from '../services/import';
import { scanLibrary } from '../services/libraryWatcher';
import { getSettings, updateSettings } from '../services/settings';
import { checkForUpdates, downloadUpdate } from '../services/updater';
import {
  isPdfiumAvailable,
  pdfiumClose,
  pdfiumOpen,
  pdfiumRender,
  pdfiumRenderBatch,
  pdfiumShutdown,
} from '../services/pdfium';

interface InvokeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// 最近读取的 PDF 内容缓存（避免重复磁盘读），LRU 上限约 128MB
const READ_CACHE = new Map<string, { size: number; mtimeMs: number; buf: Buffer }>();
const READ_CACHE_MAX_BYTES = 128 * 1024 * 1024;
let readCacheBytes = 0;

function readPdfCached(filepath: string): Buffer {
  const st = fs.statSync(filepath);
  const hit = READ_CACHE.get(filepath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.buf;
  const buf = fs.readFileSync(filepath);
  if (READ_CACHE.has(filepath)) {
    readCacheBytes -= READ_CACHE.get(filepath)!.buf.length;
    READ_CACHE.delete(filepath);
  }
  READ_CACHE.set(filepath, { size: st.size, mtimeMs: st.mtimeMs, buf });
  readCacheBytes += buf.length;
  while (readCacheBytes > READ_CACHE_MAX_BYTES && READ_CACHE.size > 1) {
    const oldest = READ_CACHE.keys().next().value as string;
    const old = READ_CACHE.get(oldest);
    READ_CACHE.delete(oldest);
    if (old) readCacheBytes -= old.buf.length;
  }
  return buf;
}

/** 主窗口引用（由 main.ts 注入，用于模态对话框与窗口控制） */
let mainWin: BrowserWindow | null = null;
export function setMainWindow(win: BrowserWindow | null): void {
  mainWin = win;
}

/** 渲染进程就绪回调（main.ts 用于在页面挂载后再派发外部 PDF） */
let rendererReadyCb: (() => void) | null = null;
export function onRendererReady(cb: () => void): void {
  rendererReadyCb = cb;
}

/** MinePDF 注册的 PDF ProgID */
const PDF_PROG_ID = 'MinePDF.pdf';

/** 读取注册表值（失败返回 null） */
function regQuery(key: string, value?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ['query', key];
    if (value) args.push('/v', value);
    execFile('reg', args, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

/** 执行注册表写入/删除（失败静默，不影响主流程） */
function regRun(args: string[]): Promise<void> {
  return new Promise((resolve) => execFile('reg', args, () => resolve()));
}

function isMineProgId(text: string | null): boolean {
  return !!text && /mine/i.test(text);
}

/** HKCU\Software\Classes\.pdf 的默认 ProgID（旧版安装器/开启开关时写入） */
async function defaultPdfProgId(): Promise<string | null> {
  const out = await regQuery('HKCU\\Software\\Classes\\.pdf');
  const m = out ? /REG_SZ\s+(\S+)/i.exec(out) : null;
  return m ? m[1] : null;
}

/** Windows 用户选择（UserChoice）中的 .pdf ProgID，仅用户主动选择时存在 */
async function userChoiceProgId(): Promise<string | null> {
  const out = await regQuery(
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice',
    'ProgId',
  );
  const m = out ? /REG_SZ\s+(\S+)/i.exec(out) : null;
  return m ? m[1] : null;
}

/** 生成一份最小合法 PDF（用于触发系统“打开方式”对话框） */
function buildSamplePdf(): string {
  const objects: Record<number, string> = {
    1: '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    2: '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    3: '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    4: '4 0 obj\n<< /Length 40 >>\nstream\nBT /F1 18 Tf 72 720 Td (MinePDF) Tj ET\nendstream\nendobj\n',
  };
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const id of [1, 2, 3, 4]) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += objects[id];
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 5\n0000000000 65535 f \n';
  for (let i = 1; i <= 4; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

/** 写入 MinePDF 的 .pdf ProgID（命令 + 图标），让应用出现在系统“打开方式”列表 */
async function ensurePdfProgId(): Promise<void> {
  const icon = path.join(process.resourcesPath, 'file-assoc.ico');
  await regRun(['add', 'HKCU\\Software\\Classes\\.pdf', '/ve', '/d', PDF_PROG_ID, '/f']);
  await regRun([
    'add',
    `HKCU\\Software\\Classes\\${PDF_PROG_ID}\\shell\\open\\command`,
    '/ve',
    '/d',
    `"${process.execPath}" "%1"`,
    '/f',
  ]);
  await regRun([
    'add',
    `HKCU\\Software\\Classes\\${PDF_PROG_ID}\\DefaultIcon`,
    '/ve',
    '/d',
    `"${icon}"`,
    '/f',
  ]);
}

/**
 * 触发系统“打开方式”对话框，让用户选择 MinePDF 并勾选“始终使用此应用”。
 * Windows 10/11 的 UserChoice 带哈希校验，只有系统对话框能正确写入，
 * 程序直接改注册表会被系统拒绝。失败时回退到系统默认应用设置页。
 */
async function openChoosePdfApp(): Promise<void> {
  try {
    await ensurePdfProgId();
    let sample: string | null = null;
    const pdfs = repository.getPdfs();
    if (pdfs.length > 0) sample = pdfs[0].filepath;
    if (!sample) {
      const dir = path.join(getDataDir(), 'config');
      fs.mkdirSync(dir, { recursive: true });
      sample = path.join(dir, 'open-with-sample.pdf');
      fs.writeFileSync(sample, buildSamplePdf(), 'latin1');
    }
    await new Promise<void>((resolve) =>
      execFile('rundll32', ['shell32.dll,OpenAs_RunDLL', sample], () => resolve()),
    );
  } catch {
    await shell.openExternal('ms-settings:defaultapps');
  }
}

/**
 * 旧版本安装包会强制注册 .pdf 关联（fileAssociations），即使用户从未开启开关。
 * 启动时若用户没有主动选择 MinePDF，就撤销这种残留关联，杜绝强制默认。
 */
export async function ensureNoForcedPdfAssociation(): Promise<void> {
  try {
    if (getSettings().pdfDefaultApp) return;
    const def = await defaultPdfProgId();
    const uc = await userChoiceProgId();
    // 只有“默认指向 MinePDF 但用户并未主动选择 MinePDF”时才清理
    if (isMineProgId(def) && !isMineProgId(uc)) {
      await regRun(['delete', 'HKCU\\Software\\Classes\\.pdf', '/ve', '/f']);
      await regRun(['delete', `HKCU\\Software\\Classes\\${PDF_PROG_ID}`, '/f']);
    }
  } catch {
    /* registry cleanup must never block startup */
  }
}

/**
 * 统一注册 IPC：所有 handler 只接收业务参数（不含 event），
 * 异常统一包装为 { ok, data | error }，便于渲染进程给出友好提示。
 */
function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<InvokeResult<T>> => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (process.env.PKM_SMOKE_TEST === '1') {
        console.error(`[ipc] channel=${channel} error=${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function registerIpc(): void {
  // ---------- 窗口控制（自定义标题栏） ----------
  handle('window:minimize', () => mainWin?.minimize());
  handle('window:toggle-maximize', () => {
    if (!mainWin) return false;
    if (mainWin.isMaximized()) {
      mainWin.unmaximize();
      return false;
    }
    mainWin.maximize();
    return true;
  });
  handle('window:close', () => mainWin?.close());
  handle('window:set-fullscreen', (flag: boolean) => mainWin?.setFullScreen(Boolean(flag)));
  handle('window:is-fullscreen', () => mainWin?.isFullScreen() ?? false);
  handle('window:is-maximized', () => mainWin?.isMaximized() ?? false);

  // ---------- 应用信息 ----------
  handle<AppInfo>('app:info', () => ({
    version: app.getVersion(),
    dataDir: getDataDir(),
    libraryDir: getLibraryRoot(),
    isPackaged: !process.env.VITE_DEV_SERVER_URL,
  }));

  // ---------- 库快照 ----------
  handle('library:snapshot', () => ({
    folders: repository.getFolders(),
    pdfs: repository.getPdfs(),
    tags: repository.getTags(),
    settings: getSettings(),
  }));

  // ---------- 文件夹 ----------
  handle('folder:create', (name: string, parentId: number | null) => repository.createFolder(name, parentId));
  handle('folder:rename', (id: number, name: string) => repository.renameFolder(id, name));
  handle('folder:delete', (id: number) => repository.deleteFolder(id));
  handle('folder:move', (id: number, parentId: number | null) => repository.moveFolder(id, parentId));

  // ---------- 临时阅读区（Inbox） ----------
  handle('inbox:list', () => repository.getInboxPdfs());
  handle('inbox:add', (filePath: string) => repository.addToInbox(filePath));
  handle('inbox:remove', (id: number) => repository.deletePdf(id));
  handle('inbox:clear', () => repository.clearInbox());
  handle('inbox:to-library', (id: number, folderId: number | null) =>
    repository.moveInboxToLibrary(id, folderId),
  );

  // ---------- 默认 PDF 应用 ----------
  handle('app:is-default-pdf', async () => {
    const uc = await userChoiceProgId();
    // Windows 10/11 中 UserChoice 才是双击真正生效的关联，优先以它为准
    if (uc) return isMineProgId(uc);
    const def = await defaultPdfProgId();
    return isMineProgId(def);
  });
  handle('app:set-pdf-association', async (enable: boolean) => {
    if (enable) {
      await openChoosePdfApp();
      updateSettings({ pdfDefaultApp: true });
      return true;
    }
    // 关闭：撤销本应用写入的 .pdf 默认值、ProgID，以及用户选择里指向 MinePDF 的条目
    const def = await defaultPdfProgId();
    if (isMineProgId(def)) {
      await regRun(['delete', 'HKCU\\Software\\Classes\\.pdf', '/ve', '/f']);
    }
    const uc = await userChoiceProgId();
    if (isMineProgId(uc)) {
      await regRun([
        'delete',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice',
        '/v',
        'ProgId',
        '/f',
      ]);
    }
    await regRun(['delete', `HKCU\\Software\\Classes\\${PDF_PROG_ID}`, '/f']);
    updateSettings({ pdfDefaultApp: false });
    return false;
  });
  handle('app:open-defaultapps', () => openChoosePdfApp());
  handle('app:renderer-ready', () => {
    rendererReadyCb?.();
  });

  // ---------- PDF ----------
  handle<ImportResult>('pdf:import', (paths: string[], folderId: number | null, opts?: { replace?: boolean }) =>
    importPdfs(paths, folderId, opts ?? {}),
  );
  handle('pdf:delete', (id: number) => repository.deletePdf(id));
  handle('pdf:move', (id: number, folderId: number | null) => repository.movePdf(id, folderId));
  handle('pdf:update-title', (id: number, title: string) => repository.updatePdfTitle(id, title));
  handle('pdf:update-page-count', (id: number, count: number) => repository.updatePdfPageCount(id, count));
  handle('pdf:update-has-outline', (id: number, has: boolean) =>
    repository.updatePdfHasOutline(id, Boolean(has)),
  );

  handle<PdfRecord>('pdf:relocate', async (id: number) => {
    const res = await dialog.showOpenDialog(mainWin!, {
      title: '重新定位 PDF 文件',
      properties: ['openFile'],
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePaths[0]) throw new Error('已取消重新定位');
    return repository.relocatePdf(id, res.filePaths[0]);
  });

  handle('pdf:read', (id: number) => {
    const pdf = repository.getPdf(id);
    if (!pdf) throw new Error('ERR_PDF_MISSING:知识库中不存在该记录');
    if (!fs.existsSync(pdf.filepath)) {
      repository.setPdfStatus(id, 'missing');
      throw new Error('ERR_PDF_MISSING:文件不存在或已被移动');
    }
    if (pdf.status === 'missing') repository.setPdfStatus(id, 'ok');
    return readPdfCached(pdf.filepath) as unknown as ArrayBuffer;
  });

  // ---------- PDFium 原生渲染（2.0.0 混合架构） ----------
  handle<boolean>('pdfium:available', () => isPdfiumAvailable());
  handle<PdfiumOpenResult | null>('pdfium:open', (id: number) => pdfiumOpen(id));
  handle<PdfiumRenderResult>('pdfium:render', (id: number, page: number, scale: number) =>
    pdfiumRender(id, page, scale),
  );
  handle<PdfiumRenderResult[]>('pdfium:render-batch', (id: number, pages: number[], scale: number) => {
    if (process.env.PKM_SMOKE_TEST === '1') {
      console.log(`[batch] start id=${id} pages=${pages.length}`);
    }
    const res = pdfiumRenderBatch(id, pages, scale);
    if (process.env.PKM_SMOKE_TEST === '1') {
      console.log(`[batch] done id=${id} pages=${res.length}`);
    }
    return res;
  });
  handle('pdfium:close', (id: number) => {
    pdfiumClose(id);
  });
  handle('pdfium:shutdown', () => {
    pdfiumShutdown();
  });

  handle('pdf:open-external', (id: number) => {
    const pdf = repository.getPdf(id);
    if (!pdf) throw new Error('ERR_PDF_MISSING:知识库中不存在该记录');
    if (!fs.existsSync(pdf.filepath)) {
      repository.setPdfStatus(id, 'missing');
      throw new Error('ERR_PDF_MISSING:文件不存在或已被移动');
    }
    return shell.openPath(pdf.filepath);
  });
  handle('pdf:reveal', (id: number) => {
    const pdf = repository.getPdf(id);
    if (!pdf) throw new Error('ERR_PDF_MISSING:知识库中不存在该记录');
    shell.showItemInFolder(pdf.filepath);
  });
  handle('folder:reveal', (id: number) => shell.openPath(repository.folderRealDir(id)));
  handle('library:scan', () => scanLibrary());
  handle('library:open-folder', () => shell.openPath(getLibraryPdfDir()));

  // ---------- 标签 ----------
  handle('tag:add', (pdfId: number, name: string) => repository.addTagToPdf(pdfId, name));
  handle('tag:remove', (pdfId: number, tagId: number) => repository.removeTagFromPdf(pdfId, tagId));
  handle('tag:delete', (tagId: number) => repository.deleteTag(tagId));

  // ---------- 笔记 ----------
  handle('note:get', (pdfId: number) => repository.getNote(pdfId));
  handle('note:save', (pdfId: number, markdown: string) => repository.upsertNote(pdfId, markdown));
  handle('note:reveal', (pdfId: number) => {
    const note = repository.getNote(pdfId);
    if (!note?.noteFile) throw new Error('笔记文件尚未创建');
    shell.showItemInFolder(note.noteFile);
  });
  handle('note:export-pdf', async (payload: { html: string; suggestedName: string }) => {
    let katexCss = '';
    try {
      const katexDir = path.join(app.getAppPath(), 'node_modules', 'katex');
      katexCss = fs
        .readFileSync(path.join(katexDir, 'dist', 'katex.min.css'), 'utf8')
        .replace(
          /url\((fonts\/[^)]+)\)/g,
          (_m: string, p1: string) => `url(file://${path.join(katexDir, 'dist', p1).replace(/\\/g, '/')})`,
        );
    } catch {
      /* ignore */
    }
    const html = payload.html.replace('/*__KATEX_CSS__*/', katexCss);
    const tmp = path.join(app.getPath('temp'), `minepdf-export-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await win.loadFile(tmp);
      const pdf = await win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { top: 0.55, bottom: 0.55, left: 0.6, right: 0.6 },
      });
      win.destroy();
      fs.unlinkSync(tmp);
      const res = await dialog.showSaveDialog(mainWin!, {
        title: '导出笔记为 PDF',
        defaultPath: payload.suggestedName,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      });
      if (res.canceled || !res.filePath) return null;
      fs.writeFileSync(res.filePath, pdf);
      return res.filePath;
    } finally {
      if (!win.isDestroyed()) win.destroy();
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  });
  handle('note:save-image', (pdfId: number, dataUrl: string) => {
    // 截图存入该笔记自己的 assets/ 目录（data/notes/<PDF标题>/assets/）
    return repository.saveNoteImage(pdfId, dataUrl);
  });

  // ---------- 标注 ----------
  handle('annotation:list', (pdfId: number) => repository.listAnnotations(pdfId));
  handle('annotation:create', (data: NewAnnotation) => repository.createAnnotation(data));
  handle(
    'annotation:update',
    (id: number, patch: Partial<Pick<AnnotationRecord, 'note' | 'color' | 'content' | 'page' | 'position'>>) =>
      repository.updateAnnotation(id, patch),
  );
  handle('annotation:delete', (id: number) => repository.deleteAnnotation(id));

  // ---------- 搜索 ----------
  handle<SearchResult>('search:query', (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return { pdfs: [], notes: [], tags: [] };
    return repository.search(trimmed);
  });

  // ---------- 设置与数据 ----------
  handle<AppSettings>('settings:get', () => getSettings());
  handle<AppSettings>('settings:update', (patch: Partial<AppSettings>) => updateSettings(patch));
  handle<string | null>('settings:choose-dir', async (title: string) => {
    const res = await dialog.showOpenDialog(mainWin!, {
      title,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  handle('data:open-folder', () => shell.openPath(getDataDir()));
  handle('data:backup', () => backupData(mainWin));

  // ---------- 更新检查 ----------
  handle('update:check', () => checkForUpdates());
  handle('update:download', async (url: string) => {
    const result = await downloadUpdate(url, (percent) => {
      mainWin?.webContents.send('update:download-progress', percent);
    });
    return result;
  });
  handle('update:install-silent', (filePath: string) => {
    const child = spawn(filePath, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    // 安装程序替换运行中的文件前，先退出应用
    setTimeout(() => app.quit(), 800);
    return true;
  });
  handle('update:install-wizard', (filePath: string) => shell.openPath(filePath));
  handle('app:open-url', (url: string) => {
    // 允许 http/https/mailto/tel：PDF 内的网址、邮箱、电话链接均可跳转
    if (!/^(https?:|mailto:|tel:)/i.test(url)) throw new Error('仅支持 http/https/mailto/tel 链接');
    if (process.env.PKM_SMOKE_TEST === '1') {
      console.log(`[open-url] ${url}`);
      return;
    }
    return shell.openExternal(url);
  });

  // ---------- 文件对话框 ----------
  handle<string[]>('dialog:open-pdfs', async () => {
    const res = await dialog.showOpenDialog(mainWin!, {
      title: '选择要导入的 PDF 文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  handle<string[]>('dialog:open-folder', async () => {
    const res = await dialog.showOpenDialog(mainWin!, {
      title: '选择包含 PDF 的文件夹（递归导入）',
      properties: ['openDirectory'],
    });
    return res.canceled ? [] : res.filePaths;
  });
}
