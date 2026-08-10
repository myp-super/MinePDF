import { create } from 'zustand';
import type { AppSettings, Folder, LibraryRecord, PdfRecord, Tag } from './shared/types';
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

/** 完整会话快照：恢复全部打开的标签页与分屏布局（3.2.1） */
interface RestoredSession {
  screens: Array<{
    tabs: Array<{ kind: 'library' | 'inbox'; pdfId: number }>;
    activeTabIndex: number;
  }>;
  activeScreenIndex: number;
  splitLayout: SplitLayout;
  splitRatio: number;
  /** 当前激活标签的阅读页码 */
  page: number;
}

const SESSION_KEY = 'pkm.screensSession';

/** 文档标签：知识库 / 临时区中的一份 PDF */
export interface DocTab {
  id: string;
  kind: 'library' | 'inbox';
  pdfId: number;
  title: string;
}

/** 一个阅读屏（编辑器分组）：有自己的标签栏，可独立打开/切换/关闭标签 */
export interface ReaderScreen {
  id: string;
  tabs: DocTab[];
  activeTabId: string | null;
}

/** 中间栏分屏布局：single=单屏，split-h=左右，split-v=上下 */
export type SplitLayout = 'single' | 'split-h' | 'split-v';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'zh-CN',
  autoSave: true,
  defaultImportDir: '',
  updateUrl: 'https://myp-super.github.io/MinePDF/update.json',
  updateAutoCheck: true,
  pdfDefaultApp: false,
  autoCollapseSidebar: false,
  libraryPath: '',
  libraryPdfDir: '',
};

let idSeq = 0;
const nextTabId = (): string => `tab_${Date.now()}_${++idSeq}`;
const nextScreenId = (): string => `scr_${Date.now()}_${++idSeq}`;

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

/** 为某 PDF 创建一个标签（不含屏） */
function makeTab(s: AppState, id: number): DocTab | null {
  const pdf = s.pdfs.find((p) => p.id === id) ?? s.inboxPdfs.find((p) => p.id === id);
  if (!pdf) return null;
  const kind: 'library' | 'inbox' = s.inboxPdfs.some((p) => p.id === id) ? 'inbox' : 'library';
  return { id: nextTabId(), kind, pdfId: id, title: pdf.title || pdf.filename };
}

/** 由屏状态推导当前激活 PDF id */
function derivePdfId(screens: ReaderScreen[], activeScreenId: string | null): number | null {
  const screen = screens.find((sc) => sc.id === activeScreenId) ?? screens[0] ?? null;
  if (!screen) return null;
  const tab = screen.tabs.find((t) => t.id === screen.activeTabId) ?? screen.tabs[0] ?? null;
  return tab?.pdfId ?? null;
}

/** 在指定屏打开标签（若已有同 pdf 则激活），返回更新后的屏 */
function openTabInScreen(screen: ReaderScreen, tab: DocTab): ReaderScreen {
  const existing = screen.tabs.find((t) => t.pdfId === tab.pdfId);
  if (existing) return { ...screen, activeTabId: existing.id };
  return { ...screen, tabs: [...screen.tabs, tab], activeTabId: tab.id };
}

/** 「阅读时自动折叠知识库」：打开 PDF 时收起侧栏 */
function sidebarPatchOnOpen(s: AppState): Partial<AppState> {
  return s.settings.autoCollapseSidebar ? { sidebarCollapsed: true } : {};
}

/** 「阅读时自动折叠知识库」：关闭全部 PDF 后恢复侧栏 */
function sidebarPatchOnClose(s: AppState): Partial<AppState> {
  return s.settings.autoCollapseSidebar ? { sidebarCollapsed: false } : {};
}

interface AppState {
  ready: boolean;
  libraries: LibraryRecord[];
  folders: Folder[];
  pdfs: PdfRecord[];
  inboxPdfs: PdfRecord[];
  tags: Tag[];
  settings: AppSettings;
  activePdfId: number | null;
  /** 阅读屏列表（每个屏有独立标签栏） */
  screens: ReaderScreen[];
  activeScreenId: string | null;
  splitLayout: SplitLayout;
  /** 分屏时主屏占比（0.2~0.8），分隔线拖拽调整 */
  splitRatio: number;
  lastSession: LastSession | null;
  selectedFolderId: number | null;
  selectedPdfIds: number[];
  tagFilterId: number | null;
  view: ViewMode;
  inspectorTab: InspectorTab;
  inspectorCollapsed: boolean;
  searchOpen: boolean;
  screenshotMode: boolean;
  noteRevision: number;
  outline: OutlineNode[];
  outlines: Record<number, OutlineNode[]>;
  jumpPage: number | null;
  currentPage: number;
  sidebarWidth: number;
  inspectorWidth: number;
  sidebarCollapsed: boolean;
  toasts: Toast[];

  setReady: (v: boolean) => void;
  refresh: () => Promise<void>;
  openPdf: (id: number | null) => void;
  openPdfInNewTab: (id: number) => void;
  openInSplit: (pdfId: number) => void;
  activateScreen: (screenId: string) => void;
  activateTab: (screenId: string, tabId: string) => void;
  closeTab: (screenId: string, tabId: string) => void;
  closeAllTabs: (screenId: string) => void;
  closeOtherTabs: (screenId: string, tabId: string) => void;
  clearScreens: () => void;
  splitScreen: (layout: 'split-h' | 'split-v') => void;
  unsplitScreen: () => void;
  setSplitRatio: (r: number) => void;
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
  /** 记录某份 PDF 的阅读页码（标签切换/卸载时保留） */
  rememberTabPage: (pdfId: number, page: number) => void;
  /** 每份 PDF 上次阅读页码（按 pdfId 记忆，切标签/重开时恢复） */
  tabPages: Record<number, number>;
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
  libraries: [],
  folders: [],
  pdfs: [],
  inboxPdfs: [],
  tags: [],
  settings: DEFAULT_SETTINGS,
  activePdfId: null,
  screens: [],
  activeScreenId: null,
  splitLayout: 'single',
  splitRatio: 0.5,
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
  tabPages: {},
  sidebarWidth: Number(localStorage.getItem('pkm.sidebarWidth')) || 268,
  inspectorWidth: Number(localStorage.getItem('pkm.inspectorWidth')) || 320,
  sidebarCollapsed: false,
  toasts: [],

  setReady: (v) => set({ ready: v }),
  refresh: async () => {
    try {
      const [snap, inbox] = await Promise.all([window.pkm.getSnapshot(), window.pkm.inboxList()]);
      set({
        libraries: snap.libraries,
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
  /** 打开 PDF：始终在当前选中屏打开——屏内已打开则激活对应标签，否则新建标签；
   *  不跳转到其它屏，保证每个屏都能独立打开任意 PDF。 */
  openPdf: (id) => {
    if (id == null) {
      set({ activePdfId: null, inspectorTab: 'meta' });
      return;
    }
    const s = get();
    const pdf = s.pdfs.find((p) => p.id === id) ?? s.inboxPdfs.find((p) => p.id === id);
    if (!pdf) return;
    const kind: 'library' | 'inbox' = s.inboxPdfs.some((p) => p.id === id) ? 'inbox' : 'library';
    // 当前选中屏新建标签；无屏则创建首个屏
    const screen = s.screens.find((sc) => sc.id === s.activeScreenId) ?? s.screens[0];
    if (!screen) {
      const tab = makeTab(s, id);
      if (!tab) return;
      const newScreen: ReaderScreen = { id: nextScreenId(), tabs: [tab], activeTabId: tab.id };
      set({
        screens: [newScreen],
        activeScreenId: newScreen.id,
        activePdfId: id,
        splitLayout: 'single',
        splitRatio: 0.5,
        lastSession: saveSession(kind, id, s.tabPages[id] ?? 1),
        inspectorTab: tabInspectorTab(s, pdf),
        ...sidebarPatchOnOpen(s),
      });
      return;
    }
    const tab = makeTab(s, id);
    if (!tab) return;
    const screens = s.screens.map((sc) => (sc.id === screen.id ? openTabInScreen(sc, tab) : sc));
    set({
      screens,
      activeScreenId: screen.id,
      activePdfId: id,
      lastSession: saveSession(kind, id, s.tabPages[id] ?? 1),
      inspectorTab: tabInspectorTab(s, pdf),
      ...sidebarPatchOnOpen(s),
    });
  },
  /** 右键“在新标签页中打开”：在当前选中屏总是新建标签 */
  openPdfInNewTab: (id) => {
    const s = get();
    const tab = makeTab(s, id);
    if (!tab) return;
    const screen = s.screens.find((sc) => sc.id === s.activeScreenId) ?? s.screens[0];
    if (!screen) {
      const newScreen: ReaderScreen = { id: nextScreenId(), tabs: [tab], activeTabId: tab.id };
      set({
        screens: [newScreen],
        activeScreenId: newScreen.id,
        activePdfId: id,
        splitLayout: 'single',
        splitRatio: 0.5,
        lastSession: saveSession(tab.kind, id, s.tabPages[id] ?? 1),
        ...sidebarPatchOnOpen(s),
      });
      return;
    }
    const screens = s.screens.map((sc) =>
      sc.id === screen.id ? { ...sc, tabs: [...sc.tabs, tab], activeTabId: tab.id } : sc,
    );
    set({
      screens,
      activeScreenId: screen.id,
      activePdfId: id,
      lastSession: saveSession(tab.kind, id, s.tabPages[id] ?? 1),
      inspectorTab: tabInspectorTab(s, s.pdfs.find((p) => p.id === id) ?? s.inboxPdfs.find((p) => p.id === id)),
      ...sidebarPatchOnOpen(s),
    });
  },
  /** 右键“在新的分屏打开”：未分屏则开左右分屏并显示该文件；已分屏则在另一屏打开 */
  openInSplit: (pdfId) => {
    const s = get();
    const tab = makeTab(s, pdfId);
    if (!tab) return;
    if (s.splitLayout === 'single' || s.screens.length < 2) {
      const primary = s.screens.find((sc) => sc.id === s.activeScreenId) ?? s.screens[0];
      if (!primary) {
        openPdfInNewTabInner(set, get, tab);
        return;
      }
      const newScreen: ReaderScreen = { id: nextScreenId(), tabs: [tab], activeTabId: tab.id };
      set({
        screens: [...s.screens, newScreen],
        activeScreenId: newScreen.id,
        activePdfId: pdfId,
        splitLayout: 'split-h',
        splitRatio: 0.5,
        lastSession: saveSession(tab.kind, pdfId, s.tabPages[pdfId] ?? 1),
        ...sidebarPatchOnOpen(s),
      });
      return;
    }
    // 已在分屏：在非选中屏打开（已有则激活）
    const other = s.screens.find((sc) => sc.id !== s.activeScreenId) ?? s.screens[0];
    const screens = s.screens.map((sc) => (sc.id === other.id ? openTabInScreen(sc, tab) : sc));
    set({
      screens,
      activeScreenId: other.id,
      activePdfId: pdfId,
      lastSession: saveSession(tab.kind, pdfId, s.tabPages[pdfId] ?? 1),
      ...sidebarPatchOnOpen(s),
    });
  },
  activateScreen: (screenId) => {
    const s = get();
    const screen = s.screens.find((sc) => sc.id === screenId);
    if (!screen) return;
    const pdfId = derivePdfId(s.screens, screenId);
    if (pdfId == null) return;
    const tab = screen.tabs.find((t) => t.id === screen.activeTabId) ?? screen.tabs[0];
    set({
      activeScreenId: screenId,
      activePdfId: pdfId,
      // 记录当前阅读页码，关闭后重启可恢复到该页
      lastSession: saveSession(tab?.kind ?? 'library', pdfId, s.tabPages[pdfId] ?? s.currentPage),
    });
  },
  activateTab: (screenId, tabId) => {
    const s = get();
    const screens = s.screens.map((sc) =>
      sc.id === screenId ? { ...sc, activeTabId: tabId } : sc,
    );
    const tab = screens
      .find((sc) => sc.id === screenId)
      ?.tabs.find((t) => t.id === tabId);
    set({
      screens,
      activeScreenId: screenId,
      activePdfId: tab?.pdfId ?? null,
      lastSession: tab ? saveSession(tab.kind, tab.pdfId, s.tabPages[tab.pdfId] ?? 1) : undefined,
      inspectorTab:
        tab?.pdfId != null
          ? tabInspectorTab(s, s.pdfs.find((p) => p.id === tab.pdfId) ?? s.inboxPdfs.find((p) => p.id === tab.pdfId))
          : undefined,
    });
  },
  /** 关闭屏内标签；该屏标签清空后屏自动消失（分屏只剩一个屏时回到单屏） */
  closeTab: (screenId, tabId) => {
    const s = get();
    let screens = s.screens.map((sc) => {
      if (sc.id !== screenId) return sc;
      const idx = sc.tabs.findIndex((t) => t.id === tabId);
      const tabs = sc.tabs.filter((t) => t.id !== tabId);
      let activeTabId = sc.activeTabId;
      if (sc.activeTabId === tabId) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      return { ...sc, tabs, activeTabId };
    });
    screens = screens.filter((sc) => sc.tabs.length > 0);
    let activeScreenId = screens.some((sc) => sc.id === s.activeScreenId)
      ? s.activeScreenId
      : (screens[0]?.id ?? null);
    const splitLayout: SplitLayout = screens.length <= 1 ? 'single' : s.splitLayout;
    const activePdfId = derivePdfId(screens, activeScreenId);
    set({
      screens,
      activeScreenId,
      splitLayout,
      activePdfId,
      ...(activePdfId == null ? sidebarPatchOnClose(s) : {}),
    });
  },
  closeAllTabs: (screenId) => {
    const s = get();
    const screens = s.screens.filter((sc) => sc.id !== screenId);
    let activeScreenId = screens.some((sc) => sc.id === s.activeScreenId)
      ? s.activeScreenId
      : (screens[0]?.id ?? null);
    const splitLayout: SplitLayout = screens.length <= 1 ? 'single' : s.splitLayout;
    const activePdfId = derivePdfId(screens, activeScreenId);
    set({
      screens,
      activeScreenId,
      splitLayout,
      activePdfId,
      ...(activePdfId == null ? sidebarPatchOnClose(s) : {}),
    });
  },
  closeOtherTabs: (screenId, tabId) => {
    const s = get();
    const screens = s.screens.map((sc) =>
      sc.id === screenId
        ? { ...sc, tabs: sc.tabs.filter((t) => t.id === tabId), activeTabId: tabId }
        : sc,
    );
    const activePdfId = derivePdfId(screens, s.activeScreenId);
    set({ screens, activePdfId });
  },
  clearScreens: () => {
    const s = get();
    set({
      screens: [],
      activeScreenId: null,
      splitLayout: 'single',
      splitRatio: 0.5,
      activePdfId: null,
      ...sidebarPatchOnClose(s),
    });
  },
  /** 上下 / 左右分屏：未分屏时创建第二个屏并显示当前屏激活的 PDF */
  splitScreen: (layout) => {
    const s = get();
    if (s.screens.length < 2) {
      const primary = s.screens.find((sc) => sc.id === s.activeScreenId) ?? s.screens[0];
      if (!primary) return;
      const curTab = primary.tabs.find((t) => t.id === primary.activeTabId) ?? primary.tabs[0];
      if (!curTab) return;
      const tab: DocTab = { ...curTab, id: nextTabId() };
      const newScreen: ReaderScreen = { id: nextScreenId(), tabs: [tab], activeTabId: tab.id };
      set({
        screens: [...s.screens, newScreen],
        splitLayout: layout,
        splitRatio: 0.5,
      });
      return;
    }
    set({ splitLayout: layout });
  },
  /** 取消分屏：两个屏的标签合并到当前屏 */
  unsplitScreen: () => {
    const s = get();
    const primary = s.screens.find((sc) => sc.id === s.activeScreenId) ?? s.screens[0];
    const other = s.screens.find((sc) => sc.id !== primary.id);
    if (!other) {
      set({ splitLayout: 'single' });
      return;
    }
    const mergedTabs = other.tabs.filter((ot) => !primary.tabs.some((pt) => pt.pdfId === ot.pdfId));
    const tabs = [...primary.tabs, ...mergedTabs];
    let activeTabId = primary.activeTabId;
    if (!tabs.some((t) => t.id === activeTabId)) activeTabId = tabs[0]?.id ?? null;
    const activePdfId = tabs.find((t) => t.id === activeTabId)?.pdfId ?? null;
    set({
      screens: [{ ...primary, tabs, activeTabId }],
      activeScreenId: primary.id,
      splitLayout: 'single',
      splitRatio: 0.5,
      activePdfId,
    });
  },
  setSplitRatio: (r) => set({ splitRatio: Math.min(0.8, Math.max(0.2, r)) }),
  /**
   * 启动恢复：优先恢复完整会话快照（全部标签页 + 分屏布局 + 当前页码）；
   * 旧版本只有单条 lastSession 时回退为只恢复最后一个 PDF。
   */
  restoreLastSession: () => {
    const s = get();
    // 1) 完整会话快照：重建所有屏与标签
    let rawSnap: string | null = null;
    try {
      rawSnap = localStorage.getItem(SESSION_KEY);
    } catch {
      rawSnap = null;
    }
    if (rawSnap) {
      try {
        const snap = JSON.parse(rawSnap) as RestoredSession;
        const screens: ReaderScreen[] = [];
        let activeScreenId: string | null = null;
        (snap.screens ?? []).forEach((sc, idx) => {
          const tabs: DocTab[] = [];
          for (const t of sc.tabs ?? []) {
            const pdf =
              t.kind === 'inbox'
                ? s.inboxPdfs.find((p) => p.id === t.pdfId)
                : s.pdfs.find((p) => p.id === t.pdfId);
            if (!pdf) continue;
            tabs.push({ id: nextTabId(), kind: t.kind, pdfId: t.pdfId, title: pdf.title || pdf.filename });
          }
          if (!tabs.length) return;
          const activeTabId =
            tabs[Math.min(sc.activeTabIndex ?? 0, tabs.length - 1)]?.id ?? tabs[0].id;
          const sid = nextScreenId();
          if (idx === (snap.activeScreenIndex ?? 0)) activeScreenId = sid;
          screens.push({ id: sid, tabs, activeTabId });
        });
        if (screens.length > 0) {
          const activeScreen = screens.find((sc) => sc.id === activeScreenId) ?? screens[0];
          const activeTab =
            activeScreen.tabs.find((t) => t.id === activeScreen.activeTabId) ?? activeScreen.tabs[0];
          const page = Math.max(1, Math.floor(snap.page ?? 1));
          const splitLayout: SplitLayout = screens.length <= 1 ? 'single' : snap.splitLayout;
          set({
            screens,
            activeScreenId: activeScreen.id,
            activePdfId: activeTab.pdfId,
            splitLayout,
            splitRatio: snap.splitRatio ?? 0.5,
            lastSession: saveSession(activeTab.kind, activeTab.pdfId, page),
            ...sidebarPatchOnOpen(s),
          });
          if (page > 1) s.requestJump(page);
          return;
        }
      } catch {
        /* 快照损坏则回退旧逻辑 */
      }
    }

    // 2) 旧格式：单条 lastSession
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
  setSelectedFolder: (id) => set({ selectedFolderId: id }),
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
    const pdfId = s.activePdfId ?? -1;
    const tabPages = { ...s.tabPages, [pdfId]: page };
    if (s.lastSession) {
      const sess = { ...s.lastSession, page, ts: Date.now() };
      try {
        localStorage.setItem('pkm.lastSession', JSON.stringify(sess));
      } catch {
        /* ignore */
      }
      set({ currentPage: page, lastSession: sess, tabPages });
    } else {
      set({ currentPage: page, tabPages });
    }
  },
  rememberTabPage: (pdfId, page) =>
    set((s) => ({ tabPages: { ...s.tabPages, [pdfId]: Math.max(1, page) } })),
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
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 3200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 供 openInSplit 在无屏时兜底：直接创建首个屏 */
function openPdfInNewTabInner(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  tab: DocTab,
): void {
  const screen: ReaderScreen = { id: nextScreenId(), tabs: [tab], activeTabId: tab.id };
  set({
    screens: [screen],
    activeScreenId: screen.id,
    activePdfId: tab.pdfId,
    splitLayout: 'single',
    splitRatio: 0.5,
    lastSession: saveSession(tab.kind, tab.pdfId, get().tabPages[tab.pdfId] ?? 1),
  });
}

// ---------- 会话快照持久化 ----------
// 标签/分屏/阅读页码发生变化时写入 localStorage，重启后完整恢复。
useApp.subscribe((s, prev) => {
  if (
    s.screens === prev.screens &&
    s.lastSession === prev.lastSession &&
    s.splitLayout === prev.splitLayout &&
    s.splitRatio === prev.splitRatio
  ) {
    return;
  }
  try {
    const activeScreenIndex = Math.max(
      0,
      s.screens.findIndex((sc) => sc.id === s.activeScreenId),
    );
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        screens: s.screens.map((sc) => ({
          tabs: sc.tabs.map((t) => ({ kind: t.kind, pdfId: t.pdfId })),
          activeTabIndex: Math.max(0, sc.tabs.findIndex((t) => t.id === sc.activeTabId)),
        })),
        activeScreenIndex,
        splitLayout: s.splitLayout,
        splitRatio: s.splitRatio,
        page: s.lastSession?.page ?? 1,
      } satisfies RestoredSession),
    );
  } catch {
    /* ignore */
  }
});
