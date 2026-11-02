import { ArrowLeftRight, BookOpen, Check, Copy, GripHorizontal, Highlighter, Loader2, RefreshCw, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
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
  sourceLanguage,
  targetLanguage,
  onClose,
  onConfirm,
  onRetry,
  onToggleLanguage,
  onCopy,
  onAddToNote,
  onAddToAnnotation,
}: {
  x: number;
  y: number;
  status: TranslationPopupStatus;
  sourceLanguage: string;
  targetLanguage: string;
  onClose: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onToggleLanguage: () => void;
  onCopy: () => void;
  onAddToNote: () => void;
  onAddToAnnotation: () => Promise<boolean>;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const minWidth = Math.min(300, window.innerWidth - 16);
  const minHeight = Math.min(176, window.innerHeight - 16);
  const [size, setSize] = useState(() => ({
    width: Math.min(380, window.innerWidth - 16),
    height: Math.min(300, window.innerHeight - 16),
  }));
  const clampPosition = (left: number, top: number, popupSize = size) => ({
    left: Math.max(8, Math.min(left, window.innerWidth - popupSize.width - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - popupSize.height - 8)),
  });
  const [position, setPosition] = useState(() => clampPosition(x, y));
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null>(null);
  const [annotationState, setAnnotationState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const annotationResultId = status.kind === 'success' ? status.result.requestId : null;

  useEffect(() => setAnnotationState('idle'), [annotationResultId]);

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
    const onResize = () => {
      setSize((current) => ({
        width: Math.min(current.width, window.innerWidth - 16),
        height: Math.min(current.height, window.innerHeight - 16),
      }));
      setPosition((current) => clampPosition(current.left, current.top));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setPosition((current) => clampPosition(current.left, current.top));
    // Keep the whole popup visible as its dimensions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

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
      left: Math.max(8, Math.min(event.clientX - drag.dx, window.innerWidth - size.width - 8)),
      top: Math.max(8, Math.min(event.clientY - drag.dy, window.innerHeight - height - 8)),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: size.width,
      height: size.height,
    };
  };

  const moveResize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    const maxWidth = Math.max(minWidth, window.innerWidth - position.left - 8);
    const maxHeight = Math.max(minHeight, window.innerHeight - position.top - 8);
    setSize({
      width: Math.max(minWidth, Math.min(resize.width + event.clientX - resize.startX, maxWidth)),
      height: Math.max(minHeight, Math.min(resize.height + event.clientY - resize.startY, maxHeight)),
    });
  };

  const endResize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const step = event.shiftKey ? 48 : 16;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    setSize((current) => ({
      width: Math.max(minWidth, Math.min(current.width + dx, window.innerWidth - position.left - 8)),
      height: Math.max(minHeight, Math.min(current.height + dy, window.innerHeight - position.top - 8)),
    }));
  };

  const addToAnnotation = async (): Promise<void> => {
    if (annotationState !== 'idle') return;
    setAnnotationState('saving');
    try {
      const saved = await onAddToAnnotation();
      setAnnotationState(saved ? 'saved' : 'idle');
    } catch {
      setAnnotationState('idle');
    }
  };

  const style: React.CSSProperties = {
    width: size.width,
    height: size.height,
    left: position.left,
    top: position.top,
  };
  const languageLabel = (language: string): string => {
    if (language === 'zh-CN' || language === 'zh') return '中文';
    if (language === 'en-US' || language === 'en' || language === 'auto') return 'EN';
    return language;
  };
  const directionLabel = languageLabel(sourceLanguage) + ' → ' + languageLabel(targetLanguage);
  return (
    <div ref={ref} className="fixed z-[82] flex flex-col overflow-hidden rounded-lg border border-app-border bg-app-panel shadow-2xl" style={style}>
      <div className="flex h-9 shrink-0 cursor-move touch-none select-none items-center justify-between border-b border-app-border px-3" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-app-text"><GripHorizontal size={13} className="text-app-muted" /> Academic Translation</span>
        <button className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted hover:bg-app-panel2 hover:text-app-text" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
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
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-t border-app-border py-1.5 pl-2.5 pr-5">
        <button
          className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          title="切换中英翻译方向"
          aria-label={'切换翻译方向，当前为 ' + directionLabel}
          onClick={onToggleLanguage}
        >
          <ArrowLeftRight size={12} />
          <span>{directionLabel}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {status.kind === 'confirm' && (
            <button className="h-7 rounded-md bg-app-accent px-2.5 text-[10.5px] font-medium text-white" onClick={onConfirm}>Translate</button>
          )}
          {status.kind === 'success' && (
            <>
              <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-muted hover:bg-app-panel2 hover:text-app-text" onClick={onCopy}><Copy size={12} /> Copy</button>
              <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-muted hover:bg-app-panel2 hover:text-app-text" onClick={onAddToNote}><BookOpen size={12} /> Add to Note</button>
              <button
                className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-accent transition-colors hover:bg-app-accent/10 disabled:cursor-default disabled:opacity-70"
                title={t('translation.addToAnnotation')}
                disabled={annotationState !== 'idle'}
                onClick={() => void addToAnnotation()}
              >
                {annotationState === 'saving' ? <Loader2 size={12} className="animate-spin" /> : annotationState === 'saved' ? <Check size={12} /> : <Highlighter size={12} />}
                {annotationState === 'saved' ? t('translation.annotationWritten') : t('translation.addToAnnotation')}
              </button>
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-app-muted hover:bg-app-panel2 hover:text-app-text" title="Retry" onClick={onRetry}><RefreshCw size={12} /></button>
            </>
          )}
          {status.kind === 'error' && status.error.retryable && (
            <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-app-muted hover:bg-app-panel2 hover:text-app-text" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
          )}
        </div>
      </div>
      <button
        className="group absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize touch-none"
        title="拖动调整翻译窗口大小"
        aria-label="调整翻译窗口大小；也可使用方向键，按住 Shift 可加速"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={resizeWithKeyboard}
      >
        <span className="absolute bottom-[4px] right-[4px] h-[7px] w-[7px] border-b border-r border-app-muted opacity-45 transition-opacity group-hover:opacity-90 group-focus-visible:opacity-90" />
        <span className="absolute bottom-[4px] right-[4px] h-[11px] w-[11px] border-b border-r border-app-muted opacity-20 transition-opacity group-hover:opacity-55 group-focus-visible:opacity-55" />
      </button>
    </div>
  );
}
