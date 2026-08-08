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
  /** 当前 PDF 的内置书签（目录），供信息面板显示 */
  outline: OutlineNode[];
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
  setSearchOpen: (v: boolean) => void;
  setOutline: (nodes: OutlineNode[]) => void;
  requestJump: (page: number) => void;
  consumeJump: () => void;
  setCurrentPage: (page: number) => void;
  setSidebarWidth: (w: number) => void;
  setInspectorWidth: (w: number) => void;
  toggleSidebarCollapsed: () => void;
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
  outline: [],
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
  openPdf: (id) => set({ activePdfId: id, inspectorTab: 'meta' }),
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
  setSearchOpen: (v) => set({ searchOpen: v }),
  setOutline: (nodes) => set({ outline: nodes }),
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
  toast: (kind, text) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 4600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
