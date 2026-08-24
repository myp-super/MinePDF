import { BookOpen, Copy, GripHorizontal, RefreshCw, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { TranslationErrorPayload, TranslationResult } from '../../shared/types';

export type TranslationPopupStatus =
  | { kind: 'confirm'; length: number }
  | { kind: 'loading' }
  | { kind: 'success'; result: TranslationResult }
  | { kind: 'error'; error: TranslationErrorPayload };

export function TranslationPopup({
  x,
  y,
  status,
  onClose,
  onConfirm,
  onRetry,
  onCopy,
  onAddToNote,
}: {
  x: number;
  y: number;
  status: TranslationPopupStatus;
  onClose: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onCopy: () => void;
  onAddToNote: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = Math.min(380, window.innerWidth - 16);
  const clampPosition = (left: number, top: number) => ({
    left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - (ref.current?.offsetHeight ?? 330) - 8)),
  });
  const [position, setPosition] = useState(() => clampPosition(x, y));
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  useEffect(() => {
    setPosition(clampPosition(x, y));
    // Position is reset only when a new popup anchor is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPosition((current) => clampPosition(current.left, current.top)));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onResize = () => setPosition((current) => clampPosition(current.left, current.top));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const height = ref.current?.offsetHeight ?? 80;
    setPosition({
      left: Math.max(8, Math.min(event.clientX - drag.dx, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(event.clientY - drag.dy, window.innerHeight - height - 8)),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const style: React.CSSProperties = {
    width,
    left: position.left,
    top: position.top,
  };
  return (
    <div ref={ref} className="fixed z-[82] overflow-hidden rounded-lg border border-app-border bg-app-panel shadow-2xl" style={style}>
      <div className="flex h-9 cursor-move touch-none select-none items-center justify-between border-b border-app-border px-3" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-app-text"><GripHorizontal size={13} className="text-app-muted" /> Academic Translation</span>
        <button className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted hover:bg-app-panel2 hover:text-app-text" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="max-h-56 min-h-24 overflow-y-auto px-3 py-3">
        {status.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[12px] text-app-muted">
            <RefreshCw size={13} className="animate-spin" /> Translating...
          </div>
        )}
        {status.kind === 'confirm' && (
          <div>
            <p className="text-[12px] leading-relaxed text-app-text">Selected text is long ({status.length.toLocaleString()} characters). Translate this section?</p>
            <p className="mt-2 text-[10.5px] leading-relaxed text-app-muted">Only the selected text and optional nearby context will be sent to the configured provider.</p>
          </div>
        )}
        {status.kind === 'success' && (
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-6 text-app-text">{status.result.translatedText}</p>
        )}
        {status.kind === 'error' && (
          <div>
            <p className="text-[12px] font-medium text-app-danger">Translation failed</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-app-muted">{status.error.message}</p>
          </div>
        )}
      </div>
      <div className="flex min-h-9 items-center justify-end gap-2 border-t border-app-border px-2.5 py-1.5">
        <div className="flex shrink-0 items-center gap-1">
          {status.kind === 'confirm' && (
            <button className="h-7 rounded-md bg-app-accent px-2.5 text-[10.5px] font-medium text-white" onClick={onConfirm}>Translate</button>
          )}
          {status.kind === 'success' && (
            <>
              <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-muted hover:bg-app-panel2 hover:text-app-text" onClick={onCopy}><Copy size={12} /> Copy</button>
              <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-muted hover:bg-app-panel2 hover:text-app-text" onClick={onAddToNote}><BookOpen size={12} /> Add to Note</button>
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-app-muted hover:bg-app-panel2 hover:text-app-text" title="Retry" onClick={onRetry}><RefreshCw size={12} /></button>
            </>
          )}
          {status.kind === 'error' && status.error.retryable && (
            <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-muted hover:bg-app-panel2 hover:text-app-text" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
          )}
        </div>
      </div>
    </div>
  );
}
