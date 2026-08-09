import React, { useEffect, useRef, useState } from 'react';
import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist';
import type { AnnotationRecord, Quad } from '../../shared/types';
import {
  getCachedPage,
  pageCacheKey,
  putCachedPage,
  scaleBucket,
  toImageBitmap,
} from '../../lib/pageImageCache';
import { pdfiumRenderQueued } from '../../lib/pdfiumBatcher';
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
  doc: PDFDocumentProxy;
  pdfId: number;
  pageNumber: number;
  scale: number;
  /** 2.0.0：pdfium = PDFium 出像素 + PDF.js 文本层；pdfjs = 纯 PDF.js 回退 */
  renderer: 'pdfium' | 'pdfjs';
  annotations: AnnotationRecord[];
  searchMatches: SearchMatch[];
  selectedAnnotationId: number | null;
  linkService: PdfLinkService;
  onAnnotationClick: (a: AnnotationRecord) => void;
  onAnnotationContextMenu: (a: AnnotationRecord, x: number, y: number) => void;
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
  pageNumber,
  scale,
  renderer,
  annotations,
  searchMatches,
  selectedAnnotationId,
  linkService,
  onAnnotationClick,
  onAnnotationContextMenu,
  registerPage,
  registerViewport,
}: PdfPageProps) {
  const t = useT();
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [visible, setVisible] = useState(false);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState(false);
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
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const vp = page.getViewport({ scale });
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
  }, [doc, pageNumber, scale, visible, registerViewport]);

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
  }, [viewport, renderer]);

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
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, cssW, cssH);
  }

  /** 文本层 + 链接层（PDF.js，两套渲染路径共用） */
  async function renderTextAndAnnots(vp: PageViewport, seq: number): Promise<void> {
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

    const annotationsList = await page.getAnnotations();
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

    // 1) 同质量（同缩放桶）缓存直接复用
    const bucket = scaleBucket(deviceScale);
    const hiKey = pageCacheKey(pdfId, pageNumber, bucket);
    const hi = getCachedPage(hiKey);
    if (hi) {
      paintBitmap(hi, cssW, cssH);
      hasRenderedRef.current = true;
      // 位图命中缓存时仍需渲染文本层/链接层（选词、高亮、交叉引用）
      await renderTextAndAnnots(vp, seq);
      return;
    }

    // 2) 低清先行：约 40% 目标分辨率，立即出画面
    const lowScale = Math.max(0.4, deviceScale * 0.4);
    const lowKey = pageCacheKey(pdfId, pageNumber, scaleBucket(lowScale));
    let low = getCachedPage(lowKey);
    if (!low) {
      try {
        const res = await pdfiumRenderQueued(pdfId, pageNumber, lowScale);
        if (seq !== renderSeqRef.current) return;
        low = await toImageBitmap(res);
        putCachedPage(lowKey, low, res.w, res.h);
      } catch (err) {
        if (seq === renderSeqRef.current) {
          // PDFium 渲染失败 → 回退 PDF.js 渲染该页
          await renderWithPdfjs(vp);
        }
        return;
      }
    }
    if (seq !== renderSeqRef.current) return;
    paintBitmap(low, cssW, cssH);

    // 3) 高清渐进：60ms 防抖，避免缩放过程中重复渲染
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      const seq2 = renderSeqRef.current;
      try {
        const res = await pdfiumRenderQueued(pdfId, pageNumber, deviceScale);
        if (seq2 !== renderSeqRef.current) return;
        const bmp = await toImageBitmap(res);
        putCachedPage(hiKey, bmp, res.w, res.h);
        if (seq2 !== renderSeqRef.current) return;
        paintBitmap(bmp, cssW, cssH);
        hasRenderedRef.current = true;
        await renderTextAndAnnots(vp, seq2);
      } catch {
        if (seq2 === renderSeqRef.current) setRenderError(true);
      }
    }, 60);
  }

  /** PDF.js 回退路径：原有渲染逻辑 */
  async function renderWithPdfjs(vp: PageViewport): Promise<void> {
    const seq = ++renderSeqRef.current;
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
      await renderTextAndAnnots(vp, seq);
    } catch {
      if (seq === renderSeqRef.current) setRenderError(true);
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
      style={{ width: viewport?.width ?? 0, height: viewport?.height ?? 0 }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textRef} className="textLayer" />
      <div ref={annRef} className="annotationLayer" />

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
                title={a.content || `Page ${pageNumber} highlight`}
              />
            );
          }),
        )}

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
    </div>
  );
}
