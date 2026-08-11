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
  const [immersive, setImmersive] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [highlightMode, setHighlightMode] = useState(false);
  const [highlightColor, setHighlightColor] = useState('#fde047');
  /** 拖拽高亮实时预览：页码 -> 合并后的连续色块（PDF 坐标） */
  const [liveSel, setLiveSel] = useState<Record<number, Quad[]>>({});
  const hlDragRef = useRef(false);
  /** 高亮拖拽起点/当前点（客户端坐标）：选词 = 扫过的矩形区域 */
  const hlStartPtRef = useRef<{ x: number; y: number } | null>(null);
  const hlLastMoveRef = useRef<{ x: number; y: number } | null>(null);
  const hlRafRef = useRef(0);
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
    if (screenshotMode || highlightMode || !canPanRef.current) return;
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
    if (!doc || !virtualRange) return;
    const L = layoutRef.current;
    for (let r = virtualRange.start; r < virtualRange.end; r++) {
      for (const n of L.rows[r] ?? []) {
        void getPageTextIndex(doc, pdf.id, n)
          .then((index) => {
            if (docRef.current === doc) textIndexRef.current.set(n, index);
          })
          .catch(() => undefined);
      }
    }
  }, [doc, virtualRange, pdf.id, layout]);

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
  const scrollToPage = useCallback((n: number) => {
    const el = scrollRef.current;
    if (!el) return;
    // 目标页已挂载且尺寸就绪 → 立即定位（不依赖平滑滚动）
    const tryJump = () => {
      const p = pageRefs.current.get(n);
      if (p && p.offsetHeight > 0) {
        p.scrollIntoView({ block: 'start' });
        return true;
      }
      return false;
    };
    if (tryJump()) return;
    // 目标页尚未挂载：用虚拟布局的精确行顶位置直接滚动（触发可视窗口挂载），
    // 再持续轮询直到页面尺寸就绪后精确对齐，保证跳转不会丢失
    const L = layoutRef.current;
    const rowIdx = L.rows.findIndex((r) => r.includes(n));
    if (rowIdx >= 0) {
      el.scrollTop = Math.max(0, L.tops[rowIdx]);
    } else if (baseH > 0 && scale > 0) {
      el.scrollTop = Math.max(0, Math.round((n - 1) * (baseH * scale + 16)));
    }
    let tries = 0;
    const align = () => {
      if (tryJump()) return;
      if (++tries < 240) requestAnimationFrame(align); // 最长约 4 秒，等待大 PDF 渲染
    };
    requestAnimationFrame(align);
  }, [baseH, scale, layout]);

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
      scrollToPage(Math.min(Math.max(1, jumpPage), pageCount));
      consumeJump();
    }
  }, [jumpPage, pageCount, scrollToPage, consumeJump, paneActive]);

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

  // ---------- text selection -> highlight（涂过式：拖拽扫过的矩形区域，按行合并） ----------
  /** 取出与 PDF 矩形相交的文本项（含空格/标点项，整行整块不再断） */
  const selectItemsInPdfRect = (
    page: number,
    r: { x1: number; y1: number; x2: number; y2: number },
  ): TextItemQuad[] => {
    const index = textIndexRef.current.get(page);
    if (!index) return [];
    const minX = Math.min(r.x1, r.x2);
    const maxX = Math.max(r.x1, r.x2);
    const minY = Math.min(r.y1, r.y2);
    const maxY = Math.max(r.y1, r.y2);
    const TOL = 0.5;
    const hit = index.items.filter(
      (it) =>
        it.x < maxX + TOL &&
        it.x + it.w > minX - TOL &&
        it.y < maxY + TOL &&
        it.y + it.h > minY - TOL,
    );
    return hit;
  };

  /** 按“扫过矩形”逐页取选中文本项（支持跨页） */
  const computeRectSelection = (
    sx: number,
    sy: number,
    cx: number,
    cy: number,
  ): { page: number; items: TextItemQuad[]; lines: PageTextIndex['lines'] }[] => {
    // 拖拽矩形加 ±6px 容差：纯水平拖拽也有竖向覆盖，不会因 0 高矩形跳过
    const x1 = Math.min(sx, cx) - 6;
    const x2 = Math.max(sx, cx) + 6;
    const y1 = Math.min(sy, cy) - 6;
    const y2 = Math.max(sy, cy) + 6;
    const out: { page: number; items: TextItemQuad[]; lines: PageTextIndex['lines'] }[] = [];
    for (const [page, el] of pageRefs.current) {
      const r = el.getBoundingClientRect();
      const ix = Math.max(x1, r.left);
      const iy = Math.max(y1, r.top);
      const ix2 = Math.min(x2, r.right);
      const iy2 = Math.min(y2, r.bottom);
      if (ix2 <= ix || iy2 <= iy) continue;
      const vp = viewportsRef.current.get(page);
      const index = textIndexRef.current.get(page);
      if (!vp || !index) continue;
      const [px1, py1] = vp.convertToPdfPoint(ix - r.left, iy - r.top);
      const [px2, py2] = vp.convertToPdfPoint(ix2 - r.left, iy2 - r.top);
      const items = selectItemsInPdfRect(page, { x1: px1, y1: py1, x2: px2, y2: py2 });
      if (items.length) out.push({ page, items, lines: index.lines });
    }
    return out;
  };

  const updateHlSelection = () => {
    const start = hlStartPtRef.current;
    const last = hlLastMoveRef.current;
    if (!start || !last) return;
    const sel = computeRectSelection(start.x, start.y, last.x, last.y);
    const next: Record<number, Quad[]> = {};
    for (const { page, items, lines } of sel) next[page] = mergeSelectionItems(items, lines);
    setLiveSel(next);
  };

  const commitHlSelection = async () => {
    const start = hlStartPtRef.current;
    const last = hlLastMoveRef.current;
    setLiveSel({});
    if (!start || !last) return;
    // 单击（几乎没移动）不生成高亮
    if (Math.abs(last.x - start.x) + Math.abs(last.y - start.y) < 8) return;
    const pages = computeRectSelection(start.x, start.y, last.x, last.y);
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
      setInspectorTab('annotations');
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

  const hlMouseDown = (e: React.MouseEvent) => {
    if (!highlightMode || !doc) return;
    if (e.button !== 0) return;
    // 同步阻止浏览器原生选区，避免与预览色块叠加
    e.preventDefault();
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    hlStartPtRef.current = { x: e.clientX, y: e.clientY };
    hlLastMoveRef.current = null;
    hlDragRef.current = true;
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
      // 没有 mousemove（单击）时用 mouseup 位置提交，交给移动阈值拦截
      if (!hlLastMoveRef.current) hlLastMoveRef.current = { x: ev.clientX, y: ev.clientY };
      void commitHlSelection();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (highlightMode) hlMouseDown(e);
    else onPanMouseDown(e);
  };

  const handleAnnotationClick = (a: AnnotationRecord) => {
    setSelectedAnnotationId(a.id);
    setInspectorTab('annotations');
    scrollToPage(a.page);
  };

  // ---------- annotation right-click menu ----------
  const deleteAnnotation = async (a: AnnotationRecord) => {
    try {
      await window.pkm.deleteAnnotation(a.id);
      setAnnotations(await window.pkm.listAnnotations(pdf.id));
      if (selectedAnnotationId === a.id) setSelectedAnnotationId(null);
      toast('success', t('inspector.annotationDeleted'));
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
      setToolbarCollapsed(true);
      setImmersive(true);
      setScale(1.21);
    } else {
      const prev = immersivePrevRef.current;
      setImmersive(false);
      if (prev) {
        setScale(prev.scale);
        setToolbarCollapsed(prev.toolbarCollapsed);
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
      onAnnotationClick={handleAnnotationClick}
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
          <div
            className="absolute inset-x-0 top-0 z-30"
            onMouseEnter={() => setToolbarCollapsed(false)}
            onMouseLeave={() => setToolbarCollapsed(true)}
          >
            {toolbarCollapsed ? (
              <div className="h-5" />
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
            )}
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
            className={`h-full overflow-auto bg-[var(--app-canvas)] ${
              panning
                ? 'cursor-grabbing select-none'
                : highlightMode
                  ? 'select-none'
                  : !rightDragPan && canPan && !screenshotMode
                  ? 'cursor-grab'
                  : ''
            }`}
            onMouseDown={handleMouseDown}
            onClick={(e) => {
              // 点击空白处取消高亮选中（点在高亮色块上时保持选中）
              const t = e.target as HTMLElement;
              if (!t.closest('.annotation-hl')) setSelectedAnnotationId(null);
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
              label: t('inspector.annotationEdit'),
              onClick: () => handleAnnotationClick(annMenu.a),
            },
            {
              label: t('inspector.annotationDelete'),
              danger: true,
              onClick: () => void deleteAnnotation(annMenu.a),
            },
          ]}
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
