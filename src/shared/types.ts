/**
 * 主进程与渲染进程共享的数据类型。
 * 数据库行以下划线命名，对外统一映射为驼峰结构。
 */

/** 文件夹节点（虚拟文件库，不对应真实文件系统目录） */
export interface Folder {
  id: number;
  name: string;
  parentId: number | null;
  /** 相对 Library 根目录的路径（如 深度学习/Transformer） */
  path: string;
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
  /** 知识库根目录（Documents/PDFKnowledgeManager） */
  libraryPath: string;
  /** PDF 库文件夹：所有 PDF 的统一存放目录（Obsidian 式） */
  libraryPdfDir: string;
}

export interface LibrarySnapshot {
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

  createFolder(name: string, parentId: number | null): Promise<Folder>;
  renameFolder(id: number, name: string): Promise<void>;
  deleteFolder(id: number): Promise<void>;
  moveFolder(id: number, parentId: number | null): Promise<void>;

  importPdfs(
    paths: string[],
    folderId: number | null,
    opts?: { replace?: boolean },
  ): Promise<ImportResult>;
  deletePdf(id: number): Promise<void>;
  movePdf(id: number, folderId: number | null): Promise<void>;
  updatePdfTitle(id: number, title: string): Promise<void>;
  updatePdfPageCount(id: number, pageCount: number): Promise<void>;
  relocatePdf(id: number): Promise<PdfRecord>;
  readPdf(id: number): Promise<ArrayBuffer>;
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
  onLibraryChanged(cb: () => void): () => void;
  onUpdateAvailable(cb: (r: UpdateResult) => void): () => void;

  /** 拖拽文件时获取真实磁盘路径（Electron webUtils） */
  getPathForFile(file: File): string;
}
