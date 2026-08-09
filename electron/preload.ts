import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PkmApi } from '../src/shared/types';

interface InvokeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** 统一 IPC 调用：自动解包 { ok, data | error } 并抛错 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  let res: InvokeResult<T>;
  try {
    res = (await ipcRenderer.invoke(channel, ...args)) as InvokeResult<T>;
  } catch (err) {
    console.error('[preload:invoke-failed]', channel, err);
    throw err;
  }
  if (!res?.ok) throw new Error(res?.error ?? `IPC 调用失败: ${channel}`);
  return res.data as T;
}

function subscribe(channel: string, cb: (value: unknown) => void): () => void {
  const listener = (_event: unknown, value: unknown): void => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: PkmApi = {
  getAppInfo: () => invoke('app:info'),
  getSnapshot: () => invoke('library:snapshot'),

  createFolder: (name, parentId) => invoke('folder:create', name, parentId),
  renameFolder: (id, name) => invoke('folder:rename', id, name),
  deleteFolder: (id) => invoke('folder:delete', id),
  moveFolder: (id, parentId) => invoke('folder:move', id, parentId),

  inboxList: () => invoke('inbox:list'),
  inboxAdd: (filePath) => invoke('inbox:add', filePath),
  inboxRemove: (id) => invoke('inbox:remove', id),
  inboxClear: () => invoke('inbox:clear'),
  inboxToLibrary: (id, folderId) => invoke('inbox:to-library', id, folderId),
  isDefaultPdfApp: () => invoke('app:is-default-pdf'),
  setPdfAssociation: (enable) => invoke('app:set-pdf-association', enable),
  openDefaultApps: () => invoke('app:open-defaultapps'),
  onExternalPdf: (cb) => subscribe('app:external-pdf', (v) => cb(String(v))),

  importPdfs: (paths, folderId, opts) => invoke('pdf:import', paths, folderId, opts),
  deletePdf: (id) => invoke('pdf:delete', id),
  movePdf: (id, folderId) => invoke('pdf:move', id, folderId),
  updatePdfTitle: (id, title) => invoke('pdf:update-title', id, title),
  updatePdfPageCount: (id, count) => invoke('pdf:update-page-count', id, count),
  updatePdfHasOutline: (id, has) => invoke('pdf:update-has-outline', id, has),
  relocatePdf: (id) => invoke('pdf:relocate', id),
  revealPdf: (id) => invoke('pdf:reveal', id),
  revealFolder: (id) => invoke('folder:reveal', id),
  scanLibrary: () => invoke('library:scan'),
  openLibraryFolder: () => invoke('library:open-folder'),
  readPdf: async (id) => {
    const bytes = await invoke<Uint8Array>('pdf:read', id);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  },
  pdfiumAvailable: () => invoke('pdfium:available'),
  pdfiumOpen: (id) => invoke('pdfium:open', id),
  pdfiumRender: (id, page, scale) => invoke('pdfium:render', id, page, scale),
  pdfiumRenderBatch: (id, pages, scale) => invoke('pdfium:render-batch', id, pages, scale),
  // 端口在 preload 内创建并直接发给主进程；port1 经 contextBridge.postMessage
  // 传回渲染主世界，避免 MessagePort 作为 exposed 函数参数跨桥传输
  pdfiumClose: (id) => invoke('pdfium:close', id),
  pdfiumShutdown: () => invoke('pdfium:shutdown'),
  openPdfExternal: (id) => invoke('pdf:open-external', id),

  addTag: (pdfId, name) => invoke('tag:add', pdfId, name),
  removeTag: (pdfId, tagId) => invoke('tag:remove', pdfId, tagId),
  deleteTag: (tagId) => invoke('tag:delete', tagId),

  getNote: (pdfId) => invoke('note:get', pdfId),
  saveNote: (pdfId, markdown) => invoke('note:save', pdfId, markdown),
  revealNoteFile: (pdfId) => invoke('note:reveal', pdfId),
  exportNoteToPdf: (payload) => invoke('note:export-pdf', payload),
  saveNoteImage: (pdfId, dataUrl) => invoke('note:save-image', pdfId, dataUrl),

  listAnnotations: (pdfId) => invoke('annotation:list', pdfId),
  createAnnotation: (data) => invoke('annotation:create', data),
  updateAnnotation: (id, patch) => invoke('annotation:update', id, patch),
  deleteAnnotation: (id) => invoke('annotation:delete', id),

  search: (q) => invoke('search:query', q),

  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  checkForUpdates: () => invoke('update:check'),
  downloadUpdate: (url) => invoke('update:download', url),
  onDownloadProgress: (cb) =>
    subscribe('update:download-progress', (v) => cb(Number(v))),
  installUpdate: (filePath, silent) =>
    invoke(silent ? 'update:install-silent' : 'update:install-wizard', filePath),
  openExternalUrl: (url) => invoke('app:open-url', url),
  chooseDirectory: (title) => invoke('settings:choose-dir', title),
  openDataFolder: () => invoke('data:open-folder'),
  backupData: () => invoke('data:backup'),

  openPdfDialog: () => invoke('dialog:open-pdfs'),
  openFolderDialog: () => invoke('dialog:open-folder'),

  minimize: () => invoke('window:minimize'),
  toggleMaximize: () => invoke('window:toggle-maximize'),
  close: () => invoke('window:close'),
  setFullScreen: (flag) => invoke('window:set-fullscreen', flag),
  isFullScreen: () => invoke('window:is-fullscreen'),
  isMaximized: () => invoke('window:is-maximized'),
  onFullScreenChange: (cb) => subscribe('window:fullscreen-changed', (v) => cb(Boolean(v))),
  onMaximizedChange: (cb) => subscribe('window:maximized-changed', (v) => cb(Boolean(v))),
  onLibraryChanged: (cb) => subscribe('library:changed', () => cb()),
  onUpdateAvailable: (cb) =>
    subscribe('update:available', (v) => cb(v as never)),

  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('pkm', api);
