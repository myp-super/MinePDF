import {
  BookMarked,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Columns2,
  ExternalLink,
  Highlighter,
  Maximize,
  Minimize,
  MoveHorizontal,
  PanelTop,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import React from 'react';
import { useT } from '../../i18n';
import type { PdfRecord } from '../../shared/types';
import { IconButton } from '../ui';

const HIGHLIGHT_COLORS = ['#fde047', '#4ade80', '#22d3ee', '#fb923c', '#f472b6'];

export function PdfToolbar({
  pdf,
  pageCount,
  currentPage,
  scale,
  mode,
  outlineCount,
  highlightMode,
  highlightColor,
  immersive,
  ready,
  onPageChange,
  onPrev,
  onNext,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onFitPage,
  onToggleMode,
  onOpenOutline,
  onToggleHighlight,
  onColorChange,
  onToggleSearch,
  onToggleImmersive,
  onToggleToolbar,
  onOpenExternal,
}: {
  pdf: PdfRecord;
  pageCount: number;
  currentPage: number;
  scale: number;
  mode: 'single' | 'double';
  outlineCount: number;
  highlightMode: boolean;
  highlightColor: string;
  immersive: boolean;
  ready: boolean;
  onPageChange: (n: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  onFitPage: () => void;
  onToggleMode: () => void;
  onOpenOutline: () => void;
  onToggleHighlight: () => void;
  onColorChange: (c: string) => void;
  onToggleSearch: () => void;
  onToggleImmersive: () => void;
  onToggleToolbar: () => void;
  onOpenExternal: () => void;
}) {
  const t = useT();

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-app-border bg-app-panel px-2">
      <IconButton disabled={!ready || currentPage <= 1} onClick={onPrev} title={t('toolbar.prev')}>
        <ChevronLeft size={15} />
      </IconButton>
      <IconButton disabled={!ready || currentPage >= pageCount} onClick={onNext} title={t('toolbar.next')}>
        <ChevronRight size={15} />
      </IconButton>
      <div className="ml-1 flex items-center gap-1 text-xs tabular-nums">
        <input
          className="h-6 w-11 rounded-md border border-app-border bg-app-panel2 text-center text-xs outline-none focus:border-app-accent/70"
          value={currentPage}
          disabled={!ready}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isNaN(n)) onPageChange(n);
          }}
          aria-label={t('toolbar.page')}
        />
        <span className="whitespace-nowrap text-app-muted">/ {pageCount || '—'}</span>
      </div>

      <div className="mx-2 h-4 w-px shrink-0 bg-app-border" />

      <IconButton disabled={!ready} onClick={onZoomOut} title={t('toolbar.zoomOut')}>
        <ZoomOut size={14} />
      </IconButton>
      <button
        className="w-12 shrink-0 text-center text-[11px] tabular-nums text-app-muted transition-colors hover:text-app-text"
        onClick={onFitPage}
        title={t('toolbar.fitPage')}
      >
        {Math.round(scale * 100)}%
      </button>
      <IconButton disabled={!ready} onClick={onZoomIn} title={t('toolbar.zoomIn')}>
        <ZoomIn size={14} />
      </IconButton>
      <button
        disabled={!ready}
        onClick={onFitWidth}
        title={t('toolbar.fitWidth')}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text disabled:opacity-40"
        aria-label={t('toolbar.fitWidth')}
      >
        <MoveHorizontal size={14} />
      </button>

      <div className="mx-2 h-4 w-px shrink-0 bg-app-border" />

      <div className="flex overflow-hidden rounded-md border border-app-border">
        <button
          className={`flex h-6 shrink-0 items-center gap-1 whitespace-nowrap px-2 text-[11px] transition-colors ${
            mode === 'single'
              ? 'bg-app-panel2 text-app-text'
              : 'bg-transparent text-app-muted hover:text-app-text'
          }`}
          onClick={onToggleMode}
          title={t('toolbar.singleTitle')}
          aria-label={t('toolbar.singleTitle')}
        >
          <PanelTop size={14} />
        </button>
        <button
          className={`flex h-6 shrink-0 items-center gap-1 whitespace-nowrap border-l border-app-border px-2 text-[11px] transition-colors ${
            mode === 'double'
              ? 'bg-app-panel2 text-app-text'
              : 'bg-transparent text-app-muted hover:text-app-text'
          }`}
          onClick={onToggleMode}
          title={t('toolbar.doubleTitle')}
          aria-label={t('toolbar.doubleTitle')}
        >
          <Columns2 size={14} />
        </button>
      </div>

      {/* Bookmarks / outline: open the inspector's bookmark tab */}
      <IconButton
        disabled={!ready || outlineCount === 0}
        onClick={onOpenOutline}
        title={
          outlineCount > 0
            ? t('toolbar.bookmarksInspector', { n: outlineCount })
            : t('toolbar.noBookmarks')
        }
      >
        <BookMarked size={14} />
      </IconButton>

      <IconButton
        disabled={!ready}
        onClick={onToggleHighlight}
        title={t('toolbar.highlight')}
        className={highlightMode ? 'bg-app-accent/20 text-app-accent' : ''}
      >
        <Highlighter size={14} />
      </IconButton>
      {highlightMode && (
        <div className="ml-0.5 flex shrink-0 items-center gap-1 rounded-md border border-app-border px-1.5 py-1">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              className={`h-3 w-3 rounded-full border transition-transform ${
                highlightColor === c ? 'scale-125 border-white' : 'border-transparent hover:scale-110'
              }`}
              style={{ background: c }}
              onClick={() => onColorChange(c)}
              title={t('toolbar.highlightColor')}
              aria-label={t('toolbar.highlightColor')}
            />
          ))}
        </div>
      )}

      <div className="flex-1" />

      <IconButton disabled={!ready} onClick={onToggleSearch} title={t('toolbar.docSearch')}>
        <Search size={14} />
      </IconButton>
      <IconButton disabled={!ready} onClick={onOpenExternal} title={t('toolbar.openExternal')}>
        <ExternalLink size={14} />
      </IconButton>
      <IconButton disabled={!ready} onClick={onToggleImmersive} title={t('toolbar.immersive')}>
        {immersive ? <Minimize size={14} /> : <Maximize size={14} />}
      </IconButton>
      <IconButton onClick={onToggleToolbar} title={t('toolbar.collapseToolbar')}>
        <ChevronUp size={14} />
      </IconButton>
    </div>
  );
}
