import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { useT } from '../../i18n';

export const clampPreviewScale = (value: number): number =>
  Number.isFinite(value) ? Math.min(4, Math.max(0.5, Math.round(value * 100) / 100)) : 1;

/** Keep a stable unscaled layout so images, text and formulae all magnify together. */
export function AnnotationPreview({ note, assetBase, scale, onScaleChange }: {
  note: string;
  assetBase: string | null;
  scale: number;
  onScaleChange: (value: number) => void;
}) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [baseWidth, setBaseWidth] = useState(288);
  const zoom = clampPreviewScale(scale);
  const changeRef = useRef({ zoom, onScaleChange });
  changeRef.current = { zoom, onScaleChange };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const resize = new ResizeObserver(([entry]) => setBaseWidth(Math.max(1, entry.contentRect.width - 16)));
    resize.observe(el);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const current = changeRef.current;
      current.onScaleChange(clampPreviewScale(current.zoom + (event.deltaY < 0 ? 0.25 : -0.25)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { resize.disconnect(); el.removeEventListener('wheel', wheel); };
  }, []);

  const resolveAsset = (url: string) => {
    if (/^(https?:|file:|data:|blob:)/.test(url)) return url;
    return url.startsWith('assets/') && assetBase ? `${assetBase}/${url}` : defaultUrlTransform(url);
  };

  return <div className="annotation-preview">
    <div className="annotation-preview__zoom" role="group" aria-label={t('viewer.previewZoom')}>
      <span className="mr-auto">{t('viewer.previewZoom')}</span>
      <button type="button" onClick={() => onScaleChange(clampPreviewScale(zoom - 0.25))} disabled={zoom <= 0.5} title={t('viewer.previewZoomOut')} aria-label={t('viewer.previewZoomOut')}><Minus size={13} /></button>
      <button type="button" className="annotation-preview__percent" onClick={() => onScaleChange(1)} title={t('viewer.previewZoomReset')} aria-label={t('viewer.previewZoomReset')}>{Math.round(zoom * 100)}%</button>
      <button type="button" onClick={() => onScaleChange(clampPreviewScale(zoom + 0.25))} disabled={zoom >= 4} title={t('viewer.previewZoomIn')} aria-label={t('viewer.previewZoomIn')}><Plus size={13} /></button>
    </div>
    <div ref={viewportRef} className="annotation-preview__viewport">
      <div className="annotation-preview__content md-body" style={{ width: baseWidth, zoom }}>
        {note.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} urlTransform={resolveAsset}>{note}</ReactMarkdown> : <span className="text-app-muted">{t('viewer.emptyNote')}</span>}
      </div>
    </div>
  </div>;
}
