import { create } from 'zustand';
import type { AppSettings, Folder, PdfRecord, Tag } from './shared/types';
import type { OutlineNode } from './lib/pdf';

export type ViewMode = 'library' | 'settings';
export type InspectorTab = 'meta' | 'outline' | 'notes' | 'annotations';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'zh-CN',
  autoSave: true,
  defaultImportDir: '',
  updateUrl: 'https://myp-super.github.io/MinePDF/update.json',
  updateAutoCheck: true,
  pdfDefaultApp: false,
  libraryPath: '',
  libraryPdfDir: '',
};

interface AppState {
  ready: boolean;
  folders: Folder[];
  pdfs: PdfRecord[];
  inboxPdfs: PdfRecord[];
  tags: Tag[];
  settings: AppSettings;
  activePdfId: number | null;
  selectedFolderId: number | null;
  /** 侧边栏多选（Ctrl+点击）的 PDF 集合 */
  selectedPdfIds: number[];
  tagFilterId: number | null;
  view: ViewMode;
  inspectorTab: InspectorTab;
  inspectorCollapsed: boolean;
  searchOpen: boolean;
  /** 截图模式（由笔记工具栏触发，阅读器显示选区工具） */
  screenshotMode: boolean;
  /** 笔记内容版本号：截图等外部写入后 +1，笔记面板据此刷新 */
  noteRevision: number;
  /** 当前 PDF 的内置书签（目录），供信息面板显示 */
  outline: OutlineNode[];
  /** 每个 PDF 已解析过的书签缓存（pdfId -> 目录树），用于打开时直接决定默认面板 */
  outlines: Record<number, OutlineNode[]>;
  /** 信息面板请求跳转的页码（由阅读器消费） */
  jumpPage: number | null;
  /** 当前阅读器所在页码（用于书签高亮） */
  currentPage: number;
  sidebarWidth: number;
  inspectorWidth: number;
  sidebarCollapsed: boolean;
  toasts: Toast[];

  setReady: (v: boolean) => void;
  refresh: () => Promise<void>;
  openPdf: (id: number | null) => void;
  setSelectedFolder: (id: number | null) => void;
  setInboxPdfs: (items: PdfRecord[]) => void;
  setSelectedPdfIds: (ids: number[]) => void;
  toggleSelectedPdf: (id: number) => void;
  clearSelectedPdfs: () => void;
  setTagFilter: (id: number | null) => void;
  setView: (v: ViewMode) => void;
  setInspectorTab: (t: InspectorTab) => void;
  toggleInspectorCollapsed: () => void;
  setInspectorCollapsed: (v: boolean) => void;
  setSearchOpen: (v: boolean) => void;
  setScreenshotMode: (v: boolean) => void;
  bumpNoteRevision: () => void;
  setOutline: (nodes: OutlineNode[]) => void;
  setOutlineFor: (pdfId: number, nodes: OutlineNode[]) => void;
  requestJump: (page: number) => void;
  consumeJump: () => void;
  setCurrentPage: (page: number) => void;
  setSidebarWidth: (w: number) => void;
  setInspectorWidth: (w: number) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  toast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  folders: [],
  pdfs: [],
  inboxPdfs: [],
  tags: [],
  settings: DEFAULT_SETTINGS,
  activePdfId: null,
  selectedFolderId: null,
  selectedPdfIds: [],
  tagFilterId: null,
  view: 'library',
  inspectorTab: 'meta',
  inspectorCollapsed: false,
  searchOpen: false,
  screenshotMode: false,
  noteRevision: 0,
  outline: [],
  outlines: {},
  jumpPage: null,
  currentPage: 1,
  sidebarWidth: Number(localStorage.getItem('pkm.sidebarWidth')) || 268,
  inspectorWidth: Number(localStorage.getItem('pkm.inspectorWidth')) || 320,
  sidebarCollapsed: false,
  toasts: [],

  setReady: (v) => set({ ready: v }),
  refresh: async () => {
    try {
      const [snap, inbox] = await Promise.all([window.pkm.getSnapshot(), window.pkm.inboxList()]);
      set({
        folders: snap.folders,
        pdfs: snap.pdfs,
        inboxPdfs: inbox,
        tags: snap.tags,
        settings: snap.settings,
      });
      const active = get().activePdfId;
      if (active != null && !snap.pdfs.some((p) => p.id === active) && !inbox.some((p) => p.id === active)) {
        set({ activePdfId: null });
      }
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err));
    }
  },
  openPdf: (id) => {
    if (id == null) {
      set({ activePdfId: null, inspectorTab: 'meta' });
      return;
    }
    const s = get();
    const pdf = s.pdfs.find((p) => p.id === id) ?? s.inboxPdfs.find((p) => p.id === id);
    // 有书签默认书签页，无书签默认笔记页（避免先闪“信息”再跳转）
    const cached = s.outlines[id];
    const tab: InspectorTab =
      cached !== undefined
        ? cached.length > 0
          ? 'outline'
          : 'notes'
        : pdf?.hasOutline
          ? 'outline'
          : 'notes';
    set({ activePdfId: id, inspectorTab: tab });
  },
  setSelectedFolder: (id) => set({ selectedFolderId: id, tagFilterId: null }),
  setInboxPdfs: (items) => set({ inboxPdfs: items }),
  setSelectedPdfIds: (ids) => set({ selectedPdfIds: ids }),
  toggleSelectedPdf: (id) =>
    set((s) => ({
      selectedPdfIds: s.selectedPdfIds.includes(id)
        ? s.selectedPdfIds.filter((x) => x !== id)
        : [...s.selectedPdfIds, id],
    })),
  clearSelectedPdfs: () => set({ selectedPdfIds: [] }),
  setTagFilter: (id) => set({ tagFilterId: id }),
  setView: (v) => set({ view: v }),
  setInspectorTab: (t) => set({ inspectorTab: t }),
  toggleInspectorCollapsed: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
  setInspectorCollapsed: (v) => set({ inspectorCollapsed: v }),
  setSearchOpen: (v) => set({ searchOpen: v }),
  setScreenshotMode: (v) => set({ screenshotMode: v }),
  bumpNoteRevision: () => set((s) => ({ noteRevision: s.noteRevision + 1 })),
  setOutline: (nodes) => set({ outline: nodes }),
  setOutlineFor: (pdfId, nodes) =>
    set((s) => ({ outlines: { ...s.outlines, [pdfId]: nodes } })),
  requestJump: (page) => set({ jumpPage: page }),
  consumeJump: () => set({ jumpPage: null }),
  setCurrentPage: (page) => set({ currentPage: page }),
  setSidebarWidth: (w) => {
    const v = Math.min(420, Math.max(180, Math.round(w)));
    localStorage.setItem('pkm.sidebarWidth', String(v));
    set({ sidebarWidth: v });
  },
  setInspectorWidth: (w) => {
    const v = Math.min(520, Math.max(220, Math.round(w)));
    localStorage.setItem('pkm.inspectorWidth', String(v));
    set({ inspectorWidth: v });
  },
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toast: (kind, text) => {
    // 成功/信息类操作提示不再弹出（直接操作即可）；仅保留错误提示
    if (kind !== 'error') return;
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 4600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
