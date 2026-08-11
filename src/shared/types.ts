/**
 * 主进程与渲染进程共享的数据类型。
 * 数据库行以下划线命名，对外统一映射为驼峰结构。
 */

/** 知识库：Library 下的一级目录，对应一个根文件夹节点 */
export interface LibraryRecord {
  id: number;
  name: string;
  /** 知识库根文件夹 id（所有 PDF 最终都挂在某个文件夹上） */
  rootFolderId: number;
  createdAt: string;
}

/** 文件夹节点（与 Library 下的真实目录一一对应） */
export interface Folder {
  id: number;
  name: string;
  parentId: number | null;
  /** 相对 Library 根目录的路径（如 深度学习/Transformer） */
  path: string;
  /** 所属知识库（顶层根文件夹必定有值；迁移后所有文件夹都有值） */
  libraryId: number | null;
  createdTime: string;
}

/** 标签 */
export interface Tag {
  id: number;
  name: string;
  createdTime: string;
}

/** PDF 文件库条目（不复制原文件，仅保存路径与元数据） */
export interface PdfRecord {
  id: number;
  filename: string;
  filepath: string;
  title: string;
  folderId: number | null;
  size: number;
  pageCount: number | null;
  /** 是否带有书签（目录），用于打开文档时决定信息面板默认页 */
  hasOutline: boolean;
  createdAt: string;
  updatedAt: string;
  status: 'ok' | 'missing';
  tags: Tag[];
}

/** Markdown 笔记 */
export interface NoteRecord {
  id: number;
  pdfId: number;
  markdown: string;
  /** 笔记镜像文件路径（data/notes/<PDF标题> 笔记.md） */
  noteFile?: string;
  /** 笔记目录（含主 md 与截图 assets/）：data/notes/<PDF标题> */
  noteDir?: string;
  updatedAt: string;
}

/** 标注矩形：PDF 页面坐标系（单位 pt，y 轴向上） */
export interface Quad {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 高亮 / 备注标注 */
export interface AnnotationRecord {
  id: number;
  pdfId: number;
  page: number;
  content: string;
  note: string;
  /** JSON 序列化的 Quad[] */
  position: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewAnnotation {
  pdfId: number;
  page: number;
  content: string;
  note: string;
  position: string;
  color: string;
}

export interface AppSettings {
  theme: 'dark' | 'light';
  /** 界面语言，默认简体中文 */
  language: 'zh-CN' | 'en-US';
  autoSave: boolean;
  defaultImportDir: string;
  /** 更新清单 URL（update.json），留空表示关闭自动检查更新 */
  updateUrl: string;
  /** 启动时自动检查更新并弹出提示（默认开启） */
  updateAutoCheck: boolean;
  /** 用户是否主动选择 MinePDF 作为默认 PDF 应用 */
  pdfDefaultApp: boolean;
  /** 阅读 PDF 时自动折叠左侧知识库，鼠标移到左边缘临时展开 */
  autoCollapseSidebar: boolean;
  /** 右键拖拽平移：开启后 PDF 界面鼠标保持系统箭头，按住右键拖动平移；关闭恢复左键拖拽 */
  rightDragPan: boolean;
  /** 知识库根目录（Documents/PDFKnowledgeManager） */
  libraryPath: string;
  /** PDF 库文件夹：所有 PDF 的统一存放目录（Obsidian 式） */
  libraryPdfDir: string;
}

export interface LibrarySnapshot {
  libraries: LibraryRecord[];
  folders: Folder[];
  pdfs: PdfRecord[];
  tags: Tag[];
  settings: AppSettings;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/** PDFium 打开文档后的基本信息（尺寸含页面旋转） */
export interface PdfiumOpenResult {
  pageCount: number;
  width: number;
  height: number;
  version: string;
}

/** PDFium 单页渲染结果（RGBA） */
export interface PdfiumRenderResult {
  w: number;
  h: number;
  data: ArrayBuffer;
  ms: number;
}

/** PDFium 原生提取的页内链接（坐标使用 PDF 用户空间，y 轴向上，与高亮四元组一致） */
export interface PdfiumLink {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 外部链接 URL（http/https/mailto/tel） */
  url?: string;
  /** 页内跳转目标（1 起） */
  destPage?: number;
}

/** PDFium 引擎提取的单个字符（y-up PDF 坐标，字形精确包围盒） */
export interface PdfiumChar {
  x: number;
  y: number;
  w: number;
  h: number;
  str: string;
}

export interface SearchResult {
  pdfs: PdfRecord[];
  notes: Array<{ pdf: PdfRecord; snippet: string }>;
  tags: Tag[];
}

export interface AppInfo {
  version: string;
  dataDir: string;
  libraryDir: string;
  isPackaged: boolean;
}

export type UpdateStatus = 'disabled' | 'checking' | 'up-to-date' | 'available' | 'error';

export interface UpdateInfo {
  version: string;
  notes: string[];
  url: string;
  publishDate?: string;
}

export interface UpdateResult {
  status: UpdateStatus;
  currentVersion: string;
  latest?: UpdateInfo;
  error?: string;
}

/** preload 暴露给渲染进程的完整 API（window.pkm） */
export interface PkmApi {
  getAppInfo(): Promise<AppInfo>;
  getSnapshot(): Promise<LibrarySnapshot>;

  libraryList(): Promise<LibraryRecord[]>;
  createLibrary(name: string): Promise<LibraryRecord>;
  renameLibrary(id: number, name: string): Promise<void>;
  deleteLibrary(id: number): Promise<void>;
  reorderLibrary(id: number, beforeId: number | null, afterId?: number | null): Promise<void>;

  createFolder(name: string, parentId: number | null): Promise<Folder>;
  renameFolder(id: number, name: string): Promise<void>;
  deleteFolder(id: number): Promise<void>;
  moveFolder(id: number, parentId: number | null): Promise<void>;
  reorderFolder(id: number, beforeId: number | null, afterId?: number | null): Promise<void>;

  inboxList(): Promise<PdfRecord[]>;
  inboxAdd(filePath: string): Promise<PdfRecord>;
  inboxRemove(id: number): Promise<void>;
  inboxClear(): Promise<number>;
  inboxToLibrary(id: number, folderId: number | null): Promise<PdfRecord>;
  isDefaultPdfApp(): Promise<boolean>;
  setPdfAssociation(enable: boolean): Promise<boolean>;
  openDefaultApps(): Promise<void>;
  /** 渲染进程已完成订阅（app:external-pdf），通知主进程可派发系统打开请求 */
  rendererReady(): void;
  onExternalPdf(cb: (filePath: string) => void): () => void;

  importPdfs(
    paths: string[],
    folderId: number | null,
    opts?: { replace?: boolean },
  ): Promise<ImportResult>;
  deletePdf(id: number): Promise<void>;
  movePdf(id: number, folderId: number | null): Promise<void>;
  updatePdfTitle(id: number, title: string): Promise<void>;
  updatePdfPageCount(id: number, pageCount: number): Promise<void>;
  updatePdfHasOutline(id: number, hasOutline: boolean): Promise<void>;
  relocatePdf(id: number): Promise<PdfRecord>;
  readPdf(id: number): Promise<ArrayBuffer>;
  pdfiumAvailable(): Promise<boolean>;
  pdfiumOpen(pdfId: number): Promise<PdfiumOpenResult | null>;
  /** 一次性返回所有页面的物理尺寸（pt，已含旋转），供虚拟滚动精确布局 */
  pdfiumPageSizes(pdfId: number): Promise<{ w: number; h: number }[]>;
  /** 原生提取指定页的链接矩形（首帧即可用，不依赖 pdf.js 解析） */
  pdfiumLinks(pdfId: number, page: number): Promise<PdfiumLink[]>;
  /** 原生提取指定页每个字符的精确字形框（选词/高亮引擎级几何，含空格标点） */
  pdfiumTextChars(pdfId: number, page: number): Promise<PdfiumChar[]>;
  pdfiumRender(pdfId: number, page: number, scale: number): Promise<PdfiumRenderResult>;
  pdfiumRenderBatch(pdfId: number, pages: number[], scale: number): Promise<PdfiumRenderResult[]>;
  pdfiumClose(pdfId: number): Promise<void>;
  pdfiumShutdown(): Promise<void>;
  openPdfExternal(id: number): Promise<void>;
  revealPdf(id: number): Promise<void>;
  /** 在系统资源管理器中定位到该文件夹对应的 Library 目录 */
  revealFolder(id: number): Promise<void>;
  scanLibrary(): Promise<{ added: number }>;
  openLibraryFolder(): Promise<void>;

  addTag(pdfId: number, name: string): Promise<Tag>;
  removeTag(pdfId: number, tagId: number): Promise<void>;
  deleteTag(tagId: number): Promise<void>;

  getNote(pdfId: number): Promise<NoteRecord | null>;
  saveNote(pdfId: number, markdown: string): Promise<NoteRecord>;
  revealNoteFile(pdfId: number): Promise<void>;
  exportNoteToPdf(payload: { html: string; suggestedName: string }): Promise<string | null>;
  saveNoteImage(pdfId: number, dataUrl: string): Promise<string>;

  listAnnotations(pdfId: number): Promise<AnnotationRecord[]>;
  createAnnotation(data: NewAnnotation): Promise<AnnotationRecord>;
  updateAnnotation(
    id: number,
    patch: Partial<Pick<AnnotationRecord, 'note' | 'color' | 'content' | 'page' | 'position'>>,
  ): Promise<void>;
  deleteAnnotation(id: number): Promise<void>;

  search(q: string): Promise<SearchResult>;

  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  checkForUpdates(): Promise<UpdateResult>;
  downloadUpdate(url: string): Promise<{ filePath: string; size: number }>;
  onDownloadProgress(cb: (percent: number) => void): () => void;
  /** silent=true 静默安装并退出应用；false 打开系统安装向导 */
  installUpdate(filePath: string, silent: boolean): Promise<boolean | string>;
  openExternalUrl(url: string): Promise<void>;
  chooseDirectory(title: string): Promise<string | null>;
  openDataFolder(): Promise<void>;
  backupData(): Promise<{ path: string }>;

  openPdfDialog(): Promise<string[]>;
  openFolderDialog(): Promise<string[]>;

  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  setFullScreen(flag: boolean): Promise<void>;
  isFullScreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  onFullScreenChange(cb: (v: boolean) => void): () => void;
  onMaximizedChange(cb: (v: boolean) => void): () => void;
  /** 主进程通知窗口布局需重排（无边框窗口缩放/最大化后） */
  onWindowRelayout(cb: () => void): () => void;
  onLibraryChanged(cb: () => void): () => void;
  onUpdateAvailable(cb: (r: UpdateResult) => void): () => void;

  /** 拖拽文件时获取真实磁盘路径（Electron webUtils） */
  getPathForFile(file: File): string;
}
