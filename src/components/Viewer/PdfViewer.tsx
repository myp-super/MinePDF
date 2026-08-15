import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AnnotationRecord, PdfiumOpenResult, PdfRecord, Quad } from '../../shared/types';
import { useT, useTError } from '../../i18n';
import {
  getOutlineTree,
  pdfjsLib,
  searchInDocument,
  setupPdfjs,
  type OutlineNode,
  type SearchMatch,
  type ViewportLike,
} from '../../lib/pdf';
import {
  getCachedPage,
  pageCacheKey,
  putCachedPage,
  renderBucket,
  toImageBitmap,
} from '../../lib/pageImageCache';
import { pdfiumRenderQueued } from '../../lib/pdfiumBatcher';
import {
  getPageTextIndex,
  mergeSelectionItems,
  type PageTextIndex,
  type TextItemQuad,
} from '../../lib/textIndex';
import { useApp } from '../../store';
import { ContextMenu } from '../ui';
import { AnnotationNotePopup, type NoteTarget } from './AnnotationNotePopup';
import { PdfPage, type PdfLinkService } from './PdfPage';
import { PdfSearchBar } from './PdfSearchBar';
import { PdfToolbar } from './PdfToolbar';

interface PdfViewerProps {
  pdf: PdfRecord;
  /** 阅读屏唯一标识：分屏时用于区分各屏的渲染请求，避免互相覆盖 */
  paneId: string;
  onMissing: (pdf: PdfRecord) => void;
  /** 是否为当前激活窗格：只有激活窗格上报页码并响应页面跳转 */
  paneActive?: boolean;
}

/** LRU cache of opened PDFDocumentProxy so switching back is instant. */
const DOC_CACHE = new Map<number, PDFDocumentProxy>();
const DOC_CACHE_MAX = 4;
const DESTROYED = new Set<number>();

function cacheDoc(id: number, doc: PDFDocumentProxy | null): void {
  if (!doc) {
    const old = DOC_CACHE.get(id);
    DOC_CACHE.delete(id);
    DESTROYED.add(id);
    if (old) void old.destroy().catch(() => undefined);
    return;
  }
  if (DOC_CACHE.has(id)) DOC_CACHE.delete(id);
  DOC_CACHE.set(id, doc);
  DESTROYED.delete(id);
  while (DOC_CACHE.size > DOC_CACHE_MAX) {
    const oldestKey = DOC_CACHE.keys().next().value as number | undefined;
    if (oldestKey == null) break;
    const old = DOC_CACHE.get(oldestKey);
    DOC_CACHE.delete(oldestKey);
    if (oldestKey !== id) DESTROYED.add(oldestKey);
    if (old) void old.destroy().catch(() => undefined);
  }
}

/** PDF viewer: load, zoom, single/double page, search and text highlights. */
export function PdfViewer({ pdf, paneId, onMissing, paneActive = true }: PdfViewerProps) {
  const t = useT();
  const terr = useTError();
  const toast = useApp((s) => s.toast);
  const setInspectorTab = useApp((s) => s.setInspectorTab);
  const toggleInspectorCollapsed = useApp((s) => s.toggleInspectorCollapsed);
  /** 右键拖拽平移开关：开启时鼠标保持系统箭头，按住右键拖动平移（左键留给链接/选词） */
  const rightDragPan = useApp((s) => s.settings.rightDragPan);
  const setStoreOutline = useApp((s) => s.setOutline);
  const jumpPage = useApp((s) => s.jumpPage);
  const jumpTop = useApp((s) => s.jumpTop);
  const consumeJump = useApp((s) => s.consumeJump);
  const setStoreCurrentPage = useApp((s) => s.setCurrentPage);
  const outlineCount = useApp((s) => s.outline.length);
  const screenshotMode = useApp((s) => s.screenshotMode);
  const setScreenshotMode = useApp((s) => s.setScreenshotMode);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfiumInfo, setPdfiumInfo] = useState<PdfiumOpenResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<'single' | 'double'>('single');
  const [currentPage, setCurrentPage] = useState(1);
  const immersive = useApp((s) => s.immersive);
  const setImmersive = useApp((s) => s.setImmersive);
  const immersiveTopOpen = useApp((s) => s.immersiveTopOpen);
  const setImmersiveTopOpen = useApp((s) => s.setImmersiveTopOpen);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [highlightMode, setHighlightMode] = useState(false);
  const [highlightColor, setHighlightColor] = useState('#fde047');
  /** 拖拽高亮实时预览：页码 -> 合并后的连续色块（PDF 坐标） */
  const [liveSel, setLiveSel] = useState<Record<number, Quad[]>>({});
  /** 普通模式已选中的连续选区（蓝色，仿 Edge 选词；Ctrl+C 可复制） */
  const [selection, setSelection] = useState<{
    quads: Record<number, Quad[]>;
    text: string;
  } | null>(null);
  const hlDragRef = useRef(false);
  /** 当前拖拽模式：高亮 / 普通选词 */
  const selModeRef = useRef<'highlight' | 'select' | null>(null);
  /** 选词起点：按下时的（页, 行, 行内 line 下标, 行内字符索引） */
  const hlStartRef = useRef<{ page: number; row: number; line: number; idx: number } | null>(null);
  /** 选词当前点：鼠标最新所在（页, 行, 行内 line 下标, 行内字符索引） */
  const hlCurRef = useRef<{ page: number; row: number; line: number; idx: number } | null>(null);
  /** 选词起点所属列的 PDF 横向范围：拖拽期间把指针 X 钳制在该列内，禁止跨栏 */
  const hlColRef = useRef<{ minX: number; maxX: number } | null>(null);
  /** 客户端起点坐标：用于“单击不选”的移动阈值 */
  const hlStartPtRef = useRef<{ x: number; y: number } | null>(null);
  const hlLastMoveRef = useRef<{ x: number; y: number } | null>(null);
  const hlRafRef = useRef(0);
  /** 拖拽结束后会跟随一次 click：抑制它，避免刚选完就被“点空白清除”逻辑清掉 */
  const suppressNextClickRef = useRef(false);
  /** 已就绪的页文本索引（读序项 + 行带），供拖拽期间同步命中测试 */
  const textIndexRef = useRef<Map<number, PageTextIndex>>(new Map());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null);
  const [baseW, setBaseW] = useState(0);
  const [baseH, setBaseH] = useState(0);
  /** 所有页的真实物理尺寸（pt）：虚拟滚动精确布局用；PDFium 一次性返回 */
  const [pageSizes, setPageSizes] = useState<{ w: number; h: number }[] | null>(null);
  const [annMenu, setAnnMenu] = useState<{
    a: AnnotationRecord;
    x: number;
    y: number;
  } | null>(null);
  /** 标注弹窗（编辑已有高亮标注 / 从选区新建标注） */
  const [notePopup, setNotePopup] = useState<{
    target: NoteTarget;
    initialNote?: string;
    x: number;
    y: number;
  } | null>(null);
  /** 颜色选择弹窗（高亮换色 / 选区新建高亮） */
  const [colorPopup, setColorPopup] = useState<{
    x: number;
    y: number;
    mode: 'edit' | 'create';
    a?: AnnotationRecord;
    pages?: { page: number; quads: Quad[] }[];
    content?: string;
  } | null>(null);
  /** 普通选词右键菜单 */
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const viewportsRef = useRef<Map<number, ViewportLike>>(new Map());
  const scaleRef = useRef(scale);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const currentPdfIdRef = useRef<number | null>(null);
  const [panning, setPanning] = useState(false);
  const [canPan, setCanPan] = useState(false);
  const canPanRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const immersivePrevRef = useRef<{
    scale: number;
    sidebar: boolean;
    inspector: boolean;
    maximized: boolean;
    toolbarCollapsed: boolean;
  } | null>(null);
  const immersiveRef = useRef(false);

  useEffect(() => {
    immersiveRef.current = immersive;
  }, [immersive]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  // 捕获模式专用：把「文本索引的行 + 字符」转换为屏幕客户端坐标，供自动化诊断按真实行拖选
  useEffect(() => {
    if (!window.location.hash.includes('capture')) return;
    const w = window as unknown as Record<string, unknown>;
    w.__pkmSelPoint = (page: number, lineIdx: number, charIdx: number) => {
      const index = textIndexRef.current.get(page);
      const el = pageRefs.current.get(page);
      const vp = viewportsRef.current.get(page);
      if (!index || !el || !vp || !index.lines[lineIdx]) return null;
      const gi = index.lines[lineIdx].indices[charIdx];
      if (gi == null) return null;
      const it = index.items[gi];
      const r = el.getBoundingClientRect();
      const [vx, vy] = vp.convertToViewportPoint(it.x + it.w / 2, it.y + it.h / 2);
      return { x: r.left + vx, y: r.top + vy, str: it.str };
    };
    w.__pkmSelLineInfo = (page: number, lineIdx: number) => {
      const index = textIndexRef.current.get(page);
      if (!index || !index.lines[lineIdx]) return null;
      const l = index.lines[lineIdx];
      return {
        minY: l.minY,
        maxY: l.maxY,
        n: l.indices.length,
        text: l.indices.map((gi) => index.items[gi].str).join(''),
      };
    };
  }, []);

  // ---------- 放大后可抓取平移 ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const overflow =
        el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2;
      canPanRef.current = overflow;
      setCanPan(overflow);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [doc, scale, mode, pdf.id]);

  const onPanMouseDown = (e: React.MouseEvent) => {
    if (screenshotMode || !canPanRef.current) return;
    // 右键拖拽模式用右键平移；关闭后恢复左键平移
    const btn = rightDragPan ? 2 : 0;
    if (e.button !== btn) return;
    const el = scrollRef.current;
    if (!el) return;
    panStartRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setPanning(true);
    let raf = 0;
    let lastEv: MouseEvent | null = null;
    let moved = false;
    // 按下瞬间立即挂监听，保证跟手；mouseup 时移除
    const onMove = (ev: MouseEvent) => {
      const s0 = panStartRef.current;
      if (!s0) return;
      if (!moved && Math.abs(ev.clientX - s0.x) + Math.abs(ev.clientY - s0.y) > 4) moved = true;
      lastEv = ev;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const e = lastEv;
        const elc = scrollRef.current;
        const s = panStartRef.current;
        if (!e || !elc || !s) return;
        elc.scrollLeft = s.sl - (e.clientX - s.x);
        elc.scrollTop = s.st - (e.clientY - s.y);
      });
    };
    // 右键拖拽时抑制系统右键菜单（仅真正拖动后），避免平移结束弹出菜单
    const onCtx = (ev: MouseEvent) => {
      if (moved) ev.preventDefault();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('contextmenu', onCtx, true);
      if (raf) cancelAnimationFrame(raf);
      panStartRef.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    if (rightDragPan) window.addEventListener('contextmenu', onCtx, true);
  };

  // ---------- document load (with LRU cache for fast reopening) ----------
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let owned: PDFDocumentProxy | null = null;
    let finished = false;
    let restored = false;
    // 记录该 PDF 上次阅读页码：切标签/重开后恢复（须在 setCurrentPage(1) 重置前读取）
    const savedPage = useApp.getState().tabPages[pdf.id] ?? 1;
    const restorePage = () => {
      if (restored) return;
      restored = true;
      if (savedPage > 1 && currentPdfIdRef.current === pdf.id) {
        useApp.getState().requestJump(savedPage);
      }
    };
    // 每次打开 PDF 只应用一次默认面板：有书签默认书签页，无书签默认笔记页
    let outlineTabApplied = false;
    const applyOutline = (tree: Awaited<ReturnType<typeof getOutlineTree>>) => {
      setStoreOutline(tree);
      // 缓存书签结果并写回数据库，下次打开直接决定默认面板，不再闪“信息”
      useApp.getState().setOutlineFor(pdf.id, tree);
      void window.pkm.updatePdfHasOutline(pdf.id, tree.length > 0).catch(() => undefined);
      if (!outlineTabApplied) {
        outlineTabApplied = true;
        setInspectorTab(tree.length > 0 ? 'outline' : 'notes');
      }
    };
    currentPdfIdRef.current = pdf.id;
    // 首次打开 PDF 时才初始化 PDF.js worker（推迟 1.3MB worker 的加载，加快应用启动）
    setupPdfjs();
    setDoc(null);
    setPdfiumInfo(null);
    setPageSizes(null);
    setLoadError(null);
    setAnnotations([]);
    setSelectedAnnotationId(null);
    setStoreOutline([]);
    setSearchMatches([]);
    setSearchCurrent(0);
    setCurrentPage(1);

    const cached = DOC_CACHE.get(pdf.id);
    if (cached && !DESTROYED.has(pdf.id)) {
      DESTROYED.delete(pdf.id);
      setDoc(cached);
      restorePage();
      void window.pkm
        .pdfiumOpen(pdf.id)
        .then((info) => {
          if (currentPdfIdRef.current === pdf.id && info) {
            setPdfiumInfo(info);
            setPageSizes(
              Array.from({ length: info.pageCount }, () => ({ w: info.width, h: info.height })),
            );
            void window.pkm
              .pdfiumPageSizes(pdf.id)
              .then((sizes) => {
                if (currentPdfIdRef.current === pdf.id && sizes.length) setPageSizes(sizes);
              })
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
      void setAnnotationsFromCache(cached, pdf);
      void getOutlineTree(cached).then((tree) => {
        if (currentPdfIdRef.current !== pdf.id) return;
        applyOutline(tree);
      });
      return;
    }

    void (async () => {
      try {
        // PDFium 与 PDF.js 并行打开。重点：不等 readPdf（大文件整份经 IPC 传输耗时），
        // PDFium 打开 ~1ms 先把页数/尺寸落地，页面即可用 PDFium 位图开始渲染（秒出首帧）。
        const pdfiumPromise = window.pkm.pdfiumOpen(pdf.id).catch(() => null);
        const pdfiumInfoRes = await pdfiumPromise;
        if (cancelled) return;
        if (pdfiumInfoRes) {
          setPdfiumInfo(pdfiumInfoRes);
          setBaseW(pdfiumInfoRes.width);
          setBaseH(pdfiumInfoRes.height);
          // 先用第 1 页尺寸估算全部页，等真实尺寸 IPC 返回后替换，首帧不必等
          setPageSizes(
            Array.from(
              { length: pdfiumInfoRes.pageCount },
              () => ({ w: pdfiumInfoRes.width, h: pdfiumInfoRes.height }),
            ),
          );
          void window.pkm.updatePdfPageCount(pdf.id, pdfiumInfoRes.pageCount).catch(() => undefined);
          void window.pkm
            .pdfiumPageSizes(pdf.id)
            .then((sizes) => {
              if (currentPdfIdRef.current === pdf.id && sizes.length) setPageSizes(sizes);
            })
            .catch(() => undefined);
        }
        // 位图布局已就绪，提前恢复上次阅读页码，不必等 pdf.js 解析完
        restorePage();
        const buf = await window.pkm.readPdf(pdf.id);
        if (cancelled) return;
        loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: './cmaps/',
          cMapPacked: true,
          isEvalSupported: false,
        });
        owned = await loadingTask.promise;
        if (cancelled) {
          void owned.destroy();
          return;
        }
        finished = true;
        cacheDoc(pdf.id, owned);
        setDoc(owned);
        restorePage();
        void getOutlineTree(owned).then((tree) => {
          if (!cancelled) applyOutline(tree);
        });
        const p1 = await owned.getPage(1);
        const vp1 = p1.getViewport({ scale: 1 });
        setBaseW(vp1.width);
        setBaseH(vp1.height);
        void window.pkm.updatePdfPageCount(pdf.id, owned.numPages).catch(() => undefined);
        try {
          setAnnotations(await window.pkm.listAnnotations(pdf.id));
        } catch {
          /* ignore */
        }
      } catch (err) {
        if (cancelled) return;
        cacheDoc(pdf.id, null);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ERR_PDF_MISSING')) {
          onMissing(pdf);
        } else {
          setLoadError(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
      // 只有尚未加载完成的文档才需要销毁；已完成的文档保留在缓存中复用
      if (!finished) {
        DESTROYED.add(pdf.id);
        if (loadingTask) void loadingTask.destroy().catch(() => undefined);
        if (owned) {
          cacheDoc(pdf.id, null);
          void owned.destroy().catch(() => undefined);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.id]);

  const setAnnotationsFromCache = async (cached: PDFDocumentProxy, p: PdfRecord) => {
    try {
      if (currentPdfIdRef.current !== p.id) return;
      setAnnotations(await window.pkm.listAnnotations(p.id));
      const p1 = await cached.getPage(1);
      const vp1 = p1.getViewport({ scale: 1 });
      if (currentPdfIdRef.current !== p.id) return;
      setBaseW(vp1.width);
      setBaseH(vp1.height);
    } catch {
      /* ignore */
    }
  };

  // PDFium 打开即给出页数：pdf.js 文档就绪前也能先渲染页面（秒出首帧）
  const pageCount = doc?.numPages ?? pdfiumInfo?.pageCount ?? 0;

  // ---------- 虚拟滚动布局（SumatraPDF 式：只挂载可视区附近的行） ----------
  // 大文件不再为每一页创建 DOM，只渲染视口 ± 预载行，打开/滚动/缩放都保持轻量。
  interface PageLayout {
    rows: number[][];
    tops: number[];
    rowHs: number[];
    totalH: number;
    contentW: number;
  }
  const layout = useMemo<PageLayout>(() => {
    const sizes = pageSizes;
    const rowCount = mode === 'double' ? Math.ceil(pageCount / 2) : pageCount;
    const rows: number[][] = [];
    const tops: number[] = [];
    const rowHs: number[] = [];
    const GAP = 8;
    const PAD_TOP = 12;
    const PAD_BOT = 12;
    const PAD_X = 16;
    let y = PAD_TOP;
    let maxW = 0;
    for (let r = 0; r < rowCount; r++) {
      const row = mode === 'double' ? [r * 2 + 1, r * 2 + 2].filter((n) => n <= pageCount) : [r + 1];
      let rowH = 0;
      let rowW = 0;
      for (const n of row) {
        const s = sizes?.[n - 1];
        const w = (s && s.w > 0 ? s.w : baseW) * scale;
        const h = (s && s.h > 0 ? s.h : baseH) * scale;
        rowW += w;
        rowH = Math.max(rowH, h);
      }
      rowW += (row.length - 1) * 6;
      maxW = Math.max(maxW, rowW);
      tops.push(y);
      rows.push(row);
      rowHs.push(rowH);
      y += rowH + GAP;
    }
    return {
      rows,
      tops,
      rowHs,
      totalH: Math.max(1, y - GAP + PAD_BOT),
      contentW: Math.max(1, maxW + PAD_X * 2),
    };
  }, [pageCount, pageSizes, mode, scale, baseW, baseH]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [virtualRange, setVirtualRange] = useState<{ start: number; end: number } | null>(null);
  const rangeRef = useRef<{ start: number; end: number } | null>(null);
  const updateVirtual = useCallback(() => {
    const el = scrollRef.current;
    const L = layoutRef.current;
    if (!el || !L.rows.length) {
      rangeRef.current = null;
      setVirtualRange(null);
      return;
    }
    const viewH = Math.max(el.clientHeight, 1);
    const preload = Math.max(viewH * 1.2, 700);
    const top = el.scrollTop - preload;
    const bottom = el.scrollTop + viewH + preload;
    let lo = 0;
    let hi = L.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (L.tops[mid] + L.rowHs[mid] < top) lo = mid + 1;
      else hi = mid;
    }
    const start = lo;
    lo = 0;
    hi = L.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (L.tops[mid] <= bottom) lo = mid + 1;
      else hi = mid;
    }
    const end = Math.max(lo, start + 1);
    const cur = rangeRef.current;
    if (!cur || cur.start !== start || cur.end !== end) {
      rangeRef.current = { start, end };
      setVirtualRange({ start, end });
    }
  }, []);

  // 布局（页数/尺寸/缩放/模式）变化后重算可视窗口
  useEffect(() => {
    updateVirtual();
  }, [updateVirtual, layout]);

  // 高亮选词文本项预热：虚拟窗口内的页提前取好文本四边形，拖拽选词零等待
  useEffect(() => {
    if (!pdfiumInfo || !virtualRange) return;
    const L = layoutRef.current;
    for (let r = virtualRange.start; r < virtualRange.end; r++) {
      for (const n of L.rows[r] ?? []) {
        void getPageTextIndex(pdf.id, n)
          .then((index) => textIndexRef.current.set(n, index))
          .catch(() => undefined);
      }
    }
  }, [pdfiumInfo, virtualRange, pdf.id, layout]);

  // 宽度自适应策略（3.2.1）：
  // - 打开文档时适配一次；
  // - 标题栏最大化/还原按键：始终自动适配宽度；
  // - 拖拽窗口边框缩小，且 PDF 被阅读区遮挡（横向溢出）时才自动适配；
  // - 放大窗口、折叠/展开边栏或信息面板、拖拽分屏分隔线：一律不自动缩放，
  //   避免大文件反复重渲染（用户可手动缩放或用小手拖拽查看）。
  useEffect(() => {
    if (!baseW) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fit = () => {
      if (immersiveRef.current) return;
      const w = scrollRef.current?.clientWidth ?? 800;
      setScale(Math.max(0.3, (w - 48) / baseW));
    };
    const schedule = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, 250);
    };
    // PDF 是否被阅读区遮挡：内容宽度超出可视宽度（出现横向滚动/被裁切）
    const clipped = () => {
      const el = scrollRef.current;
      return el ? el.scrollWidth > el.clientWidth + 4 : false;
    };
    let lastWinW = window.innerWidth;
    const onResize = () => {
      const nextW = window.innerWidth;
      const shrinking = nextW < lastWinW - 1;
      lastWinW = nextW;
      if (!shrinking) return; // 放大窗口：保持当前缩放
      schedule(() => {
        if (clipped()) fit(); // 缩小且 PDF 被遮挡才适配
      });
    };
    const onMaxChanged = () => schedule(fit); // 最大化/还原按键始终适配
    const off = window.pkm.onMaximizedChange?.(onMaxChanged);
    window.addEventListener('resize', onResize);
    schedule(fit); // 打开文档适配一次
    return () => {
      window.removeEventListener('resize', onResize);
      off?.();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, baseW]);

  // ---------- page tracking ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        updateVirtual();
        let cur = 1;
        for (const [n, pageEl] of pageRefs.current) {
          const top = pageEl.getBoundingClientRect().top - el.getBoundingClientRect().top;
          if (top < 140) cur = n;
        }
        setCurrentPage(cur);
      });
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [doc, mode, pageCount, scale, updateVirtual]);

  // ---------- 相邻页预渲染（SumatraPDF 式） ----------
  // 当前页变化/缩放后，提前把下一页（双页模式预取下一行两页）的 PDFium 位图渲染进缓存，
  // 翻页时直接命中缓存秒开，避免滚动到目标页才发起渲染的等待。仅活动屏预取，控制 IPC 负载。
  useEffect(() => {
    if (!paneActive || !pdfiumInfo || pageCount <= 1) return;
    const dpr = window.devicePixelRatio || 1;
    const bucket = renderBucket(scale * dpr);
    const prefetch = (n: number) => {
      if (n < 1 || n > pageCount) return;
      const key = pageCacheKey(pdf.id, n, bucket);
      if (getCachedPage(key)) return;
      pdfiumRenderQueued(paneId, pdf.id, n, bucket)
        .then(async (res) => {
          const bmp = await toImageBitmap(res);
          putCachedPage(key, bmp, res.w, res.h);
        })
        .catch(() => undefined);
    };
    prefetch(currentPage + 1);
    if (mode === 'double') prefetch(currentPage + 2);
  }, [currentPage, scale, mode, pageCount, pdf.id, paneId, paneActive, pdfiumInfo]);

  // ---------- Ctrl + wheel zoom（只作用于本屏自己的滚动容器，锚定光标） ----------
  // 监听挂在每个屏独立的滚动容器上：分屏时各屏独立缩放，
  // 鼠标在侧边栏/信息面板上滚动也不会误触发 PDF 缩放。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const oldScale = scaleRef.current;
      const newScale = Math.min(4, Math.max(0.3, oldScale * factor));
      const rect = el.getBoundingClientRect();
      const anchorX = e.clientX - rect.left + el.scrollLeft;
      const anchorY = e.clientY - rect.top + el.scrollTop;
      scaleRef.current = newScale;
      setScale(newScale);
      // 锚定光标：以缩放前后比例保持光标处的文档点不动
      el.scrollLeft = (anchorX * newScale) / oldScale - (e.clientX - rect.left);
      el.scrollTop = (anchorY * newScale) / oldScale - (e.clientY - rect.top);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => {
      el.removeEventListener('wheel', handler);
    };
  }, [doc, pdf.id]);

  // ---------- shortcuts ----------
  const scrollToPage = useCallback((n: number, top?: number | null) => {
    const el = scrollRef.current;
    if (!el) return;
    const L = layoutRef.current;

    /**
     * 目标章节在 scroll 内容坐标系中的 Y（每次调用基于当前真实 DOM/布局动态计算）：
     * - 页面已挂载：用页面与 scroll 容器的实际 rect + 当前 scrollTop 反推页面绝对位置；
     * - 页面未挂载：用虚拟布局的行顶（含页间距），先滚动触发挂载，随后校正；
     * - 页内偏移：优先用 pdf.js viewport 把 PDF 用户空间 y-up 坐标权威转换成
     *   当前渲染尺寸下“距页顶的 DOM 像素”（自动处理缩放/旋转）；viewport 未就绪时
     *   用页面尺寸 × scale 估算（无旋转）。
     */
    const targetY = (): number | null => {
      let pageAbsTop: number | null = null;
      const p = pageRefs.current.get(n);
      if (p && p.offsetHeight > 0) {
        const cRect = el.getBoundingClientRect();
        const pRect = p.getBoundingClientRect();
        pageAbsTop = el.scrollTop + (pRect.top - cRect.top);
      } else {
        const rowIdx = L.rows.findIndex((r) => r.includes(n));
        if (rowIdx >= 0) pageAbsTop = L.tops[rowIdx];
      }
      if (pageAbsTop == null) return null;

      let offset = 0;
      if (top != null && top > 0) {
        const vp = viewportsRef.current.get(n);
        if (vp) {
          // PDF 用户空间 y-up → 视口 y-down（含当前 scale 与页面旋转）
          const [, vy] = vp.convertToViewportPoint(0, top);
          offset = Math.max(0, Math.round(vy));
        } else {
          const s = pageSizes?.[n - 1];
          const pageH = s && s.h > 0 ? s.h : baseH;
          offset = Math.max(0, Math.round((pageH - top) * scale));
        }
      }
      return Math.max(0, pageAbsTop + offset);
    };

    // 立即定位一次（页面已挂载则直接到位；未挂载则按布局估算滚动以触发挂载）
    const y0 = targetY();
    if (y0 != null) el.scrollTop = y0;

    // 持续校正：等待大 PDF 渲染 / 缩放 / 布局稳定后，用最新坐标重算并修正，
    // 直到目标章节精确贴合 viewport 顶部（不做任何固定偏移）
    let tries = 0;
    let last = 0;
    const align = (ts: number) => {
      const y = targetY();
      if (y != null && Math.abs(el.scrollTop - y) < 1.5) return; // 已精确对齐
      if (ts - last < 80) {
        requestAnimationFrame(align);
        return;
      }
      last = ts;
      if (y != null) el.scrollTop = y;
      if (++tries < 80) requestAnimationFrame(align); // 最长约 6.5 秒，等待大 PDF 渲染/布局稳定
    };
    requestAnimationFrame(align);
  }, [baseH, scale, layout, pageSizes]);

  // 同步当前页到全局（信息面板书签高亮）
  useEffect(() => {
    if (paneActive) setStoreCurrentPage(currentPage);
  }, [currentPage, setStoreCurrentPage, paneActive]);

  // 卸载（切换标签/关闭屏）前把当前页码记入 per-pdf 表，切回该标签时恢复
  useEffect(() => {
    return () => {
      if (currentPage > 1) useApp.getState().rememberTabPage(pdf.id, currentPage);
    };
  }, [currentPage, pdf.id]);

  // 信息面板书签点击 -> 阅读器跳转
  useEffect(() => {
    if (!paneActive) return;
    if (jumpPage != null && pageCount > 0) {
      scrollToPage(Math.min(Math.max(1, jumpPage), pageCount), jumpTop);
      consumeJump();
    }
  }, [jumpPage, jumpTop, pageCount, scrollToPage, consumeJump, paneActive]);

  /** Link service for PDF internal links / cross references + external URLs. */
  const linkService = useMemo<PdfLinkService>(
    () => ({
      externalLinkEnabled: true,
      getDestinationHash: () => '#',
      getAnchorUrl: (hash: string) => hash,
      addLinkAttributes: (link, url, newWindow) => {
        link.href = '#';
        link.onclick = (e) => {
          e.preventDefault();
          void window.pkm.openExternalUrl(url).catch(() => undefined);
          return false;
        };
        if (newWindow) {
          link.target = '_blank';
          link.rel = 'noopener';
        }
      },
      goToDestination: async (dest: unknown) => {
        const d = docRef.current;
        if (!d) return;
        try {
          let ref: unknown = null;
          if (typeof dest === 'string') {
            const arr = await d.getDestination(dest);
            if (Array.isArray(arr) && arr.length) ref = arr[0];
          } else if (Array.isArray(dest) && dest.length) {
            ref = dest[0];
          }
          if (!ref || typeof ref !== 'object') return;
          const index = await d.getPageIndex(ref as never);
          if (typeof index === 'number') scrollToPage(index + 1);
        } catch {
          /* ignore invalid destination */
        }
      },
    }),
    [scrollToPage],
  );

  const gotoPage = useCallback(
    (n: number) => {
      if (!pageCount) return;
      scrollToPage(Math.min(Math.max(1, n), pageCount));
    },
    [pageCount, scrollToPage],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen((o) => !o);
        return;
      }
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === 'Escape') {
        if (searchOpen) setSearchOpen(false);
        else if (immersive) void toggleImmersive();
        return;
      }
      if (typing) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        gotoPage(currentPage + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gotoPage(currentPage - 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === '=') {
        e.preventDefault();
        setScale((s) => Math.min(4, s * 1.15));
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        setScale((s) => Math.max(0.3, s / 1.15));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, immersive, currentPage, gotoPage]);

  // ---------- in-document search ----------
  useEffect(() => {
    if (!doc || !searchQuery.trim()) {
      setSearchMatches([]);
      setSearchCurrent(0);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const matches = await searchInDocument(doc, searchQuery.trim());
        if (cancelled) return;
        setSearchMatches(matches);
        setSearchCurrent(0);
        if (matches.length) scrollToPage(matches[0].page);
      } catch {
        /* ignore */
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, doc, scrollToPage]);

  const stepSearch = useCallback(
    (dir: 1 | -1) => {
      const total = searchMatches.length;
      if (!total) return;
      const next = (searchCurrent + dir + total) % total;
      setSearchCurrent(next);
      scrollToPage(searchMatches[next].page);
    },
    [searchMatches, searchCurrent, scrollToPage],
  );

  // ---------- text selection -> highlight（按“行 + 行内字符索引”精确计算，跨行不再整段联动） ----------
  const pageAtPoint = (x: number, y: number): number | null => {
    for (const [n, el] of pageRefs.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return n;
    }
    return null;
  };

  /** 光标在行内的字符索引：落在某字符内（或其后间隙）→ 该字符；行尾之后 → 行长度 */
  const charIndexAt = (items: TextItemQuad[], rowChars: number[], px: number): number => {
    if (!rowChars.length) return 0;
    const last = items[rowChars[rowChars.length - 1]];
    if (px >= last.x + last.w) return rowChars.length;
    for (let i = 0; i < rowChars.length; i++) {
      const it = items[rowChars[i]];
      if (px < it.x + it.w) return i;
    }
    return rowChars.length;
  };

  /** 客户端坐标 -> (页, 行, 行内 line 下标, 行内字符索引)；文本索引未就绪返回 null */
  const pointToRowChar = (
    page: number,
    x: number,
    y: number,
    clampX?: { minX: number; maxX: number },
  ): { row: number; line: number; idx: number } | null => {
    const index = textIndexRef.current.get(page);
    const el = pageRefs.current.get(page);
    const vp = viewportsRef.current.get(page);
    if (!index || !el || !vp || !index.lines.length) return null;
    const r = el.getBoundingClientRect();
    let [px, py] = vp.convertToPdfPoint(x - r.left, y - r.top);
    if (clampX) px = Math.min(Math.max(px, clampX.minX), clampX.maxX);
    const lines = index.lines;
    let best = -1;
    let bestDx = Infinity;
    let bestDy = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const dy = Math.abs(py - (l.minY + l.maxY) / 2);
      const dx = px < l.minX ? l.minX - px : px > l.maxX ? px - l.maxX : 0;
      // 优先横向命中（同一视觉列），其次纵向最近
      if (dx < bestDx - 0.5 || (Math.abs(dx - bestDx) <= 0.5 && dy < bestDy)) {
        bestDx = dx;
        bestDy = dy;
        best = i;
      }
    }
    if (best < 0) return null;
    const line = lines[best];
    const idx = charIndexAt(index.items, line.indices, px);
    return { row: line.row, line: best, idx };
  };

  /** 取某 line [from, to) 的字符项 */
  const lineCharItems = (
    index: PageTextIndex,
    lineIdx: number,
    from: number,
    to: number,
  ): TextItemQuad[] => {
    const line = index.lines[lineIdx];
    if (!line) return [];
    const a = Math.max(0, Math.min(from, line.indices.length));
    const b = Math.max(0, Math.min(to, line.indices.length));
    const out: TextItemQuad[] = [];
    for (let i = a; i < b; i++) out.push(index.items[line.indices[i]]);
    return out;
  };

  /** 在指定视觉行里，找到与起始列 X 中心最接近的 line（列对齐用） */
  const lineInColumn = (index: PageTextIndex, row: number, colCx: number): number => {
    const cands = index.rowLines[row];
    if (!cands || !cands.length) return -1;
    let best = cands[0];
    let bestD = Infinity;
    for (const li of cands) {
      const l = index.lines[li];
      const d = Math.abs((l.minX + l.maxX) / 2 - colCx);
      if (d < bestD) {
        bestD = d;
        best = li;
      }
    }
    return best;
  };

  /**
   * 按“起点行/终点行”精确计算选中字符（半开区间），并强制约束在起点所属视觉列内：
   * - 同页：起点行只选起点之后，终点行只选到鼠标位置，中间行整行（仅该列）；
   * - 跨页：起点页/终点页同理，中间页整页（仅该列）。
   * 支持从上往下与从下往上（对称）；允许跨行，禁止跨栏。
   */
  const computeRowSelection = (
    start: { page: number; row: number; line: number; idx: number },
    cur: { page: number; row: number; line: number; idx: number },
  ): { page: number; items: TextItemQuad[]; lines: PageTextIndex['lines'] }[] => {
    const out: { page: number; items: TextItemQuad[]; lines: PageTextIndex['lines'] }[] = [];
    const startIndex = textIndexRef.current.get(start.page);
    const startLine = startIndex?.lines[start.line];
    if (!startLine) return out;
    const colCx = (startLine.minX + startLine.maxX) / 2;
    // 按文档顺序（上 → 下、页 → 页）决定遍历方向：
    // - downward：起点在上，遍历 start..cur；
    // - upward：起点在下，遍历 cur..start（对称反转）。
    const downward = start.page < cur.page || (start.page === cur.page && start.row <= cur.row);
    const lo = downward ? start.page : cur.page;
    const hi = downward ? cur.page : start.page;
    for (let p = lo; p <= hi; p++) {
      const index = textIndexRef.current.get(p);
      if (!index || !index.lines.length) continue;
      const rowCount = index.rowLines.length;
      const items: TextItemQuad[] = [];
      // 本页的行区间：
      // - downward：起点页从 start.row 起，终点页到 cur.row 止，中间页全页；
      // - upward：终点页（上方）从 cur.row 起，起点页（下方）到 start.row 止，中间页全页。
      const rStart = p === (downward ? start.page : cur.page) ? (downward ? start.row : cur.row) : 0;
      const rEnd = p === (downward ? cur.page : start.page) ? (downward ? cur.row : start.row) : rowCount - 1;
      for (let r = rStart; r <= rEnd; r++) {
        let li: number;
        if (p === start.page && r === start.row) li = start.line;
        else if (p === cur.page && r === cur.row) li = cur.line;
        else li = lineInColumn(index, r, colCx);
        if (li < 0) continue;
        const rowLen = index.lines[li].indices.length;
        let from = 0;
        let to = rowLen;
        // 同一行（含反向拖选）：取两点之间的区间
        if (p === start.page && p === cur.page && r === start.row && r === cur.row) {
          from = Math.min(start.idx, cur.idx);
          to = Math.max(start.idx, cur.idx) + 1;
        } else if (downward) {
          if (p === start.page && r === start.row) from = start.idx;
          if (p === cur.page && r === cur.row) to = cur.idx + 1;
        } else {
          if (p === cur.page && r === cur.row) from = cur.idx;
          if (p === start.page && r === start.row) to = start.idx + 1;
        }
        items.push(...lineCharItems(index, li, from, to));
      }
      if (items.length) out.push({ page: p, items, lines: index.lines });
    }
    return out;
  };

  const updateHlSelection = () => {
    const start = hlStartRef.current;
    const last = hlLastMoveRef.current;
    if (!start || !last) return;
    const page = pageAtPoint(last.x, last.y);
    if (page == null) return;
    const rc = pointToRowChar(page, last.x, last.y, hlColRef.current ?? undefined);
    if (!rc) return;
    hlCurRef.current = { page, row: rc.row, line: rc.line, idx: rc.idx };
    const sel = computeRowSelection(start, hlCurRef.current);
    const next: Record<number, Quad[]> = {};
    for (const { page: pg, items, lines } of sel) next[pg] = mergeSelectionItems(items, lines);
    setLiveSel(next);
  };

  const finalSelection = () => {
    const start = hlStartRef.current;
    const cur = hlCurRef.current;
    if (!start || !cur) return [];
    return computeRowSelection(start, cur);
  };

  const commitHlSelection = async () => {
    const start = hlStartPtRef.current;
    const last = hlLastMoveRef.current;
    setLiveSel({});
    if (!start || !last) return;
    // 单击（几乎没移动）不生成高亮
    if (Math.abs(last.x - start.x) + Math.abs(last.y - start.y) < 8) return;
    const pages = finalSelection();
    if (!pages.length) return;
    try {
      for (const { page, items, lines } of pages) {
        const quads = mergeSelectionItems(items, lines);
        if (!quads.length) continue;
        await window.pkm.createAnnotation({
          pdfId: pdf.id,
          page,
          content: items.map((i) => i.str).join(''),
          note: '',
          position: JSON.stringify(quads),
          color: highlightColor,
        });
      }
      setAnnotations(await window.pkm.listAnnotations(pdf.id));
      toast(
        'success',
        pages.length > 1
          ? t('toolbar.highlighted.multi', { n: pages.length })
          : t('toolbar.highlighted'),
      );
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  /** 普通模式：把精确选区保存为蓝色连续选区（不生成高亮） */
  const commitSelection = () => {
    const start = hlStartPtRef.current;
    const last = hlLastMoveRef.current;
    setLiveSel({});
    if (!start || !last) return;
    // 单击（几乎没移动）不产生选区，保留链接点击等默认行为
    if (Math.abs(last.x - start.x) + Math.abs(last.y - start.y) < 8) return;
    const pages = finalSelection();
    if (!pages.length) return;
    const quads: Record<number, Quad[]> = {};
    const parts: string[] = [];
    for (const { page, items, lines } of pages) {
      const qs = mergeSelectionItems(items, lines);
      if (qs.length) quads[page] = qs;
      parts.push(items.map((i) => i.str).join(''));
    }
    setSelection({ quads, text: parts.join('\n') });
    suppressNextClickRef.current = true;
  };

  const startSelectDrag = (e: React.MouseEvent, mode: 'highlight' | 'select') => {
    if (e.button !== 0) return;
    // 同步阻止浏览器原生选区，避免与预览色块叠加
    e.preventDefault();
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    const page = pageAtPoint(e.clientX, e.clientY);
    if (page == null) return;
    const rc = pointToRowChar(page, e.clientX, e.clientY);
    if (!rc) return;
    const startIndex = textIndexRef.current.get(page);
    const startLine = startIndex?.lines[rc.line];
    if (!startLine) return;
    hlStartRef.current = { page, row: rc.row, line: rc.line, idx: rc.idx };
    hlCurRef.current = { ...hlStartRef.current };
    hlColRef.current = { minX: startLine.minX, maxX: startLine.maxX };
    hlStartPtRef.current = { x: e.clientX, y: e.clientY };
    hlLastMoveRef.current = null;
    hlDragRef.current = true;
    selModeRef.current = mode;
    const onMove = (ev: MouseEvent) => {
      hlLastMoveRef.current = { x: ev.clientX, y: ev.clientY };
      if (hlRafRef.current) return;
      hlRafRef.current = requestAnimationFrame(() => {
        hlRafRef.current = 0;
        updateHlSelection();
      });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (hlRafRef.current) {
        cancelAnimationFrame(hlRafRef.current);
        hlRafRef.current = 0;
      }
      hlDragRef.current = false;
      hlColRef.current = null;
      // 没有 mousemove（单击）时用 mouseup 位置提交，交给移动阈值拦截
      if (!hlLastMoveRef.current) {
        hlLastMoveRef.current = { x: ev.clientX, y: ev.clientY };
        updateHlSelection();
      }
      if (selModeRef.current === 'highlight') void commitHlSelection();
      else commitSelection();
      selModeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // 右键平移优先：高亮模式下也要能用右键小手抓取
    if (rightDragPan && e.button === 2) {
      onPanMouseDown(e);
      return;
    }
    if (highlightMode) {
      startSelectDrag(e, 'highlight');
      return;
    }
    if (rightDragPan) {
      // 左键普通连续选词
      startSelectDrag(e, 'select');
      return;
    }
    onPanMouseDown(e);
  };

  const handleAnnotationClick = (a: AnnotationRecord) => {
    setSelectedAnnotationId(a.id);
  };

  const saveAnnotationNote = async (target: NoteTarget, note: string) => {
    try {
      if (target.kind === 'existing') {
        await window.pkm.updateAnnotation(target.id, { note });
      } else {
        for (const { page, quads } of target.pages) {
          await window.pkm.createAnnotation({
            pdfId: pdf.id,
            page,
            content: target.content,
            note,
            position: JSON.stringify(quads),
            color: target.color,
          });
        }
      }
      setAnnotations(await window.pkm.listAnnotations(pdf.id));
      setNotePopup(null);
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const clearAnnotationNote = async (a: AnnotationRecord) => {
    try {
      await window.pkm.updateAnnotation(a.id, { note: '' });
      setAnnotations(await window.pkm.listAnnotations(pdf.id));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const applyHighlightColor = async (color: string) => {
    const cp = colorPopup;
    setColorPopup(null);
    if (!cp) return;
    try {
      if (cp.mode === 'edit' && cp.a) {
        await window.pkm.updateAnnotation(cp.a.id, { color });
      } else if (cp.mode === 'create' && cp.pages) {
        for (const { page, quads } of cp.pages) {
          await window.pkm.createAnnotation({
            pdfId: pdf.id,
            page,
            content: cp.content ?? '',
            note: '',
            position: JSON.stringify(quads),
            color,
          });
        }
      }
      setAnnotations(await window.pkm.listAnnotations(pdf.id));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const copySelectionText = () => {
    if (!selection) return;
    void navigator.clipboard
      .writeText(selection.text)
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = selection.text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      });
  };

  // ---------- annotation right-click menu ----------
  const deleteAnnotation = async (a: AnnotationRecord) => {
    try {
      await window.pkm.deleteAnnotation(a.id);
      setAnnotations(await window.pkm.listAnnotations(pdf.id));
      if (selectedAnnotationId === a.id) setSelectedAnnotationId(null);
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  // Delete/Backspace 删除选中的高亮
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selectedAnnotationId == null) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ann = annotations.find((a) => a.id === selectedAnnotationId);
        if (ann) {
          e.preventDefault();
          void deleteAnnotation(ann);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedAnnotationId, annotations, deleteAnnotation]);

  // Ctrl+C 复制普通模式选中的文字
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      e.preventDefault();
      void navigator.clipboard
        .writeText(selection.text)
        .catch(() => {
          const ta = document.createElement('textarea');
          ta.value = selection.text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  // ---------- data grouping ----------
  const annotationsByPage = useMemo(() => {
    const m = new Map<number, AnnotationRecord[]>();
    for (const a of annotations) {
      const arr = m.get(a.page) ?? [];
      arr.push(a);
      m.set(a.page, arr);
    }
    return m;
  }, [annotations]);

  const searchByPage = useMemo(() => {
    const m = new Map<number, SearchMatch[]>();
    for (const s of searchMatches) {
      const arr = m.get(s.page) ?? [];
      arr.push(s);
      m.set(s.page, arr);
    }
    return m;
  }, [searchMatches]);

  const registerPage = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(n, el);
    else pageRefs.current.delete(n);
  }, []);

  const registerViewport = useCallback((n: number, vp: ViewportLike | null) => {
    if (vp) viewportsRef.current.set(n, vp);
    else viewportsRef.current.delete(n);
  }, []);

  const fitWidth = () => {
    if (!baseW) return;
    const w = scrollRef.current?.clientWidth ?? 800;
    setScale(Math.max(0.3, (w - 56) / baseW));
  };
  const fitPage = () => {
    if (!baseH) return;
    const h = scrollRef.current?.clientHeight ?? 600;
    setScale(Math.max(0.3, (h - 48) / baseH));
  };

  /**
   * 沉浸式阅读：最大化窗口 + 收起左右边栏 + 固定放大到 161%；
   * 再次点击恢复到点击前的窗口、缩放与边栏状态。
   */
  const toggleImmersive = async () => {
    const s = useApp.getState();
    if (!immersive) {
      const wasMax = await window.pkm.isMaximized().catch(() => false);
      immersivePrevRef.current = {
        scale,
        sidebar: s.sidebarCollapsed,
        inspector: s.inspectorCollapsed,
        maximized: wasMax,
        toolbarCollapsed,
      };
      if (!wasMax) await window.pkm.toggleMaximize();
      if (!s.sidebarCollapsed) s.setSidebarCollapsed(true);
      if (!s.inspectorCollapsed) s.setInspectorCollapsed(true);
      setImmersiveTopOpen(false);
      setImmersive(true);
      setScale(1.21);
    } else {
      const prev = immersivePrevRef.current;
      setImmersive(false);
      setImmersiveTopOpen(false);
      if (prev) {
        setScale(prev.scale);
        if (prev.sidebar !== s.sidebarCollapsed) s.setSidebarCollapsed(prev.sidebar);
        if (prev.inspector !== s.inspectorCollapsed) s.setInspectorCollapsed(prev.inspector);
        if (!prev.maximized) {
          const isMax = await window.pkm.isMaximized().catch(() => true);
          if (isMax) await window.pkm.toggleMaximize();
        }
      }
    }
  };

  const renderPage = (n: number) => (
    <PdfPage
      key={`${pdf.id}-${n}`}
      doc={doc}
      pdfId={pdf.id}
      paneId={paneId}
      pageNumber={n}
      scale={scale}
      renderer={pdfiumInfo ? 'pdfium' : 'pdfjs'}
      fallbackW={pdfiumInfo?.width ?? null}
      fallbackH={pdfiumInfo?.height ?? null}
      annotations={annotationsByPage.get(n) ?? []}
      searchMatches={searchByPage.get(n) ?? []}
      selectedAnnotationId={selectedAnnotationId}
      linkService={linkService}
      liveHighlights={liveSel[n]}
      highlightColor={highlightColor}
      liveHighlightsColor={highlightMode ? highlightColor : '#3b82f6'}
      selectionQuads={selection?.quads[n]}
      onAnnotationClick={handleAnnotationClick}
      onAnnotationNote={(a, x, y) => {
        setSelectedAnnotationId(a.id);
        setNotePopup({ target: { kind: 'existing', id: a.id }, initialNote: a.note, x, y });
      }}
      onAnnotationContextMenu={(a, x, y) => setAnnMenu({ a, x, y })}
      onJumpToPage={gotoPage}
      registerPage={registerPage}
      registerViewport={registerViewport}
    />
  );

  const insertScreenshot = async (dataUrl: string) => {
    try {
      const rel = await window.pkm.saveNoteImage(pdf.id, dataUrl);
      const note = await window.pkm.getNote(pdf.id);
      const markdown = `${note?.markdown ?? ''}\n\n![${pdf.title || pdf.filename} 截图](${rel})\n`;
      await window.pkm.saveNote(pdf.id, markdown);
      setScreenshotMode(false);
      setInspectorTab('notes');
      // 通知笔记面板刷新，让插入的图片立刻显示
      useApp.getState().bumpNoteRevision();
    } catch (err) {
      setScreenshotMode(false);
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-app-base">
      {!immersive &&
        (toolbarCollapsed ? (
          <div className="flex h-6 shrink-0 items-center justify-center border-b border-app-border bg-app-panel">
            <button
              className="flex h-6 w-9 items-center justify-center text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
              title={t('toolbar.expandToolbar')}
              aria-label={t('toolbar.expandToolbar')}
              onClick={() => setToolbarCollapsed(false)}
            >
              <ChevronDown size={13} />
            </button>
          </div>
        ) : (
          <PdfToolbar
            pdf={pdf}
            pageCount={pageCount}
            currentPage={currentPage}
            scale={scale}
            mode={mode}
            outlineCount={outlineCount}
            highlightMode={highlightMode}
            highlightColor={highlightColor}
            immersive={immersive}
            ready={Boolean(doc)}
            onPageChange={(n) => gotoPage(n)}
            onPrev={() => gotoPage(currentPage - 1)}
            onNext={() => gotoPage(currentPage + 1)}
            onZoomIn={() => setScale((s) => Math.min(4, s * 1.15))}
            onZoomOut={() => setScale((s) => Math.max(0.3, s / 1.15))}
            onFitWidth={fitWidth}
            onFitPage={fitPage}
            onToggleMode={() => setMode((m) => (m === 'single' ? 'double' : 'single'))}
            onOpenOutline={() => {
              if (useApp.getState().inspectorCollapsed) toggleInspectorCollapsed();
              setInspectorTab('outline');
            }}
            onToggleHighlight={() => setHighlightMode((v) => !v)}
            onColorChange={setHighlightColor}
            onToggleSearch={() => setSearchOpen((v) => !v)}
            onToggleImmersive={toggleImmersive}
            onToggleToolbar={() => setToolbarCollapsed(true)}
            onOpenExternal={() =>
              void window.pkm.openPdfExternal(pdf.id).catch((err: unknown) =>
                toast('error', terr(err instanceof Error ? err.message : String(err))),
              )
            }
          />
        ))}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {immersive && (
          <div className="absolute inset-x-0 top-0 z-30">
            {/* 折叠时的顶部热区：光标移入展开 */}
            <div className={immersiveTopOpen ? 'h-0' : 'h-5'} />
            {/* 工具栏滑出动画（不突然出现） */}
            <div
              data-immersive-toolbar
              className={`overflow-hidden transition-[max-height,opacity] duration-300 ease-out ${
                immersiveTopOpen
                  ? 'max-h-16 opacity-100'
                  : 'max-h-0 opacity-0'
              }`}
            >
              <PdfToolbar
                pdf={pdf}
                pageCount={pageCount}
                currentPage={currentPage}
                scale={scale}
                mode={mode}
                outlineCount={outlineCount}
                highlightMode={highlightMode}
                highlightColor={highlightColor}
                immersive={immersive}
                ready={Boolean(doc)}
                onPageChange={(n) => gotoPage(n)}
                onPrev={() => gotoPage(currentPage - 1)}
                onNext={() => gotoPage(currentPage + 1)}
                onZoomIn={() => setScale((s) => Math.min(4, s * 1.15))}
                onZoomOut={() => setScale((s) => Math.max(0.3, s / 1.15))}
                onFitWidth={fitWidth}
                onFitPage={fitPage}
                onToggleMode={() => setMode((m) => (m === 'single' ? 'double' : 'single'))}
                onOpenOutline={() => {
                  if (useApp.getState().inspectorCollapsed) toggleInspectorCollapsed();
                  setInspectorTab('outline');
                }}
                onToggleHighlight={() => setHighlightMode((v) => !v)}
                onColorChange={setHighlightColor}
                onToggleSearch={() => setSearchOpen((v) => !v)}
                onToggleImmersive={toggleImmersive}
                onToggleToolbar={() => setToolbarCollapsed(true)}
                onOpenExternal={() =>
                  void window.pkm.openPdfExternal(pdf.id).catch((err: unknown) =>
                    toast('error', terr(err instanceof Error ? err.message : String(err))),
                  )
                }
              />
            </div>
          </div>
        )}
        {searchOpen && (
          <PdfSearchBar
            query={searchQuery}
            setQuery={setSearchQuery}
            matches={searchMatches}
            current={searchCurrent}
            onStep={stepSearch}
            onClose={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
          />
        )}

        {doc || pdfiumInfo ? (
          <div
            ref={scrollRef}
            data-pan-scroll
            className={`h-full select-none overflow-auto bg-[var(--app-canvas)] ${
              panning
                ? 'cursor-grabbing'
                : highlightMode
                  ? ''
                  : !rightDragPan && canPan && !screenshotMode
                  ? 'cursor-grab'
                  : ''
            }`}
            onMouseDown={handleMouseDown}
            onContextMenu={(e) => {
              const t = e.target as HTMLElement;
              if (t.closest('.annotation-hl')) return; // 高亮色块有自己的右键菜单
              if (selection) {
                e.preventDefault();
                setSelMenu({ x: e.clientX, y: e.clientY });
              }
            }}
            onClick={(e) => {
              // 点击空白处取消高亮选中与普通选区（点在高亮色块上时保持选中）
              if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                return;
              }
              const t = e.target as HTMLElement;
              if (!t.closest('.annotation-hl')) {
                setSelectedAnnotationId(null);
                setSelection(null);
              }
            }}
          >
            {/* 虚拟滚动：容器总高度 = 全部行高之和，只挂载可视区 ± 预载行，
                m-auto：内容小于视口时居中；超出时自动贴左贴顶，保证四边都能滚动到 */}
            <div
              ref={contentRef}
              className="relative mx-auto"
              style={{ width: layout.contentW, height: layout.totalH }}
            >
              {virtualRange &&
                layout.rows.slice(virtualRange.start, virtualRange.end).map((row, idx) => {
                  const absIdx = virtualRange.start + idx;
                  return (
                    <div
                      key={absIdx}
                      className="absolute flex items-start justify-center gap-1.5"
                      style={{ top: layout.tops[absIdx], left: 0, width: '100%' }}
                    >
                      {row.map(renderPage)}
                    </div>
                  );
                })}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-app-muted">
            {loadError ? (
              <>
                <p className="text-xs">{t('app.fileMissing')}</p>
                <p className="max-w-sm break-all px-6 text-center text-[10.5px] opacity-70">
                  {loadError}
                </p>
              </>
            ) : (
              <>
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
                <p className="text-xs">{t('viewer.loading')}</p>
              </>
            )}
          </div>
        )}

        {screenshotMode && (
          <ScreenshotOverlay
            containerRef={scrollRef}
            onClose={() => setScreenshotMode(false)}
            onInsert={(d) => void insertScreenshot(d)}
          />
        )}
      </div>

      {annMenu && (
        <ContextMenu
          x={annMenu.x}
          y={annMenu.y}
          onClose={() => setAnnMenu(null)}
          items={[
            {
              label: t('viewer.editNote'),
              onClick: () => {
                setNotePopup({
                  target: { kind: 'existing', id: annMenu.a.id },
                  initialNote: annMenu.a.note,
                  x: annMenu.x,
                  y: annMenu.y,
                });
                setAnnMenu(null);
              },
            },
            {
              label: t('viewer.deleteNote'),
              disabled: !annMenu.a.note,
              onClick: () => {
                void clearAnnotationNote(annMenu.a);
                setAnnMenu(null);
              },
            },
            {
              label: t('viewer.highlight'),
              onClick: () => {
                setColorPopup({ x: annMenu.x, y: annMenu.y, mode: 'edit', a: annMenu.a });
                setAnnMenu(null);
              },
            },
            {
              label: t('inspector.annotationDelete'),
              danger: true,
              onClick: () => void deleteAnnotation(annMenu.a),
            },
          ]}
        />
      )}
      {selMenu && (
        <ContextMenu
          x={selMenu.x}
          y={selMenu.y}
          onClose={() => setSelMenu(null)}
          items={[
            {
              label: t('viewer.copy'),
              onClick: () => {
                copySelectionText();
                setSelMenu(null);
              },
            },
            {
              label: t('viewer.highlight'),
              onClick: () => {
                const pages = selection
                  ? Object.entries(selection.quads).map(([p, quads]) => ({
                      page: Number(p),
                      quads,
                    }))
                  : [];
                setColorPopup({
                  x: selMenu.x,
                  y: selMenu.y,
                  mode: 'create',
                  pages,
                  content: selection?.text ?? '',
                });
                setSelMenu(null);
              },
            },
            {
              label: t('viewer.addNote'),
              onClick: () => {
                const pages = selection
                  ? Object.entries(selection.quads).map(([p, quads]) => ({
                      page: Number(p),
                      quads,
                    }))
                  : [];
                setNotePopup({
                  target: {
                    kind: 'new',
                    pages,
                    content: selection?.text ?? '',
                    color: '#fde047',
                  },
                  x: selMenu.x,
                  y: selMenu.y,
                });
                setSelMenu(null);
              },
            },
          ]}
        />
      )}
      {colorPopup && (
        <>
          <div className="fixed inset-0 z-[79]" onClick={() => setColorPopup(null)} />
          <div
            className="fixed z-[80] flex gap-1.5 rounded-xl border border-app-border bg-app-panel p-2 shadow-2xl"
            style={{
              left: Math.max(8, Math.min(colorPopup.x, window.innerWidth - 176)),
              top: Math.max(8, Math.min(colorPopup.y, window.innerHeight - 48)),
            }}
          >
            {['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74', '#c4b5fd'].map((c) => (
              <button
                key={c}
                className="h-6 w-6 rounded-full border border-black/20 transition-transform hover:scale-110"
                style={{ background: c }}
                title={c}
                aria-label={c}
                onClick={() => void applyHighlightColor(c)}
              />
            ))}
          </div>
        </>
      )}
      {notePopup && (
        <AnnotationNotePopup
          target={notePopup.target}
          initialNote={notePopup.initialNote}
          x={notePopup.x}
          y={notePopup.y}
          onClose={() => setNotePopup(null)}
          onSaved={(target, note) => void saveAnnotationNote(target, note)}
        />
      )}
    </main>
  );
}

/** 将阅读区选区截成 PNG：跨页自动拼接（高清画布像素） */
function captureRegion(
  container: HTMLElement,
  sel: { x: number; y: number; w: number; h: number },
): string | null {
  try {
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sel.w * dpr));
    out.height = Math.max(1, Math.round(sel.h * dpr));
    const octx = out.getContext('2d');
    if (!octx) return null;
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    const cRect = container.getBoundingClientRect();
    const selLeft = cRect.left + sel.x;
    const selTop = cRect.top + sel.y;
    const sheets = Array.from(document.querySelectorAll('.pdf-page-sheet'));
    for (const sheet of sheets) {
      const r = sheet.getBoundingClientRect();
      const ix = Math.max(selLeft, r.left);
      const iy = Math.max(selTop, r.top);
      const ix2 = Math.min(selLeft + sel.w, r.right);
      const iy2 = Math.min(selTop + sel.h, r.bottom);
      if (ix2 <= ix || iy2 <= iy) continue;
      const canvas = sheet.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvas) continue;
      const rx = canvas.width / r.width;
      const ry = canvas.height / r.height;
      const sx = Math.round((ix - r.left) * rx);
      const sy = Math.round((iy - r.top) * ry);
      const sw = Math.round((ix2 - ix) * rx);
      const sh = Math.round((iy2 - iy) * ry);
      octx.drawImage(
        canvas,
        sx,
        sy,
        sw,
        sh,
        Math.round((ix - selLeft) * dpr),
        Math.round((iy - selTop) * dpr),
        Math.round((ix2 - ix) * dpr),
        Math.round((iy2 - iy) * dpr),
      );
    }
    return out.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** 选区截图界面：拖拽框选，退出 / 复制图片 / 插入笔记 */
function ScreenshotOverlay({
  containerRef,
  onClose,
  onInsert,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onInsert: (dataUrl: string) => void;
}) {
  const t = useT();
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  type EditMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  const editRef = useRef<EditMode | null>(null);
  const editStartRef = useRef<{
    x: number;
    y: number;
    rect: { x: number; y: number; w: number; h: number };
  } | null>(null);

  const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  /**
   * 框定后：拖动选区内部移动位置，拖动四角/四边调整大小；
   * 结束编辑后按新选区重新截图，保证插入的图片与选区一致。
   */
  const startEdit = (e: React.MouseEvent, mode: EditMode) => {
    const r = rectRef.current;
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    editRef.current = mode;
    editStartRef.current = { x: e.clientX, y: e.clientY, rect: { ...r } };
    const onMove = (ev: MouseEvent) => {
      const es = editStartRef.current;
      if (!es) return;
      const dx = ev.clientX - es.x;
      const dy = ev.clientY - es.y;
      const cw = containerRef.current?.clientWidth ?? 0;
      const ch = containerRef.current?.clientHeight ?? 0;
      const r0 = es.rect;
      const min = 12;
      let next = { ...r0 };
      if (mode === 'move') {
        next.x = clampNum(r0.x + dx, 0, Math.max(0, cw - r0.w));
        next.y = clampNum(r0.y + dy, 0, Math.max(0, ch - r0.h));
      } else {
        if (mode.includes('e')) next.w = clampNum(r0.w + dx, min, cw - r0.x);
        if (mode.includes('s')) next.h = clampNum(r0.h + dy, min, ch - r0.y);
        if (mode.includes('w')) {
          const nx = clampNum(r0.x + dx, 0, r0.x + r0.w - min);
          next.x = nx;
          next.w = r0.x + r0.w - nx;
        }
        if (mode.includes('n')) {
          const ny = clampNum(r0.y + dy, 0, r0.y + r0.h - min);
          next.y = ny;
          next.h = r0.y + r0.h - ny;
        }
      }
      rectRef.current = next;
      setRect(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      editRef.current = null;
      editStartRef.current = null;
      const rr = rectRef.current;
      if (rr && rr.w >= 4 && rr.h >= 4 && containerRef.current) {
        setDataUrl(captureRegion(containerRef.current, rr));
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const EDIT_HANDLES: Array<{ id: EditMode; cursor: string; style: React.CSSProperties }> = [
    { id: 'nw', cursor: 'nwse-resize', style: { left: -4, top: -4 } },
    { id: 'n', cursor: 'ns-resize', style: { left: '50%', top: -4, transform: 'translateX(-50%)' } },
    { id: 'ne', cursor: 'nesw-resize', style: { right: -4, top: -4 } },
    { id: 'e', cursor: 'ew-resize', style: { right: -4, top: '50%', transform: 'translateY(-50%)' } },
    { id: 'se', cursor: 'nwse-resize', style: { right: -4, bottom: -4 } },
    { id: 's', cursor: 'ns-resize', style: { left: '50%', bottom: -4, transform: 'translateX(-50%)' } },
    { id: 'sw', cursor: 'nesw-resize', style: { left: -4, bottom: -4 } },
    { id: 'w', cursor: 'ew-resize', style: { left: -4, top: '50%', transform: 'translateY(-50%)' } },
  ];

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = containerRef.current?.getBoundingClientRect();
      const s = startRef.current;
      if (!r || !s) return;
      const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
      const next = {
        x: Math.min(s.x, x),
        y: Math.min(s.y, y),
        w: Math.abs(x - s.x),
        h: Math.abs(y - s.y),
      };
      rectRef.current = next;
      setRect(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      startRef.current = null;
      const rr = rectRef.current;
      if (rr && rr.w >= 4 && rr.h >= 4 && containerRef.current) {
        setDataUrl(captureRegion(containerRef.current, rr));
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef]);

  // Esc 随时退出截图模式
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const barLeft = rect
    ? Math.max(8, Math.min(rect.x + rect.w / 2 - 110, (containerRef.current?.clientWidth ?? 300) - 240))
    : 8;
  const barTop = rect
    ? Math.min(rect.y + rect.h + 10, (containerRef.current?.clientHeight ?? 300) - 44)
    : 8;

  return (
    <div
      className={`absolute inset-0 z-40 cursor-crosshair ${rect ? '' : 'bg-black/35'}`}
      onMouseDown={(e) => {
        // 只有点击遮罩背景本身才开始框选；操作条按钮不受影响
        if (e.target !== e.currentTarget) return;
        const r = containerRef.current?.getBoundingClientRect();
        if (!r) return;
        e.preventDefault();
        draggingRef.current = true;
        setDataUrl(null);
        startRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
        const init = { x: startRef.current.x, y: startRef.current.y, w: 0, h: 0 };
        rectRef.current = init;
        setRect(init);
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      title={t('note.screenshotHint')}
    >
      <div className="pointer-events-none absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded-md bg-app-panel/90 px-3 py-1.5 text-[11px] text-app-muted shadow-lg">
        {t('note.screenshotHint')}
      </div>
      <button
        className="absolute right-3 top-3 z-50 rounded-md border border-app-border bg-app-panel px-2.5 py-1 text-[11px] text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        {t('note.screenshotExit')} (Esc)
      </button>
      {rect && rect.w > 0 && rect.h > 0 && (
        <div
          className={`absolute border-2 border-app-accent ${dataUrl ? 'cursor-grab' : ''}`}
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            // 选中区域恢复原色：只有框外被压暗
            boxShadow: '0 0 0 100vmax rgba(0,0,0,0.35)',
          }}
          onMouseDown={(e) => {
            // 框定后按住选区内部可拖动挪位
            if (!dataUrl) return;
            startEdit(e, 'move');
          }}
        >
          {dataUrl &&
            EDIT_HANDLES.map((h) => (
              <div
                key={h.id}
                className="absolute h-2.5 w-2.5 rounded-[2px] border border-white bg-app-accent shadow"
                style={{ ...h.style, cursor: h.cursor }}
                onMouseDown={(e) => startEdit(e, h.id)}
              />
            ))}
        </div>
      )}
      {dataUrl && (
        <div
          className="animate-pop absolute z-50 flex items-center gap-1 rounded-lg border border-app-border bg-app-panel p-1 shadow-2xl"
          style={{ left: barLeft, top: barTop }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="rounded-md px-2.5 py-1 text-[11px] text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
            onClick={onClose}
          >
            {t('note.screenshotExit')}
          </button>
          <button
            className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] text-white transition-colors hover:brightness-110"
            onClick={() => onInsert(dataUrl)}
          >
            {t('note.screenshotInsert')}
          </button>
        </div>
      )}
    </div>
  );
}
