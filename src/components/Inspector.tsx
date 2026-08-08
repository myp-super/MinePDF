import {
  AlertTriangle,
  BookMarked,
  Check,
  Copy,
  ExternalLink,
  FileDown,
  FileSearch,
  FileText,
  FolderOpen,
  Hash,
  Info,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Pin,
  Plus,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { useT, useTError } from '../i18n';
import type { AnnotationRecord, PdfRecord } from '../shared/types';
import { useApp } from '../store';
import { Button, formatBytes, formatDate, IconButton, Toggle } from './ui';
import { InspectorOutline } from './InspectorOutline';
import { NoteEditor } from './NoteEditor';

/** 导出 PDF 时使用的精简 Markdown 样式 */
const MD_EXPORT_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 36px; background: #fff; color: #1d2129;
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 14px; line-height: 1.75; -webkit-print-color-adjust: exact; }
  h1,h2,h3,h4,h5,h6 { margin: 1.1em 0 0.5em; font-weight: 600; line-height: 1.35; }
  h1 { font-size: 1.6em; padding-bottom: 0.3em; border-bottom: 1px solid #d9dde4; }
  h2 { font-size: 1.35em; } h3 { font-size: 1.2em; }
  p { margin: 0.55em 0; }
  ul,ol { padding-left: 1.5em; margin: 0.55em 0; }
  blockquote { border-left: 3px solid #5b8def; margin: 0.7em 0; padding-left: 0.9em; color: #555; }
  code { font-family: Consolas, monospace; font-size: 0.9em; background: #f1f3f7; padding: 0.12em 0.35em; border-radius: 4px; }
  pre { background: #0c0f16; color: #d6e2f2; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  table { border-collapse: collapse; margin: 0.7em 0; width: 100%; }
  th,td { border: 1px solid #d9dde4; padding: 5px 9px; text-align: left; }
  th { background: #f0f2f5; }
  img { max-width: 100%; }
  del { color: #888; }
`;

export function Inspector() {
  const t = useT();
  const pdf = useApp((s) => s.pdfs.find((p) => p.id === s.activePdfId));
  const tab = useApp((s) => s.inspectorTab);
  const setTab = useApp((s) => s.setInspectorTab);
  const collapsed = useApp((s) => s.inspectorCollapsed);
  const toggleCollapsed = useApp((s) => s.toggleInspectorCollapsed);
  const outline = useApp((s) => s.outline);
  const inspectorWidth = useApp((s) => s.inspectorWidth);

  const tabs = [
    { key: 'meta', label: t('inspector.info'), icon: <Info size={14} /> },
    { key: 'outline', label: t('inspector.outline'), icon: <BookMarked size={14} /> },
    { key: 'notes', label: t('inspector.notes'), icon: <StickyNote size={14} /> },
    { key: 'annotations', label: t('inspector.annotations'), icon: <Pin size={14} /> },
  ] as const;

  if (!pdf) {
    return (
      <aside className="flex w-[320px] shrink-0 flex-col items-center justify-center gap-2 border-l border-app-border bg-app-panel text-center">
        <FileText size={26} className="text-app-muted/40" />
        <p className="px-6 text-[11.5px] leading-relaxed text-app-muted">
          {t('inspector.empty').split('\n').map((line, i) => (
            <React.Fragment key={i}>
              {line}
              <br />
            </React.Fragment>
          ))}
        </p>
      </aside>
    );
  }

  if (collapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center border-l border-app-border bg-app-panel py-2">
        {tabs.map((tabItem) => (
          <button
            key={tabItem.key}
            className={`mb-1 flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
              tab === tabItem.key
                ? 'bg-app-accent/15 text-app-accent'
                : 'text-app-muted hover:bg-app-panel2 hover:text-app-text'
            }`}
            title={tabItem.label}
            aria-label={tabItem.label}
            onClick={() => {
              setTab(tabItem.key);
              toggleCollapsed();
            }}
          >
            {tabItem.icon}
          </button>
        ))}
        <div className="flex-1" />
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          title={t('inspector.expand')}
          aria-label={t('inspector.expand')}
          onClick={toggleCollapsed}
        >
          <PanelRightOpen size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-app-border bg-app-panel"
      style={{ width: inspectorWidth }}
      data-panel="inspector"
    >
      <div className="flex items-center justify-between border-b border-app-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <PenLine size={13} className="text-app-accent" />
          {t('inspector.panel')}
        </div>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          title={t('inspector.collapse')}
          aria-label={t('inspector.collapse')}
          onClick={toggleCollapsed}
        >
          <PanelRightClose size={14} />
        </button>
      </div>
      <div className="border-b border-app-border px-2.5">
        <div className="flex gap-0.5">
          {(
            [
              ['meta', t('inspector.info')],
              ['outline', t('inspector.outline')],
              ['notes', t('inspector.notes')],
              ['annotations', t('inspector.annotations')],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-[11.5px] transition-colors ${
                tab === key
                  ? 'border-app-border bg-app-base text-app-text'
                  : 'border-transparent text-app-muted hover:text-app-text'
              }`}
              onClick={() => setTab(key)}
            >
              {tabs.find((tabItem) => tabItem.key === key)?.icon}
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'meta' && <MetaPanel pdf={pdf} />}
        {tab === 'outline' && <InspectorOutline items={outline} />}
        {tab === 'notes' && <NotesPanel key={pdf.id} pdf={pdf} />}
        {tab === 'annotations' && <AnnotationsPanel pdf={pdf} />}
      </div>
    </aside>
  );
}

function MetaPanel({ pdf }: { pdf: PdfRecord }) {
  const t = useT();
  const terr = useTError();
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const tags = useApp((s) => s.tags);
  const [title, setTitle] = useState(pdf.title);

  useEffect(() => setTitle(pdf.title), [pdf.id, pdf.title]);

  const commitTitle = async () => {
    if (title.trim() && title !== pdf.title) {
      try {
        await window.pkm.updatePdfTitle(pdf.id, title.trim());
        await refresh();
        toast('success', t('inspector.titleUpdated'));
      } catch (err) {
        toast('error', terr(err instanceof Error ? err.message : String(err)));
      }
    }
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => toast('success', t('inspector.copied', { label })));
  };

  const addTag = async (raw: string) => {
    const name = raw.trim().replace(/^#/, '');
    if (!name) return;
    try {
      await window.pkm.addTag(pdf.id, name);
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const removeTag = async (tagId: number) => {
    try {
      await window.pkm.removeTag(pdf.id, tagId);
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <div className="space-y-4 px-3.5 py-3">
      {pdf.status === 'missing' && (
        <div className="flex items-start gap-2 rounded-lg border border-app-danger/40 bg-app-danger/10 p-2.5 text-[11.5px] text-app-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            {t('inspector.missing')}
            <button
              className="mt-1 block font-medium underline underline-offset-2 hover:opacity-80"
              onClick={async () => {
                try {
                  const updated = await window.pkm.relocatePdf(pdf.id);
                  await refresh();
                  if (updated) useApp.getState().openPdf(updated.id);
                } catch (err) {
                  toast('error', terr(err instanceof Error ? err.message : String(err)));
                }
              }}
            >
              {t('inspector.relocate')}
            </button>
          </div>
        </div>
      )}

      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
          {t('inspector.title')}
        </div>
        <input
          className="h-8 w-full rounded-md border border-app-border bg-app-panel2 px-2.5 text-xs outline-none focus:border-app-accent/70"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </section>

      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
          {t('inspector.tags')}
        </div>
        <div className="mb-1.5 flex flex-wrap gap-1">
          {pdf.tags.length === 0 && (
            <span className="text-[11px] text-app-muted/70">{t('inspector.noTags')}</span>
          )}
          {pdf.tags.map((tg) => (
            <span
              key={tg.id}
              className="inline-flex items-center gap-1 rounded-full border border-app-accent/40 bg-app-accent/10 px-2 py-0.5 text-[10.5px]"
            >
              <Hash size={9} />
              {tg.name}
              <button className="text-app-muted hover:text-app-danger" onClick={() => void removeTag(tg.id)}>
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
        <TagInput
          existing={tags.map((tag) => tag.name)}
          current={pdf.tags.map((tag) => tag.name)}
          onAdd={(n) => void addTag(n)}
        />
      </section>

      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
          {t('inspector.fileInfo')}
        </div>
        <dl className="space-y-1.5 text-[11.5px]">
          <MetaRow label={t('inspector.filename')} value={pdf.filename} />
          <div className="flex items-start justify-between gap-2">
            <dt className="shrink-0 text-app-muted">{t('inspector.path')}</dt>
            <dd className="min-w-0 flex-1">
              <span className="block truncate text-right" title={pdf.filepath}>
                {pdf.filepath}
              </span>
            </dd>
            <button
              className="shrink-0 text-app-muted hover:text-app-text"
              onClick={() => copyText(pdf.filepath, t('inspector.path'))}
            >
              <Copy size={11} />
            </button>
          </div>
          <MetaRow label={t('inspector.size')} value={formatBytes(pdf.size)} />
          <MetaRow
            label={t('inspector.pages')}
            value={pdf.pageCount != null ? t('inspector.pagesValue', { n: pdf.pageCount }) : '—'}
          />
          <MetaRow label={t('inspector.importedAt')} value={formatDate(pdf.createdAt)} />
          <MetaRow label={t('inspector.updatedAt')} value={formatDate(pdf.updatedAt)} />
        </dl>
        <div className="mt-2.5 flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void window.pkm.openPdfExternal(pdf.id)}>
            <ExternalLink size={11} /> {t('inspector.openInSystem')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => copyText(pdf.filepath, t('inspector.path'))}>
            <Copy size={11} /> {t('inspector.copyPath')}
          </Button>
        </div>
      </section>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-app-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-app-text/90">{value}</dd>
    </div>
  );
}

function TagInput({
  existing,
  current,
  onAdd,
}: {
  existing: string[];
  current: string[];
  onAdd: (name: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const [focus, setFocus] = useState(false);
  const suggestions = value.trim()
    ? existing
        .filter((n) => !current.includes(n) && n.toLowerCase().includes(value.trim().toLowerCase()))
        .slice(0, 6)
    : [];
  const submit = () => {
    if (!value.trim()) return;
    onAdd(value);
    setValue('');
  };
  return (
    <div className="relative">
      <div className="flex items-center gap-1 rounded-md border border-app-border bg-app-panel2 px-2 focus-within:border-app-accent/70">
        <Hash size={11} className="text-app-muted" />
        <input
          className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-app-muted"
          placeholder={t('inspector.tagPlaceholder')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button className="text-app-muted hover:text-app-text" onClick={submit}>
          <Plus size={12} />
        </button>
      </div>
      {focus && suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-20 mt-1 w-full overflow-hidden rounded-md border border-app-border bg-app-panel shadow-xl">
          {suggestions.map((n) => (
            <button
              key={n}
              className="block w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-app-panel2"
              onMouseDown={(e) => {
                e.preventDefault();
                onAdd(n);
                setValue('');
              }}
            >
              #{n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NotesPanel({ pdf }: { pdf: PdfRecord }) {
  const t = useT();
  const autoSave = useApp((s) => s.settings.autoSave);
  const toast = useApp((s) => s.toast);
  const [md, setMd] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteFile, setNoteFile] = useState<string | null>(null);
  const [notesDir, setNotesDir] = useState('');
  const [exporting, setExporting] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    setLoading(true);
    void (async () => {
      try {
        const note = await window.pkm.getNote(pdf.id);
        if (note) {
          setMd(note.markdown);
          setNoteFile(note.noteFile ?? null);
        }
      } catch {
        /* ignore */
      }
      loadedRef.current = true;
      setDirty(false);
      setLoading(false);
    })();
  }, [pdf.id]);

  useEffect(() => {
    void window.pkm
      .getAppInfo()
      .then((info) => setNotesDir(`${info.dataDir.replace(/\\/g, '/')}/notes`))
      .catch(() => undefined);
  }, []);

  const save = useCallback(
    async (text: string, silent = false) => {
      try {
        setSaving(true);
        await window.pkm.saveNote(pdf.id, text);
        setSavedAt(new Date());
        setDirty(false);
        if (!silent) toast('success', t('inspector.noteSaved'));
      } catch (err) {
        toast('error', t('inspector.saveFailed', { msg: err instanceof Error ? err.message : String(err) }));
      } finally {
        setSaving(false);
      }
    },
    [pdf.id, t, toast],
  );

  useEffect(() => {
    if (!loadedRef.current || !dirty || !autoSave) return;
    const timer = setTimeout(() => void save(md, true), 900);
    return () => clearTimeout(timer);
  }, [md, dirty, autoSave, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save(md);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [md, save]);

  const resolveAsset = (src?: string): string | undefined => {
    if (!src) return undefined;
    if (/^(https?:|file:|data:|blob:)/.test(src)) return src;
    if (notesDir && src.startsWith('assets/')) return `file://${notesDir}/${src}`;
    return src;
  };

  const exportPdf = async () => {
    setExporting(true);
    try {
      const body = renderToStaticMarkup(
        <div className="md-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              img: ({ src, alt }) => <img src={resolveAsset(src)} alt={alt ?? ''} />,
            }}
          >
            {md}
          </ReactMarkdown>
        </div>,
      );
      const html = `<!doctype html><html><head><meta charset="utf-8"/>
<style>/*__KATEX_CSS__*/</style>
<style>${MD_EXPORT_CSS}</style>
</head><body>${body}</body></html>`;
      const saved = await window.pkm.exportNoteToPdf({
        html,
        suggestedName: `${pdf.title || pdf.filename} 笔记.pdf`,
      });
      if (!saved) {
        toast('error', t('inspector.saveFailed', { msg: '导出已取消' }));
      }
    } catch (err) {
      toast('error', t('inspector.saveFailed', { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-app-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-app-border px-3 py-1.5">
        <div className="flex items-center gap-1">
          <button
            className={`rounded-md px-2 py-1 text-[11px] ${mode === 'edit' ? 'bg-app-panel2 text-app-text' : 'text-app-muted hover:text-app-text'}`}
            onClick={() => setMode('edit')}
          >
            {t('inspector.edit')}
          </button>
          <button
            className={`rounded-md px-2 py-1 text-[11px] ${mode === 'preview' ? 'bg-app-panel2 text-app-text' : 'text-app-muted hover:text-app-text'}`}
            onClick={() => setMode('preview')}
          >
            {t('inspector.preview')}
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[10.5px] text-app-muted">
          <Button size="sm" variant="outline" disabled={exporting || !md.trim()} onClick={() => void exportPdf()}>
            <FileDown size={11} /> {exporting ? t('common.saving') : t('note.exportPdf')}
          </Button>
          {saving ? (
            <span className="flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> {t('common.saving')}
            </span>
          ) : dirty ? (
            <span>{t('inspector.unsaved')}</span>
          ) : savedAt ? (
            <span className="flex items-center gap-1 text-emerald-400">
              <Check size={10} /> {savedAt.toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <StickyNote size={10} /> {autoSave ? t('inspector.autoSave') : t('inspector.ctrlSave')}
            </span>
          )}
        </div>
      </div>

      {mode === 'edit' ? (
        <NoteEditor
          value={md}
          onChange={(v) => {
            setMd(v);
            setDirty(true);
          }}
          placeholder={t('inspector.notePlaceholder')}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          {md.trim() ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              className="md-body"
              components={{
                img: ({ src, alt }) => <img src={resolveAsset(src)} alt={alt ?? ''} />,
              }}
            >
              {md}
            </ReactMarkdown>
          ) : (
            <div className="text-center text-[11.5px] text-app-muted">{t('inspector.noteEmpty')}</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-app-border px-3 py-1.5 text-[10.5px] text-app-muted/70">
        <span className="min-w-0 truncate">
          {noteFile ? noteFile.split(/[\\/]/).pop() : t('inspector.noteMirror', { id: pdf.id })}
        </span>
        {noteFile && (
          <button
            className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
            title={t('note.revealFile')}
            onClick={() => void window.pkm.revealNoteFile(pdf.id)}
          >
            <FolderOpen size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function AnnotationsPanel({ pdf }: { pdf: PdfRecord }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [items, setItems] = useState<AnnotationRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setItems(await window.pkm.listAnnotations(pdf.id));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [pdf.id, toast]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-app-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center">
        <FileSearch size={24} className="text-app-muted/40" />
        <p className="text-[11.5px] leading-relaxed text-app-muted">{t('inspector.noAnnotations')}</p>
      </div>
    );
  }

  const groups = new Map<number, AnnotationRecord[]>();
  for (const a of items) {
    const arr = groups.get(a.page) ?? [];
    arr.push(a);
    groups.set(a.page, arr);
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {[...groups.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([page, list]) => (
          <div key={page}>
            <div className="mb-1 text-[10.5px] font-medium text-app-muted">
              {t('inspector.pageX', { n: page })}
            </div>
            <div className="space-y-2">
              {list.map((a) => (
                <AnnotationItem key={a.id} a={a} onChanged={() => void reload()} toast={toast} />
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function AnnotationItem({
  a,
  onChanged,
  toast,
}: {
  a: AnnotationRecord;
  onChanged: () => void;
  toast: (kind: 'info' | 'success' | 'error', text: string) => void;
}) {
  const t = useT();
  const [note, setNote] = useState(a.note);
  const [saving, setSaving] = useState(false);

  useEffect(() => setNote(a.note), [a.note]);

  const commitNote = async () => {
    if (note === a.note) return;
    try {
      setSaving(true);
      await window.pkm.updateAnnotation(a.id, { note });
      onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-app-border bg-app-panel2 p-2">
      <div className="flex items-start gap-2">
        <span className="mt-1 h-3 w-1 shrink-0 rounded-full" style={{ background: a.color }} />
        <div className="min-w-0 flex-1">
          {a.content ? (
            <p className="mb-1 line-clamp-3 text-[11px] leading-relaxed text-app-text/85">{a.content}</p>
          ) : (
            <p className="mb-1 text-[11px] italic text-app-muted">{t('inspector.noTextContent')}</p>
          )}
          <textarea
            className="mt-1 w-full resize-none rounded-md border border-app-border bg-app-base px-2 py-1.5 text-[11px] leading-relaxed outline-none placeholder:text-app-muted/60 focus:border-app-accent/60"
            rows={2}
            placeholder={t('inspector.addNotePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => void commitNote()}
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px] text-app-muted">
              {saving ? t('inspector.savingNote') : t('inspector.blurAutosave')}
            </span>
            <button
              className="text-app-muted transition-colors hover:text-app-danger"
              title={t('inspector.deleteAnnotation')}
              onClick={async () => {
                try {
                  await window.pkm.deleteAnnotation(a.id);
                  onChanged();
                } catch (err) {
                  toast('error', err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
