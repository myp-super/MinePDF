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
  SearchResult,
} from '../../src/shared/types';
import { getDataDir, getLibraryPdfDir, getLibraryRoot } from '../db/database';
import { repository } from '../db/repository';
import { backupData } from '../services/backup';
import { importPdfs } from '../services/import';
import { scanLibrary } from '../services/libraryWatcher';
import { getSettings, updateSettings } from '../services/settings';
import { checkForUpdates, downloadUpdate } from '../services/updater';

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
    if (isMineProgId(uc)) return true;
    const def = await defaultPdfProgId();
    return isMineProgId(def);
  });
  handle('app:set-pdf-association', async (enable: boolean) => {
    const icon = path.join(process.resourcesPath, 'file-assoc.ico');
    if (enable) {
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
      await shell.openExternal('ms-settings:defaultapps');
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
  handle('app:open-defaultapps', () => shell.openExternal('ms-settings:defaultapps'));

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
    if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 链接');
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
