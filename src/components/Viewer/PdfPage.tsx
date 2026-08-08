import React, { useEffect, useRef, useState } from 'react';
import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist';
import type { AnnotationRecord, Quad } from '../../shared/types';
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
  pageNumber: number;
  scale: number;
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
 * Zoom is split into two phases for smoothness:
 * 1. layout (immediate): resize the sheet/canvas and let the browser stretch the
 *    existing pixels while the user keeps scrolling;
 * 2. high-res render (debounced ~220ms): re-render canvas + text layer +
 *    annotation layer (internal links / cross references) once zoom settles.
 */
export function PdfPage({
  doc,
  pageNumber,
  scale,
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
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        void renderHighRes(vp);
      },
      hasRenderedRef.current ? 150 : 0,
    );
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
  }, [viewport]);

  async function renderHighRes(vp: PageViewport): Promise<void> {
    const seq = ++renderSeqRef.current;
    try {
      const page = await doc.getPage(pageNumber);
      if (seq !== renderSeqRef.current) return;
      const dpr = window.devicePixelRatio || 1;
      // 超采样：dpr 较低时额外放大 1.5x 渲染，让文字更锐利
      const overscan = dpr >= 2 ? 1 : 1.5;
      const renderScale = vp.scale * dpr * overscan;
      const renderViewport = page.getViewport({ scale: renderScale });
      // 先渲染到离屏画布，完成后再贴回，避免取消/失败时出现空白或模糊中间态
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
      const text = textRef.current;
      const ann = annRef.current;
      if (!canvas || !text || !ann) return;
      canvas.width = offscreen.width;
      canvas.height = offscreen.height;
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      const dctx = canvas.getContext('2d');
      if (!dctx) return;
      dctx.drawImage(offscreen, 0, 0);
      hasRenderedRef.current = true;

      // Text layer (selection / search / highlight)
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

      // Annotation layer (internal links / cross references)
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
    } catch {
      // 仅当未被新一轮渲染取代时才提示渲染失败（取消渲染不算失败）
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
                title={a.content || `Page ${a.page} highlight`}
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
