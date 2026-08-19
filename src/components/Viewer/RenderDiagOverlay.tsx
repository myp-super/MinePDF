import React, { useEffect, useRef, useState } from 'react';
import { renderDiag, type RenderDiagState } from '../../lib/renderDiag';
import type { RenderDiagInfo } from '../../shared/types';

/**
 * PDF 渲染运行时诊断浮层（默认关闭；Ctrl+Shift+D 切换）。
 * 展示当前可见页的真实链路数据：bitmap / canvas 背板 / CSS 显示尺寸 / DPR / 主进程缩放。
 * 关键判断：bitmap 像素 ÷ CSS 显示像素（density）应 ≥ window.devicePixelRatio；
 * 若小于 dpr，说明位图被放大了（发虚的直接证据）。
 */
export function RenderDiagOverlay() {
  const [state, setState] = useState<RenderDiagState>(renderDiag.getState());
  const [main, setMain] = useState<RenderDiagInfo | null>(null);
  /** 拖拽后的面板位置（null = 默认右下角） */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onHeaderDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({ x: ev.clientX - d.dx, y: ev.clientY - d.dy });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => renderDiag.subscribe(setState), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        renderDiag.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (state.enabled && !main) {
      window.pkm
        .getRenderDiag()
        .then(setMain)
        .catch(() => undefined);
    }
  }, [state.enabled, main]);

  if (!state.enabled) return null;
  const d = state.latest;
  const densityOk = d ? (d.densityX >= d.dpr - 0.01 ? 'text-emerald-400' : 'text-app-danger') : '';
  const zoomOk = main && main.zoomFactor != null && Math.abs(main.zoomFactor - 1) > 0.01;

  return (
    <div
      ref={panelRef}
      className={`fixed z-[120] w-[320px] rounded-lg border border-app-border bg-app-panel p-2.5 text-[10px] leading-relaxed text-app-text shadow-2xl ${
        pos ? '' : 'bottom-3 right-3'
      }`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div
        className="mb-1 flex cursor-move select-none items-center justify-between border-b border-app-border pb-1"
        onPointerDown={onHeaderDown}
        title="按住标题拖动"
      >
        <span className="text-[10.5px] font-semibold">PDF Render Debug</span>
        <button
          className="rounded px-1 text-app-muted hover:text-app-text"
          onClick={() => renderDiag.toggle()}
        >
          ✕
        </button>
      </div>
      {!d ? (
        <p className="py-1 text-center text-app-muted">打开 PDF 后滚动 / 缩放采集页面数据</p>
      ) : (
        <div className="space-y-0.5">
          <Row k="Page" v={`${d.pageNumber}  (${d.engine})`} />
          <Row k="Base(pt)" v={`${Math.round(d.baseW)} × ${Math.round(d.baseH)}`} />
          <Row k="Zoom" v={`${(d.zoom * 100).toFixed(0)}%`} />
          <Row k="DPR" v={`${d.dpr}`} />
          <Row k="deviceScale" v={`${d.deviceScale.toFixed(2)}`} />
          <Row k="bucket" v={`${d.bucket}`} />
          <Row k="Bitmap" v={`${d.bitmapW} × ${d.bitmapH}`} />
          <Row k="Canvas backing" v={`${d.canvasBackingW} × ${d.canvasBackingH}`} />
          <Row k="Canvas client" v={`${d.canvasClientW} × ${d.canvasClientH}`} />
          <Row k="getBoundingRect" v={`${Math.round(d.rectW)} × ${Math.round(d.rectH)}`} />
          <Row k="Density X / Y" v={`${d.densityX.toFixed(2)} / ${d.densityY.toFixed(2)}`} cls={densityOk} />
          <Row k="Cache / ms" v={`${d.cacheHit ? 'HIT' : 'MISS'} / ${d.renderMs.toFixed(0)}ms`} />
        </div>
      )}
      {main && (
        <div className="mt-1 space-y-0.5 border-t border-app-border pt-1">
          <Row
            k="Screen DPR"
            v={`${main.screenScaleFactor} (win: ${main.windowScaleFactor ?? '—'})`}
            cls={
              main.windowScaleFactor != null && main.windowScaleFactor !== main.screenScaleFactor
                ? 'text-app-danger'
                : ''
            }
          />
          <Row
            k="webContents zoom"
            v={`factor=${main.zoomFactor ?? '—'} level=${main.zoomLevel ?? '—'}`}
            cls={zoomOk ? 'text-app-danger' : 'text-emerald-400'}
          />
          <Row
            k="PDFium"
            v={`${main.pdfium.available ? `v${main.pdfium.version}` : 'unavailable'}`}
            title={main.pdfium.dllPath ?? ''}
          />
        </div>
      )}
      <p className="mt-1.5 border-t border-app-border pt-1 text-[9px] text-app-muted">
        Density = bitmap px ÷ CSS px；应 ≈ DPR（1:1），明显 &gt; DPR 说明被二次缩小。
      </p>
    </div>
  );
}

function Row({
  k,
  v,
  cls = '',
  title,
}: {
  k: string;
  v: string;
  cls?: string;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-app-muted">{k}</span>
      <span className={`min-w-0 truncate text-right tabular-nums ${cls || 'text-app-text/90'}`} title={title}>
        {v}
      </span>
    </div>
  );
}
