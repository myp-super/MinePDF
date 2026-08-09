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

/** 上次阅读会话：用于重启后恢复到关闭前阅读的 PDF 与页码 */
export interface LastSession {
  kind: 'library' | 'inbox';
  pdfId: number;
  page: number;
  ts: number;
}

/** 文档页签：知识库 / 临时区中的一份 PDF */
export interface DocTab {
  id: string;
  kind: 'library' | 'inbox';
  pdfId: number;
  title: string;
}

/** 分屏布局：single=单屏，split-h=左右，split-v=上下 */
export type SplitLayout = 'single' | 'split-h' | 'split-v';

/** 一个阅读窗格（pane）：显示某份 PDF */
export interface Pane {
  id: string;
  kind: 'library' | 'inbox';
  pdfId: number;
}

/** 每个标签的分屏状态 */
export interface TabSplit {
  layout: SplitLayout;
  panes: Pane[];
  activePaneId: string;
}

let tabSeq = 0;
const nextTabId = (): string => `tab_${Date.now()}_${++tabSeq}`;
const nextPaneId = (tabId: string): string => `pane_${tabId}_${++tabSeq}`;

/** 根据书签缓存决定打开 PDF 时信息面板默认页 */
function tabInspectorTab(s: AppState, pdf: PdfRecord | undefined): InspectorTab {
  const cached = s.outlines[pdf?.id ?? -1];
  if (cached !== undefined) return cached.length > 0 ? 'outline' : 'notes';
  return pdf?.hasOutline ? 'outline' : 'notes';
}

function saveSession(kind: 'library' | 'inbox', pdfId: number, page: number): LastSession {
  const sess: LastSession = { kind, pdfId, page, ts: Date.now() };
  try {
    localStorage.setItem('pkm.lastSession', JSON.stringify(sess));
  } catch {
    /* ignore */
  }
  return sess;
}

/** 为某 PDF 创建一个新标签与单屏分页结构 */
function makeTab(s: AppState, id: number): { tab: DocTab; split: TabSplit } | null {
  const pdf = s.pdfs.find((p) => p.id === id) ?? s.inboxPdfs.find((p) => p.id === id);
  if (!pdf) return null;
  const kind: 'library' | 'inbox' = s.inboxPdfs.some((p) => p.id === id) ? 'inbox' : 'library';
  const tab: DocTab = { id: nextTabId(), kind, pdfId: id, title: pdf.title || pdf.filename };
  const paneId = nextPaneId(tab.id);
  return {
    tab,
    split: { layout: 'single', panes: [{ id: paneId, kind, pdfId: id }], activePaneId: paneId },
  };
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
  /** 文档页签列表（3.0.0） */
  tabs: DocTab[];
  activeTabId: string | null;
  /** 每个标签的分屏状态（key = tab.id） */
  splits: Record<string, TabSplit>;
  lastSession: LastSession | null;
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
  openPdfInNewTab: (id: number) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (tabId: string) => void;
  splitTab: (tabId: string, layout: 'split-h' | 'split-v') => void;
  openInSplit: (pdfId: number) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  unsplitTab: (tabId: string) => void;
  restoreLastSession: () => void;
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
  tabs: [],
  activeTabId: null,
  splits: {},
  lastSession: null,
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
      set({ activePdfId: null, activeTabId: null, inspectorTab: 'meta' });
      return;
    }
    const s = get();
    const pdf = s.pdfs.find((p) => p.id === id) ?? s.inboxPdfs.find((p) => p.id === id);
    if (!pdf) return;
    const kind: 'library' | 'inbox' = s.inboxPdfs.some((p) => p.id === id) ? 'inbox' : 'library';
    // 重要逻辑 1：同一文件已打开则直接激活对应标签，不新开
    const existing = s.tabs.find((t) => t.pdfId === id);
    if (existing) {
      set({
        activeTabId: existing.id,
        activePdfId: id,
        lastSession: saveSession(kind, id, 1),
        inspectorTab: tabInspectorTab(s, pdf),
      });
      return;
    }
    const made = makeTab(s, id);
    if (!made) return;
    set({
      tabs: [...s.tabs, made.tab],
      activeTabId: made.tab.id,
      activePdfId: id,
      splits: { ...s.splits, [made.tab.id]: made.split },
      lastSession: saveSession(kind, id, 1),
      inspectorTab: tabInspectorTab(s, pdf),
    });
  },
  /** 重要逻辑 2：总是新开一个标签并激活 */
  openPdfInNewTab: (id) => {
    const s = get();
    const made = makeTab(s, id);
    if (!made) return;
    set({
      tabs: [...s.tabs, made.tab],
      activeTabId: made.tab.id,
      activePdfId: id,
      splits: { ...s.splits, [made.tab.id]: made.split },
      lastSession: saveSession(made.tab.kind, id, 1),
      inspectorTab: tabInspectorTab(s, s.pdfs.find((p) => p.id === id) ?? s.inboxPdfs.find((p) => p.id === id)),
    });
  },
  activateTab: (tabId) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const split = s.splits[tabId];
    const activePane =
      split?.panes.find((p) => p.id === split.activePaneId) ?? split?.panes[0] ?? null;
    set({
      activeTabId: tabId,
      activePdfId: activePane?.pdfId ?? tab.pdfId,
      lastSession: saveSession(tab.kind, activePane?.pdfId ?? tab.pdfId, 1),
    });
  },
  closeTab: (tabId) => {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const tabs = s.tabs.filter((t) => t.id !== tabId);
    const splits = { ...s.splits };
    delete splits[tabId];
    let activeTabId = s.activeTabId;
    let activePdfId = s.activePdfId;
    if (s.activeTabId === tabId) {
      const next = tabs[Math.min(idx, tabs.length - 1)] ?? null;
      activeTabId = next?.id ?? null;
      if (next) {
        const split = splits[next.id];
        const pane = split?.panes.find((p) => p.id === split.activePaneId) ?? split?.panes[0];
        activePdfId = pane?.pdfId ?? next.pdfId;
      } else {
        activePdfId = null;
      }
    }
    set({ tabs, splits, activeTabId, activePdfId });
  },
  closeAllTabs: () => {
    set({ tabs: [], splits: {}, activeTabId: null, activePdfId: null, inspectorTab: 'meta' });
  },
  closeOtherTabs: (tabId) => {
    const s = get();
    const keep = s.tabs.filter((t) => t.id === tabId);
    const splits: Record<string, TabSplit> = {};
    if (keep[0]) splits[tabId] = s.splits[tabId];
    set({ tabs: keep, splits, activeTabId: tabId });
  },
  /** 上下 / 左右分屏：保留现有窗格，不足两个时复制当前窗格（同一 PDF 双屏） */
  splitTab: (tabId, layout) => {
    const s = get();
    const split = s.splits[tabId];
    if (!split) return;
    let panes = split.panes;
    if (panes.length < 2) {
      panes = [panes[0], { ...panes[0], id: nextPaneId(tabId) }];
    }
    set({ splits: { ...s.splits, [tabId]: { layout, panes, activePaneId: split.activePaneId } } });
  },
  /** 重要逻辑（新分屏打开）：在当前标签开左右分屏，新窗格显示指定 PDF */
  openInSplit: (pdfId) => {
    const s = get();
    const tabId = s.activeTabId;
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab || tabId == null) return;
    const split = s.splits[tabId];
    const kind: 'library' | 'inbox' = s.inboxPdfs.some((p) => p.id === pdfId) ? 'inbox' : 'library';
    const newPane: Pane = { id: nextPaneId(tabId), kind, pdfId };
    let panes: Pane[];
    let layout: SplitLayout;
    if (split.layout === 'single' || split.panes.length < 2) {
      // 未分屏：左右分屏，原窗格保留当前内容，新窗格显示新文件
      const cur = split.panes.find((p) => p.id === split.activePaneId) ?? split.panes[0];
      panes = [cur, newPane];
      layout = 'split-h';
    } else {
      // 已分屏：用新文件替换非激活窗格
      panes = split.panes.map((p) => (p.id === split.activePaneId ? p : newPane));
      layout = split.layout;
    }
    set({
      splits: { ...s.splits, [tabId]: { layout, panes, activePaneId: newPane.id } },
      activePdfId: pdfId,
      lastSession: saveSession(kind, pdfId, 1),
    });
  },
  setActivePane: (tabId, paneId) => {
    const s = get();
    const split = s.splits[tabId];
    if (!split) return;
    const pane = split.panes.find((p) => p.id === paneId);
    if (!pane) return;
    set({
      splits: { ...s.splits, [tabId]: { ...split, activePaneId: paneId } },
      activePdfId: pane.pdfId,
      lastSession: saveSession(pane.kind, pane.pdfId, 1),
    });
  },
  unsplitTab: (tabId) => {
    const s = get();
    const split = s.splits[tabId];
    if (!split) return;
    const active = split.panes.find((p) => p.id === split.activePaneId) ?? split.panes[0];
    set({
      splits: {
        ...s.splits,
        [tabId]: { layout: 'single', panes: [active], activePaneId: active.id },
      },
      activePdfId: active.pdfId,
    });
  },
  /**
   * 启动恢复：读取上次会话，若对应 PDF 仍存在则自动打开并跳转到记录页码。
   * PDF 已被删除时清除记录。
   */
  restoreLastSession: () => {
    const s = get();
    let raw: string | null = null;
    try {
      raw = localStorage.getItem('pkm.lastSession');
    } catch {
      return;
    }
    if (!raw) return;
    let sess: LastSession;
    try {
      sess = JSON.parse(raw) as LastSession;
    } catch {
      return;
    }
    if (!sess || typeof sess.pdfId !== 'number') return;
    const pdf = s.pdfs.find((p) => p.id === sess.pdfId) ?? s.inboxPdfs.find((p) => p.id === sess.pdfId);
    if (!pdf) {
      try {
        localStorage.removeItem('pkm.lastSession');
      } catch {
        /* ignore */
      }
      return;
    }
    s.openPdf(sess.pdfId);
    // openPdf 会把记录重置为第 1 页，这里恢复为上次阅读页码，保证记忆准确
    const restored: LastSession = { ...sess, ts: Date.now() };
    try {
      localStorage.setItem('pkm.lastSession', JSON.stringify(restored));
    } catch {
      /* ignore */
    }
    set({ lastSession: restored });
    if (sess.page > 1) s.requestJump(sess.page);
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
  setCurrentPage: (page) => {
    const s = get();
    // 同步更新上次会话页码（翻页/滚动到新页时记忆阅读位置）
    if (s.lastSession) {
      const sess = { ...s.lastSession, page, ts: Date.now() };
      try {
        localStorage.setItem('pkm.lastSession', JSON.stringify(sess));
      } catch {
        /* ignore */
      }
      set({ currentPage: page, lastSession: sess });
    } else {
      set({ currentPage: page });
    }
  },
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
