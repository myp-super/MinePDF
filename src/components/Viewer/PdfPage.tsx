import React, { useEffect, useRef, useState } from 'react';
import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist';
import type { AnnotationRecord, PdfiumLink, Quad } from '../../shared/types';
import {
  effectiveRenderBucket,
  getCachedPage,
  pageCacheKey,
  putCachedPage,
  toImageBitmap,
} from '../../lib/pageImageCache';
import { pdfiumRenderQueued } from '../../lib/pdfiumBatcher';
import { renderDiag } from '../../lib/renderDiag';
import { hexToRgba, pdfjsLib, type SearchMatch, type ViewportLike } from '../../lib/pdf';
import { useT } from '../../i18n';

/** Minimal link service used by the PDF.js annotation layer. */
export interface PdfLinkService {
  externalLinkEnabled: boolean;
  getDestinationHash(dest: unknown): string;
  getAnchorUrl(hash: string): string;
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void;
  goToDestination(dest: unknown): Promise<void>;
}

interface PdfPageProps {
  /** pdf.js 文档代理；首次渲染时可能尚未就绪（先由 PDFium 出像素） */
  doc: PDFDocumentProxy | null;
  pdfId: number;
  /** 阅读屏唯一标识（分屏渲染请求隔离） */
  paneId: string;
  pageNumber: number;
  scale: number;
  /** 2.0.0：pdfium = PDFium 出像素 + PDF.js 文本层；pdfjs = 纯 PDF.js 回退 */
  renderer: 'pdfium' | 'pdfjs';
  annotations: AnnotationRecord[];
  searchMatches: SearchMatch[];
  selectedAnnotationId: number | null;
  /** 拖拽高亮实时预览（PDF 坐标，未提交） */
  liveHighlights?: Quad[];
  highlightColor: string;
  /** 普通模式拖拽选区的实时预览颜色 */
  liveHighlightsColor?: string;
  /** 普通模式已选中的连续选区（PDF 坐标，蓝色） */
  selectionQuads?: Quad[];
  linkService: PdfLinkService;
  /** PDFium 已给出的页面物理尺寸（doc 未就绪时用于占位布局） */
  fallbackW: number | null;
  fallbackH: number | null;
  onAnnotationClick: (a: AnnotationRecord) => void;
  onAnnotationContextMenu: (a: AnnotationRecord, x: number, y: number) => void;
  /** 点击高亮上的标注圆点 -> 打开标注弹窗 */
  onAnnotationNote?: (a: AnnotationRecord, x: number, y: number) => void;
  /** 点击页内链接时跳转到目标页（1 起） */
  onJumpToPage?: (n: number) => void;
  registerPage: (n: number, el: HTMLDivElement | null) => void;
  registerViewport: (n: number, vp: ViewportLike | null) => void;
}

function parseQuads(position: string): Quad[] {
  try {
    const data = JSON.parse(position) as Quad[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Single page render.
 *
 * 2.0.0 混合架构：
 * - PDFium 路径：低清位图先行（立即出画面）→ 高清位图渐进替换（60ms 防抖），
 *   位图缓存按 0.5 缩放桶复用；PDF.js 只负责文本层（选词/搜索/高亮定位）与
 *   链接层（交叉引用跳转）。渲染失败自动回退 PDF.js。
 * - PDF.js 路径：原有双阶段（布局 + 150ms 防抖高清渲染）。
 */
export function PdfPage({
  doc,
  pdfId,
  paneId,
  pageNumber,
  scale,
  renderer,
  annotations,
  searchMatches,
  selectedAnnotationId,
  liveHighlights,
  highlightColor,
  liveHighlightsColor,
  selectionQuads,
  linkService,
  fallbackW,
  fallbackH,
  onAnnotationClick,
  onAnnotationContextMenu,
  onAnnotationNote,
  onJumpToPage,
  registerPage,
  registerViewport,
}: PdfPageProps) {
  const t = useT();
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [visible, setVisible] = useState(false);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState(false);
  const [pending, setPending] = useState(false);
  /** 标注圆点悬停气泡（即时出现，替代原生 title 的慢延迟） */
  const [noteTip, setNoteTip] = useState<{ x: number; y: number; text: string } | null>(null);
  /** PDFium 原生提取的链接矩形：首帧位图渲染时即可点击，不依赖 pdf.js 解析 */
  const [links, setLinks] = useState<PdfiumLink[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const annRef = useRef<HTMLDivElement>(null);
  const hasRenderedRef = useRef(false);
  const renderSeqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasTaskRef = useRef<{ cancel: () => void } | null>(null);
  const textTaskRef = useRef<{ cancel: () => void } | null>(null);
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;

  // 原生链接层：PDFium 打开即提取（结果在主进程缓存，滚动回来零成本）
  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    window.pkm
      .pdfiumLinks(pdfId, pageNumber)
      .then((ls) => {
        if (!cancelled) setLinks(ls);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdfId, pageNumber]);

  // Visible-area detection (small preload margin keeps switching fast)
  useEffect(() => {
    const el = wrapEl;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: '80px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [wrapEl]);

  // Viewport: re-derive on scale change (cheap), then layout + schedule render
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let vp: PageViewport | null = null;
        if (doc) {
          const page = await doc.getPage(pageNumber);
          if (cancelled) return;
          vp = page.getViewport({ scale });
        } else if (fallbackW != null && fallbackH != null) {
          // PDFium 已给出页面尺寸：先用它布局占位，等 pdf.js 就绪后换真实 viewport
          // （尺寸已含旋转，无旋转时 convertToViewportPoint 即按比例缩放）
          vp = {
            width: fallbackW * scale,
            height: fallbackH * scale,
            scale,
            convertToViewportPoint: (x: number, y: number) => [
              x * scale,
              (fallbackH - y) * scale,
            ],
            convertToPdfPoint: (x: number, y: number) => [
              x / scale,
              fallbackH - y / scale,
            ],
          } as PageViewport;
        }
        if (!vp) return;
        setViewport(vp);
        registerViewport(pageNumber, vp);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      registerViewport(pageNumber, null);
    };
  }, [doc, pageNumber, scale, registerViewport, fallbackW, fallbackH]);

  // Layout + high-res render scheduling
  useEffect(() => {
    const vp = viewport;
    if (!vp) return;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
    }
    setRenderError(false);
    if (renderer === 'pdfium') {
      // PDFium 路径：立即启动低清先行渲染（内部再防抖高清）
      void renderPdfium(vp);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => {
          timerRef.current = null;
          void renderWithPdfjs(vp);
        },
        hasRenderedRef.current ? 150 : 0,
      );
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      renderSeqRef.current++;
      try {
        canvasTaskRef.current?.cancel();
      } catch {
        /* ignore */
      }
      try {
        textTaskRef.current?.cancel();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, renderer, doc]);

  /** 把位图按 CSS 尺寸绘制到页面 canvas */
  function paintBitmap(bitmap: ImageBitmap, cssW: number, cssH: number): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // 1:1 填满画布内部（内部尺寸 = 位图尺寸），CSS 缩放由浏览器处理。
    // 之前误用 cssW/cssH 作为目标尺寸，导致内容被压缩到左上 2/3 区域。
    // 位图始终 ≥ 显示所需像素，只会缩小/1:1 显示；平滑设置用于兜底一致渲染。
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0);
  }

  /** 记录当前页面渲染链路的真实数据（调试用，未开启时不产生 UI 开销） */
  function recordDiag(input: {
    baseW: number;
    baseH: number;
    zoom: number;
    dpr: number;
    bucket: number;
    cacheHit: boolean;
    renderMs: number;
    engine: 'pdfium' | 'pdfjs';
  }): void {
    if (!renderDiag.getState().enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    renderDiag.record({
      pageNumber,
      engine: input.engine,
      baseW: input.baseW,
      baseH: input.baseH,
      zoom: input.zoom,
      dpr: input.dpr,
      deviceScale: input.zoom * input.dpr,
      bucket: input.bucket,
      cacheHit: input.cacheHit,
      renderMs: input.renderMs,
      bitmapW: canvas.width,
      bitmapH: canvas.height,
      canvasBackingW: canvas.width,
      canvasBackingH: canvas.height,
      canvasClientW: canvas.clientWidth,
      canvasClientH: canvas.clientHeight,
      rectW: rect.width,
      rectH: rect.height,
      densityX: rect.width > 0 ? canvas.width / rect.width : 0,
      densityY: rect.height > 0 ? canvas.height / rect.height : 0,
      ts: Date.now(),
    });
  }

  /** 文本层 + 链接层（PDF.js，两套渲染路径共用） */
  async function renderTextAndAnnots(vp: PageViewport, seq: number): Promise<void> {
    if (!doc) return; // pdf.js 文档尚未就绪：先保持纯 PDFium 位图，就绪后本 effect 会重跑
    const page = await doc.getPage(pageNumber);
    if (seq !== renderSeqRef.current) return;
    const text = textRef.current;
    const ann = annRef.current;
    if (!text || !ann) return;

    const tc = await page.getTextContent();
    if (seq !== renderSeqRef.current) return;
    text.textContent = '';
    const layer = new pdfjsLib.TextLayer({
      textContentSource: tc,
      container: text,
      viewport: vp,
    });
    textTaskRef.current = layer;
    await layer.render();
    if (seq !== renderSeqRef.current) return;

    // PDFium 路径下链接由原生层渲染（首帧即用），跳过 pdf.js 的 Link 注解避免重复
    const annotationsList = (await page.getAnnotations()).filter(
      (a) => renderer !== 'pdfium' || a.subtype !== 'Link',
    );
    if (seq !== renderSeqRef.current) return;
    ann.textContent = '';
    const annLayer = new pdfjsLib.AnnotationLayer({
      div: ann,
      page,
      viewport: vp,
    } as never);
    await annLayer.render({
      div: ann,
      annotations: annotationsList,
      page,
      viewport: vp,
      linkService: linkService as never,
      renderForms: false,
    } as never);
  }

  /** PDFium 路径：低清先行 → 高清渐进（带缓存与取消） */
  async function renderPdfium(vp: PageViewport): Promise<void> {
    const seq = ++renderSeqRef.current;
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.floor(vp.width);
    const cssH = Math.floor(vp.height);
    const deviceScale = vp.scale * dpr;
    // 页面物理尺寸（pt）：用于与主进程同一公式计算渲染倍率上限，
    // 保证缓存键与真实渲染尺寸一致
    const pagePtW = vp.width / vp.scale;
    const pagePtH = vp.height / vp.scale;
    // 仅首次渲染显示加载动画；缩放/切回时的再渲染直接复用旧位图拉伸过渡
    setPending(!hasRenderedRef.current);

    // 1) 同渲染桶缓存直接复用（渲染倍率 ≥ 显示倍率，只会缩小显示，不发虚）
    const bucket = effectiveRenderBucket(deviceScale, pagePtW, pagePtH);
    const hiKey = pageCacheKey(pdfId, pageNumber, bucket);
    const hi = getCachedPage(hiKey);
    if (hi) {
      setPending(false);
      paintBitmap(hi, cssW, cssH);
      hasRenderedRef.current = true;
      recordDiag({
        baseW: pagePtW,
        baseH: pagePtH,
        zoom: vp.scale,
        dpr,
        bucket,
        cacheHit: true,
        renderMs: 0,
        engine: 'pdfium',
      });
      // 位图命中缓存时仍需渲染文本层/链接层（选词、高亮、交叉引用）
      await renderTextAndAnnots(vp, seq);
      return;
    }

    // 2) 高清直接渲染（PDFium 单页 ~10ms）：首次立即，缩放时 180ms 防抖，
    //    过渡期由浏览器把旧位图拉伸到新尺寸（自然、不跳变）
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      const seq2 = renderSeqRef.current;
      try {
        const res = await pdfiumRenderQueued(paneId, pdfId, pageNumber, bucket);
        if (seq2 !== renderSeqRef.current) return;
        const bmp = await toImageBitmap(res);
        putCachedPage(hiKey, bmp, res.w, res.h);
        if (seq2 !== renderSeqRef.current) return;
        paintBitmap(bmp, cssW, cssH);
        hasRenderedRef.current = true;
        setPending(false);
        recordDiag({
          baseW: pagePtW,
          baseH: pagePtH,
          zoom: vp.scale,
          dpr,
          bucket,
          cacheHit: false,
          renderMs: res.ms,
          engine: 'pdfium',
        });
        await renderTextAndAnnots(vp, seq2);
      } catch {
        if (seq2 === renderSeqRef.current) {
          // PDFium 渲染失败 → 回退 PDF.js 渲染该页
          setPending(false);
          await renderWithPdfjs(vp);
        }
      }
    }, hasRenderedRef.current ? 180 : 0);
  }

  /** PDF.js 回退路径：原有渲染逻辑 */
  async function renderWithPdfjs(vp: PageViewport): Promise<void> {
    if (!doc) return;
    const seq = ++renderSeqRef.current;
    setPending(true);
    try {
      const page = await doc.getPage(pageNumber);
      if (seq !== renderSeqRef.current) return;
      const dpr = window.devicePixelRatio || 1;
      const overscan = dpr >= 2 ? 1 : 1.5;
      const renderScale = vp.scale * dpr * overscan;
      const renderViewport = page.getViewport({ scale: renderScale });
      const offscreen = document.createElement('canvas');
      offscreen.width = Math.floor(renderViewport.width);
      offscreen.height = Math.floor(renderViewport.height);
      const ctx = offscreen.getContext('2d');
      if (!ctx) return;
      const task = page.render({ canvasContext: ctx, viewport: renderViewport });
      canvasTaskRef.current = task;
      await task.promise;
      if (seq !== renderSeqRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = offscreen.width;
      canvas.height = offscreen.height;
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      const dctx = canvas.getContext('2d');
      if (!dctx) return;
      dctx.drawImage(offscreen, 0, 0);
      hasRenderedRef.current = true;
      setPending(false);
      const dprDiag = window.devicePixelRatio || 1;
      recordDiag({
        baseW: vp.width / vp.scale,
        baseH: vp.height / vp.scale,
        zoom: vp.scale,
        dpr: dprDiag,
        bucket: renderScale,
        cacheHit: false,
        renderMs: 0,
        engine: 'pdfjs',
      });
      await renderTextAndAnnots(vp, seq);
    } catch {
      if (seq === renderSeqRef.current) {
        setPending(false);
        setRenderError(true);
      }
    }
  }

  return (
    <div
      ref={(el) => {
        setWrapEl(el);
        registerPage(pageNumber, el);
      }}
      data-page-number={pageNumber}
      data-renderer={renderer}
      className="pdf-page-sheet relative shrink-0 overflow-hidden rounded-[2px]"
      style={{
        width: viewport ? Math.floor(viewport.width) : 0,
        height: viewport ? Math.floor(viewport.height) : 0,
      }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textRef} className="textLayer" />
      <div ref={annRef} className="annotationLayer" />

      {/* PDFium 原生链接层：首帧位图渲染即出现，点击跳转/打开外链，不依赖 pdf.js */}
      {viewport &&
        links.map((l, i) => {
          const [lx, ly] = viewport.convertToViewportPoint(l.x, l.y + l.h);
          const [rx, ry] = viewport.convertToViewportPoint(l.x + l.w, l.y);
          return (
            <div
              key={`pl-${i}`}
              className="pdf-link-overlay"
              data-url={l.url}
              data-dest-page={l.destPage}
              onClick={(e) => {
                e.stopPropagation();
                if (l.url) void window.pkm.openExternalUrl(l.url).catch(() => undefined);
                else if (l.destPage) onJumpToPage?.(l.destPage);
              }}
              style={{
                left: lx,
                top: ly,
                width: Math.max(1, rx - lx),
                height: Math.max(1, ry - ly),
              }}
            />
          );
        })}

      {/* 渲染中的动态加载动画（避免大文件黑屏） */}
      {pending && !renderError && (
        <div className="pdf-loading-overlay" data-testid="pdf-loading">
          <div className="pdf-loading">
            {/* 相对路径：file:// 协议下绝对路径会解析到磁盘根目录导致加载失败 */}
            <img src="./logo.svg" alt="" className="pdf-loading-logo" draggable={false} />
            <span className="pdf-loading-ring" />
          </div>
        </div>
      )}

      {/* Highlight overlay. PDF y-axis points UP, so the top edge is q.y + q.h. */}
      {viewport &&
        annotations.map((a) =>
          parseQuads(a.position).map((q, i) => {
            const [left, top] = viewport.convertToViewportPoint(q.x, q.y + q.h);
            const [right, bottom] = viewport.convertToViewportPoint(q.x + q.w, q.y);
            return (
              <div
                key={`${a.id}-${i}`}
                className={
                  selectedAnnotationId === a.id ? 'annotation-hl selected' : 'annotation-hl'
                }
                style={{
                  left,
                  top,
                  width: Math.max(1, right - left),
                  height: Math.max(1, bottom - top),
                  background: hexToRgba(a.color, 0.35),
                }}
                onClick={() => onAnnotationClick(a)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onAnnotationContextMenu(a, e.clientX, e.clientY);
                }}
              >
                {/* 有标注的高亮：首字上方同色圆点，悬停显示标注 */}
                {i === 0 && a.note ? (
                  <span
                    className="annotation-dot"
                    style={{ background: a.color }}
                    onMouseEnter={(e) =>
                      setNoteTip({ x: e.clientX, y: e.clientY, text: a.note ?? '' })
                    }
                    onMouseLeave={() => setNoteTip(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNoteTip(null);
                      onAnnotationNote?.(a, e.clientX, e.clientY);
                    }}
                  />
                ) : null}
              </div>
            );
          }),
        )}

      {/* 拖拽选区实时预览：高亮模式荧光笔色 / 普通模式选中蓝（未提交，pointer-events 穿透） */}
      {viewport &&
        liveHighlights?.map((q, i) => {
          const [left, top] = viewport.convertToViewportPoint(q.x, q.y + q.h);
          const [right, bottom] = viewport.convertToViewportPoint(q.x + q.w, q.y);
          return (
            <div
              key={`lh-${i}`}
              className="live-highlight"
              style={{
                left,
                top,
                width: Math.max(1, right - left),
                height: Math.max(1, bottom - top),
                background: hexToRgba(liveHighlightsColor ?? highlightColor, 0.38),
              }}
            />
          );
        })}

      {/* 普通模式已选中的连续选区（蓝色，仿 Edge 选词） */}
      {viewport &&
        selectionQuads?.map((q, i) => {
          const [left, top] = viewport.convertToViewportPoint(q.x, q.y + q.h);
          const [right, bottom] = viewport.convertToViewportPoint(q.x + q.w, q.y);
          return (
            <div
              key={`sel-${i}`}
              className="selection-highlight"
              style={{
                left,
                top,
                width: Math.max(1, right - left),
                height: Math.max(1, bottom - top),
              }}
            />
          );
        })}

      {/* Search hit overlay */}
      {viewport &&
        searchMatches.map((m, mi) =>
          m.quads.map((q, qi) => {
            const [left, top] = viewport.convertToViewportPoint(q.x, q.y + q.h);
            const [right, bottom] = viewport.convertToViewportPoint(q.x + q.w, q.y);
            return (
              <div
                key={`s-${mi}-${qi}`}
                className="search-hl"
                style={{
                  left,
                  top,
                  width: Math.max(1, right - left),
                  height: Math.max(1, bottom - top),
                }}
              />
            );
          }),
        )}

      {renderError && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-app-canvas px-6 text-center text-[11px] text-app-muted">
          {t('viewer.renderFailed')}
        </div>
      )}

      {/* 标注圆点悬停气泡 */}
      {noteTip && (
        <div
          className="fixed z-[90] max-w-[260px] rounded-lg border border-app-border bg-app-panel px-2.5 py-1.5 text-[11px] leading-relaxed text-app-text shadow-2xl"
          style={{ left: noteTip.x + 12, top: noteTip.y + 12 }}
        >
          {noteTip.text}
        </div>
      )}
    </div>
  );
}
