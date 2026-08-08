import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import React from 'react';
import { useT } from '../../i18n';
import { IconButton } from '../ui';
import type { SearchMatch } from '../../lib/pdf';

export function PdfSearchBar({
  query,
  setQuery,
  matches,
  current,
  onStep,
  onClose,
}: {
  query: string;
  setQuery: (q: string) => void;
  matches: SearchMatch[];
  current: number;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const t = useT();
  const total = matches.length;
  return (
    <div className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-app-border bg-app-panel px-3 py-2 shadow-2xl">
      <Search size={13} className="shrink-0 text-app-muted" />
      <input
        autoFocus
        className="w-60 bg-transparent text-xs outline-none placeholder:text-app-muted"
        placeholder={t('searchbar.placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="whitespace-nowrap text-[10.5px] text-app-muted">
        {query.trim() ? (total ? `${current + 1} / ${total}` : t('searchbar.noResults')) : ''}
      </span>
      <IconButton disabled={total === 0} onClick={() => onStep(-1)} title={t('searchbar.prev')}>
        <ChevronUp size={13} />
      </IconButton>
      <IconButton disabled={total === 0} onClick={() => onStep(1)} title={t('searchbar.next')}>
        <ChevronDown size={13} />
      </IconButton>
      <IconButton onClick={onClose} title={t('searchbar.close')}>
        <X size={13} />
      </IconButton>
    </div>
  );
}
