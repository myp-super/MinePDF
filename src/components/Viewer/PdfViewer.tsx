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
import { useApp } from '../../store';
import { ContextMenu } from '../ui';
import { PdfPage, type PdfLinkService } from './PdfPage';
import { PdfSearchBar } from './PdfSearchBar';
import { PdfToolbar } from './PdfToolbar';

interface PdfViewerProps {
  pdf: PdfRecord;
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
export function PdfViewer({ pdf, onMissing, paneActive = true }: PdfViewerProps) {
  const t = useT();
  const terr = useTError();
  const toast = useApp((s) => s.toast);
  const setInspectorTab = useApp((s) => s.setInspectorTab);
  const toggleInspectorCollapsed = useApp((s) => s.toggleInspectorCollapsed);
  const setStoreOutline = useApp((s) => s.setOutline);
  const jumpPage = useApp((s) => s.jumpPage);
  const consumeJump = useApp((s) => s.consumeJump);
  const setStoreCurrentPage = useApp((s) => s.setCurrentPage);
  const outlineCount = useApp((s) => s.outline.length);
  const screenshotMode = useApp((s) => s.screenshotMode);
  const setScreenshotMode = useApp((s) => s.setScreenshotMode);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const inspectorWidth = useApp((s) => s.inspectorWidth);
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed);
  const inspectorCollapsed = useApp((s) => s.inspectorCollapsed);

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null);
  const [baseW, setBaseW] = useState(0);
  const [baseH, setBaseH] = useState(0);
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
    if (e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    panStartRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setPanning(true);
    let raf = 0;
    let lastEv: MouseEvent | null = null;
    // 按下瞬间立即挂监听，保证跟手；mouseup 时移除
    const onMove = (ev: MouseEvent) => {
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
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
      panStartRef.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---------- document load (with LRU cache for fast reopening) ----------
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let owned: PDFDocumentProxy | null = null;
    let finished = false;
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
      void window.pkm
        .pdfiumOpen(pdf.id)
        .then((info) => {
          if (currentPdfIdRef.current === pdf.id && info) setPdfiumInfo(info);
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
        // PDFium 与 PDF.js 并行打开：PDFium 打开 ~1ms，可提前拿到页数/尺寸
        const pdfiumPromise = window.pkm.pdfiumOpen(pdf.id).catch(() => null);
        const buf = await window.pkm.readPdf(pdf.id);
        if (cancelled) return;
        const pdfiumInfoRes = await pdfiumPromise;
        if (cancelled) return;
        if (pdfiumInfoRes) {
          setPdfiumInfo(pdfiumInfoRes);
          setBaseW(pdfiumInfoRes.width);
          setBaseH(pdfiumInfoRes.height);
          void window.pkm.updatePdfPageCount(pdf.id, pdfiumInfoRes.pageCount).catch(() => undefined);
        }
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

  const pageCount = doc?.numPages ?? 0;

  // 自动适配宽度：打开文档、窗口拖拽松手、最大化/还原、边栏折叠/展开后，
  // 阅读区宽度变化即自动 fitWidth（250ms 防抖模拟“松手”）；沉浸式保持 121%
  // 注意：不能监听滚动容器宽度（页面放大产生滚动条会误触发并撤销用户缩放）
  useEffect(() => {
    if (!doc || !baseW) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (immersiveRef.current) return;
        const w = scrollRef.current?.clientWidth ?? 800;
        setScale(Math.max(0.3, (w - 48) / baseW));
      }, 250);
    };
    schedule(); // 打开文档即适配一次
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      if (timer) clearTimeout(timer);
    };
  }, [doc, baseW, sidebarWidth, inspectorWidth, sidebarCollapsed, inspectorCollapsed]);

  // ---------- page tracking ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
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
  }, [doc, mode, pageCount, scale]);

  // ---------- Ctrl + wheel zoom (window-level, anchored at cursor) ----------
  useEffect(() => {
    let raf = 0;
    let pendingFactor = 1;
    let lastX = 0;
    let lastY = 0;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      pendingFactor *= e.deltaY < 0 ? 1.1 : 1 / 1.1;
      lastX = e.clientX;
      lastY = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const oldScale = scaleRef.current;
        const newScale = Math.min(4, Math.max(0.3, oldScale * pendingFactor));
        pendingFactor = 1;
        const el = scrollRef.current;
        const rect = el?.getBoundingClientRect();
        const anchorX = rect && el ? lastX - rect.left + el.scrollLeft : 0;
        const anchorY = rect && el ? lastY - rect.top + el.scrollTop : 0;
        scaleRef.current = newScale;
        setScale(newScale);
        if (el && rect) {
          requestAnimationFrame(() => {
            el.scrollLeft = (anchorX * newScale) / oldScale - (lastX - rect.left);
            el.scrollTop = (anchorY * newScale) / oldScale - (lastY - rect.top);
          });
        }
      });
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => {
      window.removeEventListener('wheel', handler);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // ---------- shortcuts ----------
  const scrollToPage = useCallback((n: number) => {
    const pageEl = pageRefs.current.get(n);
    if (pageEl) {
      // 即时跳转（auto）：书签/恢复/翻页应立刻定位，不依赖平滑滚动
      pageEl.scrollIntoView({ block: 'start' });
      return;
    }
    // 目标页尚未渲染（大 PDF 只渲染视口附近页面）：按估算高度滚动触发渲染，
    // 渲染完成后轮询精确对齐，保证“跳转”到任意页码都可用
    const el = scrollRef.current;
    if (!el || !baseH || !scale) return;
    el.scrollTop = Math.max(0, Math.round((n - 1) * (baseH * scale + 16)));
    let tries = 0;
    const align = () => {
      const p = pageRefs.current.get(n);
      if (p) {
        p.scrollIntoView({ block: 'start' });
        return;
      }
      if (++tries < 30) requestAnimationFrame(align);
    };
    requestAnimationFrame(align);
  }, [baseH, scale]);

  // 同步当前页到全局（信息面板书签高亮）
  useEffect(() => {
    if (paneActive) setStoreCurrentPage(currentPage);
  }, [currentPage, setStoreCurrentPage, paneActive]);

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

  // ---------- text selection -> highlight ----------
  const handleMouseUp = () => {
    if (!highlightMode || !doc) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;

    const byPage = new Map<number, Quad[]>();
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const node = range.commonAncestorContainer;
      const el = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null;
      const pageEl = el?.closest('[data-page-number]') as HTMLElement | null;
      if (!pageEl) return;
      const page = Number(pageEl.getAttribute('data-page-number'));
      const vp = viewportsRef.current.get(page);
      if (!vp) return;
      const pageRect = pageEl.getBoundingClientRect();
      const quads: Quad[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 1) continue;
        const [px1, py1] = vp.convertToPdfPoint(r.left - pageRect.left, r.top - pageRect.top);
        const [px2, py2] = vp.convertToPdfPoint(r.right - pageRect.left, r.bottom - pageRect.top);
        quads.push({
          x: Math.min(px1, px2),
          y: Math.min(py1, py2),
          w: Math.abs(px2 - px1),
          h: Math.abs(py2 - py1),
        });
      }
      if (!quads.length) return;
      byPage.set(page, [...(byPage.get(page) ?? []), ...quads]);
    }
    // 同一行的碎片合并成整块，避免“三个字被拆成三块”
    for (const [page, quads] of byPage) {
      byPage.set(page, mergeLineQuads(quads));
    }

    void (async () => {
      try {
        for (const [page, quads] of byPage) {
          await window.pkm.createAnnotation({
            pdfId: pdf.id,
            page,
            content: text,
            note: '',
            position: JSON.stringify(quads),
            color: highlightColor,
          });
        }
        sel.removeAllRanges();
        setAnnotations(await window.pkm.listAnnotations(pdf.id));
        setInspectorTab('annotations');
        toast(
          'success',
          t('toolbar.highlighted', {
            multi: byPage.size > 1 ? t('toolbar.highlighted.multi', { n: byPage.size }) : '',
          }),
        );
      } catch (err) {
        toast('error', terr(err instanceof Error ? err.message : String(err)));
      }
    })();
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

  const pages: number[] = Array.from({ length: pageCount }, (_, i) => i + 1);
  const pageRows: number[][] = [];
  for (let i = 0; i < pages.length; i += 2) pageRows.push(pages.slice(i, i + 2));

  const renderPage = (n: number) => (
    <PdfPage
      key={`${pdf.id}-${n}`}
      doc={doc!}
      pdfId={pdf.id}
      pageNumber={n}
      scale={scale}
      renderer={pdfiumInfo ? 'pdfium' : 'pdfjs'}
      annotations={annotationsByPage.get(n) ?? []}
      searchMatches={searchByPage.get(n) ?? []}
      selectedAnnotationId={selectedAnnotationId}
      linkService={linkService}
      onAnnotationClick={handleAnnotationClick}
      onAnnotationContextMenu={(a, x, y) => setAnnMenu({ a, x, y })}
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

        {doc ? (
          <div
            ref={scrollRef}
            data-pan-scroll
            className={`flex h-full overflow-auto bg-[var(--app-canvas)] ${
              panning
                ? 'cursor-grabbing select-none'
                : canPan && !highlightMode && !screenshotMode
                  ? 'cursor-grab'
                  : ''
            }`}
            title={
              canPan && !highlightMode && !screenshotMode && !panning
                ? t('viewer.dragToPan')
                : undefined
            }
            onMouseDown={onPanMouseDown}
            onMouseUp={handleMouseUp}
          >
            {/* m-auto：内容小于视口时居中；超出视口时自动贴左贴顶，保证四边都能滚动到 */}
            <div
              ref={contentRef}
              className="m-auto flex w-max max-w-full flex-col gap-2 px-4 py-3"
            >
              {mode === 'single'
                ? pages.map((n) => <div key={n} className="mx-auto">{renderPage(n)}</div>)
                : pageRows.map((row, i) => (
                    <div key={i} className="mx-auto flex items-start justify-center gap-1.5">
                      {row.map(renderPage)}
                    </div>
                  ))}
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

/**
 * 把同一行的多个小矩形合并成一个连续高亮块（类似 Edge 的选词效果）。
 * PDF.js 文本层是逐字绝对定位的，直接取 selection 会把“三个字”拆成三块；
 * 这里按垂直重叠分组，每组取外接矩形，整行/整块只高亮一次。
 */
function mergeLineQuads(quads: Quad[]): Quad[] {
  if (quads.length < 2) return quads;
  const sorted = [...quads].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: Quad[][] = [];
  for (const q of sorted) {
    const g = groups.find((grp) => {
      const gMinY = Math.min(...grp.map((x) => x.y));
      const gMaxY = Math.max(...grp.map((x) => x.y + x.h));
      return q.y < gMaxY && q.y + q.h > gMinY;
    });
    if (g) g.push(q);
    else groups.push([q]);
  }
  return groups.map((grp) => {
    const minX = Math.min(...grp.map((x) => x.x));
    const minY = Math.min(...grp.map((x) => x.y));
    const maxX = Math.max(...grp.map((x) => x.x + x.w));
    const maxY = Math.max(...grp.map((x) => x.y + x.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  });
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
