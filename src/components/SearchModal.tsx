import { FileText, Hash, Loader2, Search, StickyNote, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { SearchResult } from '../shared/types';
import { useApp } from '../store';

export function SearchModal() {
  const t = useT();
  const open = useApp((s) => s.searchOpen);
  const setOpen = useApp((s) => s.setSearchOpen);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQ('');
      setRes(null);
      return;
    }
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) {
      setRes(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        setRes(await window.pkm.search(q.trim()));
      } catch {
        setRes({ pdfs: [], notes: [], tags: [] });
      } finally {
        setBusy(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [q, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const openPdf = (id: number) => {
    useApp.getState().openPdf(id);
    setOpen(false);
  };
  const pickTag = (id: number) => {
    useApp.getState().setTagFilter(id);
    setOpen(false);
  };
  const openNote = (pdfId: number) => {
    useApp.getState().openPdf(pdfId);
    useApp.getState().setInspectorTab('notes');
    setOpen(false);
  };

  const openFirst = () => {
    if (!res) return;
    if (res.pdfs.length) openPdf(res.pdfs[0].id);
    else if (res.notes.length) openNote(res.notes[0].pdf.id);
    else if (res.tags.length) pickTag(res.tags[0].id);
  };

  const total = (res?.pdfs.length ?? 0) + (res?.notes.length ?? 0) + (res?.tags.length ?? 0);

  return (
    <div className="animate-fade fixed inset-0 z-50 bg-black/45" onMouseDown={() => setOpen(false)}>
      <div
        className="animate-pop mx-auto mt-[12vh] w-[560px] overflow-hidden rounded-xl border border-app-border bg-app-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-app-border px-3.5 py-3">
          <Search size={15} className="shrink-0 text-app-muted" />
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-app-muted"
            placeholder={t('search.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openFirst();
            }}
          />
          {busy ? (
            <Loader2 size={13} className="animate-spin text-app-muted" />
          ) : (
            <button className="text-app-muted hover:text-app-text" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1.5">
          {!q.trim() && (
            <p className="px-4 py-6 text-center text-[11.5px] text-app-muted">{t('search.hint')}</p>
          )}
          {q.trim() && !busy && res && total === 0 && (
            <p className="px-4 py-6 text-center text-[11.5px] text-app-muted">{t('search.noResults')}</p>
          )}

          {res && res.pdfs.length > 0 && (
            <Section title={t('search.pdfDocs')}>
              {res.pdfs.map((p) => (
                <ResultRow
                  key={`p-${p.id}`}
                  icon={<FileText size={13} />}
                  title={p.title}
                  sub={p.filepath}
                  onClick={() => openPdf(p.id)}
                />
              ))}
            </Section>
          )}

          {res && res.notes.length > 0 && (
            <Section title={t('search.noteContent')}>
              {res.notes.map((n) => (
                <ResultRow
                  key={`n-${n.pdf.id}`}
                  icon={<StickyNote size={13} />}
                  title={n.pdf.title}
                  sub={n.snippet}
                  onClick={() => openNote(n.pdf.id)}
                />
              ))}
            </Section>
          )}

          {res && res.tags.length > 0 && (
            <Section title={t('search.tags')}>
              {res.tags.map((tg) => (
                <ResultRow
                  key={`t-${tg.id}`}
                  icon={<Hash size={13} />}
                  title={`#${tg.name}`}
                  sub={t('search.viewTagPdfs')}
                  onClick={() => pickTag(tg.id)}
                />
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-4 py-1 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function ResultRow({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-app-panel2"
      onClick={onClick}
    >
      <span className="shrink-0 text-app-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-app-text">{title}</span>
        {sub && <span className="mt-0.5 block truncate text-[10.5px] text-app-muted">{sub}</span>}
      </span>
    </button>
  );
}
