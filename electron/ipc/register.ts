import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'fs';
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
import { checkForUpdates } from '../services/updater';

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

  // ---------- PDF ----------
  handle<ImportResult>('pdf:import', (paths: string[], folderId: number | null, opts?: { replace?: boolean }) =>
    importPdfs(paths, folderId, opts ?? {}),
  );
  handle('pdf:delete', (id: number) => repository.deletePdf(id));
  handle('pdf:move', (id: number, folderId: number | null) => repository.movePdf(id, folderId));
  handle('pdf:update-title', (id: number, title: string) => repository.updatePdfTitle(id, title));
  handle('pdf:update-page-count', (id: number, count: number) => repository.updatePdfPageCount(id, count));

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
