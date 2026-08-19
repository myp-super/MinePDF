import {
  AlertTriangle,
  BookOpen,
  BookMarked,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
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
  RotateCcw,
  Save,
  Search,
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
import type {
  AnnotationRecord,
  LiteratureMetadata,
  LiteratureReview,
  LiteratureReviewField,
  NoteReference,
  PdfRecord,
  Tag,
} from '../shared/types';
import type { OutlineNode } from '../lib/pdf';
import { DEFAULT_TAG_PRESETS, isPresetTag, normalizeTagName } from '../lib/tags';
import {
  flushAllLiteratureFields,
  forceLiteratureClean,
  markMetadataDirty,
  markMetadataSaved,
  registerFieldCleaner,
  registerFieldDirty,
  registerFieldFlush,
  registerLiteratureSave,
} from '../lib/literatureDirty';
import { useApp } from '../store';
import { Button, formatBytes, formatDate, IconButton, Toggle } from './ui';
import { InspectorOutline } from './InspectorOutline';
import { NoteEditor } from './NoteEditor';
import { ExportModal } from './ExportModal';

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

/** 书签空列表常量：避免 selector 每次返回新引用触发无限重渲染 */
const EMPTY_OUTLINE: OutlineNode[] = [];

export function Inspector() {
  const t = useT();
  const pdf = useApp(
    (s) => s.pdfs.find((p) => p.id === s.activePdfId) ?? s.inboxPdfs.find((p) => p.id === s.activePdfId),
  );
  const tab = useApp((s) => s.inspectorTab);
  const setTab = useApp((s) => s.setInspectorTab);
  const collapsed = useApp((s) => s.inspectorCollapsed);
  const toggleCollapsed = useApp((s) => s.toggleInspectorCollapsed);
  const dblClickToggle = useApp((s) => s.settings.dblClickTogglePanels);
  // 书签跟随当前选中屏的 PDF（per-pdf 缓存），避免分屏时显示另一屏的书签
  const outline = useApp((s) =>
    s.activePdfId != null ? s.outlines[s.activePdfId] ?? EMPTY_OUTLINE : EMPTY_OUTLINE,
  );
  const inspectorWidth = useApp((s) => s.inspectorWidth);

  const tabs = [
    { key: 'info', label: t('inspector.info'), icon: <Info size={14} /> },
    { key: 'outline', label: t('inspector.outline'), icon: <BookMarked size={14} /> },
    { key: 'notes', label: t('inspector.notes'), icon: <StickyNote size={14} /> },
    { key: 'literature', label: t('inspector.literature'), icon: <BookOpen size={14} /> },
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
      <aside
        className="flex w-11 shrink-0 flex-col items-center border-l border-app-border bg-app-panel py-2"
        onDoubleClick={() => {
          if (dblClickToggle) toggleCollapsed();
        }}
      >
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
      onDoubleClick={(e) => {
        if (!dblClickToggle) return;
        const t = e.target as HTMLElement;
        if (t.closest('button, a, input, textarea') || t.closest('[class*="cursor-pointer"]')) return;
        toggleCollapsed();
      }}
    >
      <div className="flex items-center justify-between border-b border-app-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <PenLine size={13} className="text-app-accent" />
          <span className="cq-panel-title whitespace-nowrap">{t('inspector.panel')}</span>
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
        <div className="flex gap-0.5 overflow-x-auto">
          {(
            [
              ['info', t('inspector.info')],
              ['outline', t('inspector.outline')],
              ['notes', t('inspector.notes')],
              ['literature', t('inspector.literature')],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`flex shrink-0 items-center justify-center rounded-t-md border border-b-0 px-2.5 py-1.5 transition-colors ${
                tab === key
                  ? 'border-app-border bg-app-base text-app-text'
                  : 'border-transparent text-app-muted hover:text-app-text'
              }`}
              onClick={() => setTab(key)}
              title={label}
              aria-label={label}
            >
              {tabs.find((tabItem) => tabItem.key === key)?.icon}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'literature' && <LiteraturePanel key={pdf.id} pdf={pdf} />}
        {tab === 'info' && <InfoPanel pdf={pdf} />}
        {tab === 'outline' && <InspectorOutline items={outline} />}
        {tab === 'notes' && <NotesPanel key={pdf.id} pdf={pdf} />}
      </div>
    </aside>
  );
}

/** 标签区块（信息 / 文献管理共用）：标签胶囊 + 预设/自定义选择器 */
function TagSection({ pdf }: { pdf: PdfRecord }) {
  const t = useT();
  const terr = useTError();
  const toast = useApp((s) => s.toast);
  const refresh = useApp((s) => s.refresh);
  const tags = useApp((s) => s.tags);
  const settings = useApp((s) => s.settings);
  const pdfs = useApp((s) => s.pdfs);
  const inboxPdfs = useApp((s) => s.inboxPdfs);

  const addTag = async (raw: string) => {
    const name = normalizeTagName(raw);
    if (!name) return;
    if (pdf.tags.some((x) => normalizeTagName(x.name).toLowerCase() === name.toLowerCase())) return;
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
  const deleteTagDef = async (tagId: number) => {
    try {
      await window.pkm.deleteTag(tagId);
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };
  const customTags = tags.filter((x) => !isPresetTag(x.name));
  const usageOf = (tagId: number) =>
    pdfs.filter((p) => p.tags.some((x) => x.id === tagId)).length +
    inboxPdfs.filter((p) => p.tags.some((x) => x.id === tagId)).length;

  return (
    <section>
      <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
        {t('inspector.tags')}
      </div>
      <div className="mb-1.5 flex flex-wrap gap-1">
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
      <TagPicker
        presets={DEFAULT_TAG_PRESETS.filter((p) => !(settings.disabledTagPresets ?? []).includes(p))}
        custom={customTags}
        current={pdf.tags}
        usageOf={usageOf}
        onAdd={(n) => void addTag(n)}
        onRemove={(tagId) => void removeTag(tagId)}
        onCreate={(n) => void addTag(n)}
        onDelete={(tagId) => void deleteTagDef(tagId)}
      />
    </section>
  );
}

/** 「信息」Tab：只负责 PDF 文件本身的信息 + 标签 */
function InfoPanel({ pdf }: { pdf: PdfRecord }) {
  const t = useT();
  const terr = useTError();
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
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
          {t('inspector.displayTitle')}
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

      <TagSection pdf={pdf} />

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
          <MetaRow label={t('inspector.fileType')} value="PDF" />
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

/** 「文献管理」Tab：文献档案 + 阅读状态 + 标签 + 结构化阅读记录 + 导出 */
function LiteraturePanel({ pdf }: { pdf: PdfRecord }) {
  const t = useT();
  const terr = useTError();
  const toast = useApp((s) => s.toast);
  const patchPdfLiterature = useApp((s) => s.patchPdfLiterature);
  const meta = pdf.literature ?? null;
  const [draft, setDraft] = useState<LiteratureMetadata | null>(meta);
  const [showAbstract, setShowAbstract] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [review, setReview] = useState<LiteratureReview | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** 阅读状态行：空间不足时只留图标（稳定探针测量，避免振荡） */
  const statusRowRef = useRef<HTMLDivElement>(null);
  const statusProbeRef = useRef<HTMLDivElement>(null);
  const [statusNarrow, setStatusNarrow] = useState(false);

  // 不再整份同步 meta 到草稿（会冲掉正在输入的其他字段）：
  // 面板已按 pdf.id 重挂载，初始草稿即来自 meta；这里只跟随外部“阅读状态”变化
  useEffect(() => {
    if (!meta) return;
    setDraft((d) =>
      d && d.readingStatus !== meta.readingStatus ? { ...d, readingStatus: meta.readingStatus } : d,
    );
  }, [meta?.readingStatus]);
  useEffect(() => {
    window.pkm
      .getLiteratureReview(pdf.id)
      .then(setReview)
      .catch(() => undefined);
  }, [pdf.id]);

  /** 元数据字段的本地草稿更新（同时登记未保存状态，供关闭前提示） */
  const patchDraft = (p: Partial<LiteratureMetadata>) => {
    setDraft((d) => ({ ...(d ?? ({} as LiteratureMetadata)), ...p }));
    markMetadataDirty();
  };

  const commit = async (patch: Partial<LiteratureMetadata>): Promise<boolean> => {
    try {
      const updated = await window.pkm.updateLiterature(pdf.id, patch);
      // 只把本次提交的字段合并进草稿，避免服务端整份返回覆盖其他字段正在输入的内容
      setDraft((d) => ({ ...(d ?? ({} as LiteratureMetadata)), ...patch }));
      patchPdfLiterature(pdf.id, updated);
      markMetadataSaved();
      return true;
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
      return false;
    }
  };

  const status = draft?.readingStatus ?? 'unread';
  const inputCls =
    'h-7 w-full rounded-md border border-app-border bg-app-panel2 px-2 text-[11px] outline-none focus:border-app-accent/70';
  const statusItems: Array<[LiteratureMetadata['readingStatus'], string, React.ReactNode]> = [
    ['unread', t('literature.unread'), <Circle key="u" size={12} />],
    ['reading', t('literature.reading'), <BookOpen key="r" size={12} />],
    ['read', t('literature.read'), <CheckCircle2 key="d" size={12} />],
  ];

  /** 面板级保存：元数据整批提交 + 所有结构化字段 flush */
  const doSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (draft) await commit({ ...draft });
      await flushAllLiteratureFields();
      forceLiteratureClean();
      toast('success', t('inspector.saved'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [draft, commit, pdf.id, t, toast]);
  const doSaveRef = useRef(doSave);
  doSaveRef.current = doSave;

  // 注册为全局保存入口（Ctrl+S / 关闭前“保存并关闭”统一走这里）
  useEffect(() => {
    registerLiteratureSave(() => doSaveRef.current());
    return () => registerLiteratureSave(null);
  }, []);

  // Ctrl+S 保存文献管理内容
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSaveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 阅读状态行窄栏判断（探针内容恒定，不会被“隐藏文字→不再溢出”反向影响）
  useEffect(() => {
    const el = statusRowRef.current;
    const probe = statusProbeRef.current;
    if (!el || !probe) return;
    const check = () => setStatusNarrow(probe.scrollWidth > el.clientWidth + 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const reviewFields: Array<[LiteratureReviewField, string]> = [
    ['background', t('review.background')],
    ['researchQuestion', t('review.researchQuestion')],
    ['existingMethods', t('review.existingMethods')],
    ['existingMethodProblems', t('review.existingMethodProblems')],
    ['coreMethod', t('review.coreMethod')],
    ['innovations', t('review.innovations')],
    ['experiments', t('review.experiments')],
    ['limitations', t('review.limitations')],
    ['myUnderstanding', t('review.myUnderstanding')],
    ['myQuestions', t('review.myQuestions')],
    ['researchImplications', t('review.researchImplications')],
    ['oneSentenceSummary', t('review.oneSentenceSummary')],
  ];

  return (
    <div>
      {/* 顶部操作栏：导出文献 + 保存（始终可见，Ctrl+S 等效） */}
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-1.5 border-b border-app-border bg-app-panel px-3.5 py-2">
        <Button size="sm" variant="outline" onClick={() => setExportOpen(true)}>
          <FileDown size={12} /> {t('export.title')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => void doSaveRef.current()}
          title={`${t('inspector.save')} (Ctrl+S)`}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {saving ? t('common.saving') : t('inspector.save')}
        </Button>
      </div>
      <div className="space-y-4 px-3.5 py-3">
      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
          {t('literature.title')}
        </div>
        <div className="space-y-1.5">
          <Field label={t('literature.litTitle')}>
            <input
              className={inputCls}
              value={draft?.title ?? ''}
              onChange={(e) => patchDraft({ title: e.target.value })}
              onBlur={(e) => void commit({ title: e.target.value.trim() })}
            />
          </Field>
          <Field label={t('literature.authors')}>
            <input
              className={inputCls}
              value={draft?.authors ?? ''}
              onChange={(e) => patchDraft({ authors: e.target.value })}
              onBlur={(e) => void commit({ authors: e.target.value.trim() })}
            />
          </Field>
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <Field label={t('literature.journal')}>
                <input
                  className={inputCls}
                  value={draft?.journal ?? ''}
                  onChange={(e) => patchDraft({ journal: e.target.value })}
                  onBlur={(e) => void commit({ journal: e.target.value.trim() })}
                />
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label={t('literature.conference')}>
                <input
                  className={inputCls}
                  value={draft?.conference ?? ''}
                  onChange={(e) => patchDraft({ conference: e.target.value })}
                  onBlur={(e) => void commit({ conference: e.target.value.trim() })}
                />
              </Field>
            </div>
          </div>
          <div className="flex gap-1.5">
            <div className="w-16">
              <Field label={t('literature.year')}>
                <input
                  className={inputCls}
                  inputMode="numeric"
                  value={draft?.year ?? ''}
                  onChange={(e) => patchDraft({ year: e.target.value ? Number(e.target.value) : null })}
                  onBlur={(e) => void commit({ year: e.target.value ? Number(e.target.value) : null })}
                />
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label={t('literature.doi')}>
                <input
                  className={inputCls}
                  value={draft?.doi ?? ''}
                  onChange={(e) => patchDraft({ doi: e.target.value })}
                  onBlur={(e) => void commit({ doi: e.target.value.trim() })}
                />
              </Field>
            </div>
          </div>
          <Field label={t('literature.url')}>
            <input
              className={inputCls}
              value={draft?.url ?? ''}
              onChange={(e) => patchDraft({ url: e.target.value })}
              onBlur={(e) => void commit({ url: e.target.value.trim() })}
            />
          </Field>
          <Field label={t('literature.keywords')}>
            <input
              className={inputCls}
              value={draft?.keywords ?? ''}
              onChange={(e) => patchDraft({ keywords: e.target.value })}
              onBlur={(e) => void commit({ keywords: e.target.value.trim() })}
            />
          </Field>
          <div>
            <button
              className="flex items-center gap-1 text-[10.5px] text-app-muted transition-colors hover:text-app-text"
              onClick={() => setShowAbstract((v) => !v)}
            >
              <ChevronDown size={11} className={`transition-transform ${showAbstract ? 'rotate-180' : ''}`} />
              {t('literature.abstract')}
            </button>
            {showAbstract && (
              <textarea
                className="mt-1 h-24 w-full resize-y rounded-md border border-app-border bg-app-panel2 p-2 text-[11px] outline-none focus:border-app-accent/70"
                value={draft?.abstract ?? ''}
                onChange={(e) => patchDraft({ abstract: e.target.value })}
                onBlur={(e) => void commit({ abstract: e.target.value })}
              />
            )}
          </div>
        </div>
      </section>

      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
          {t('literature.readingStatus')}
        </div>
        <div ref={statusRowRef} className="relative flex flex-nowrap items-center gap-1 overflow-hidden">
          {/* 稳定测量探针：始终包含完整图标+文字，窄栏判断不会被自身内容变化反向影响 */}
          <div
            ref={statusProbeRef}
            aria-hidden
            className="invisible pointer-events-none absolute inset-0 flex flex-nowrap items-center gap-1 overflow-hidden"
          >
            {statusItems.map(([s, label, icon]) => (
              <span
                key={s}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-[10px]"
              >
                {icon}
                {label}
              </span>
            ))}
          </div>
          {statusItems.map(([s, label, icon]) => (
            <button
              key={s}
              title={statusNarrow ? label : undefined}
              aria-label={statusNarrow ? label : undefined}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                status === s
                  ? 'border-app-accent/60 bg-app-accent/15 text-app-text'
                  : 'border-app-border text-app-muted hover:text-app-text'
              }`}
              onClick={() => void commit({ readingStatus: s })}
            >
              <span className={status === s ? 'text-app-accent' : ''}>{icon}</span>
              {!statusNarrow && label}
            </button>
          ))}
          {status !== 'read' && (
            <button
              className="ml-auto text-[10.5px] text-app-accent hover:underline"
              onClick={() => void commit({ readingStatus: 'read' })}
            >
              {t('literature.markRead')}
            </button>
          )}
        </div>
      </section>

      <TagSection pdf={pdf} />

      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
          {t('literature.review')}
        </div>
        <div className="space-y-3">
          {reviewFields.map(([field, label]) => (
            <ReviewField key={field} pdfId={pdf.id} field={field} label={label} value={review?.[field] ?? ''} />
          ))}
        </div>
      </section>

      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} currentPdf={pdf} />
      </div>
    </div>
  );
}

/** 结构化阅读记录字段：多行文本框，输入停止后自动保存，失焦强制保存 */
function ReviewField({
  pdfId,
  field,
  label,
  value,
}: {
  pdfId: number;
  field: LiteratureReviewField;
  label: string;
  value: string;
}) {
  const [v, setV] = useState(value);
  const dirtyRef = useRef(false);
  const flushRef = useRef<() => void>(() => undefined);
  const vRef = useRef(v);
  vRef.current = v;
  useEffect(() => {
    setV(value);
    dirtyRef.current = false;
  }, [value, pdfId]);
  const flush = () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    void window.pkm
      .saveLiteratureReviewField(pdfId, field, v)
      .catch(() => {
        dirtyRef.current = true;
      });
  };
  flushRef.current = flush;
  // 登记到面板级保存编排：全局保存 / 未保存查询 / 放弃修改清理
  useEffect(() => {
    const unregFlush = registerFieldFlush(() => flushRef.current());
    const unregDirty = registerFieldDirty(() => dirtyRef.current);
    const unregClean = registerFieldCleaner(() => {
      dirtyRef.current = false;
    });
    return () => {
      unregFlush();
      unregDirty();
      unregClean();
    };
  }, [pdfId, field]);
  // 卸载时兜底保存：切换 Tab / 关闭面板时，防抖窗口内的内容不丢失。
  // 「不保存并关闭」路径会先 forceLiteratureClean 清掉脏标记，因此不会误保存。
  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void window.pkm
          .saveLiteratureReviewField(pdfId, field, vRef.current)
          .catch(() => undefined);
      }
    };
  }, [pdfId, field]);
  useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = setTimeout(() => flushRef.current(), 400);
    return () => clearTimeout(timer);
  }, [v]);
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-medium text-app-text/90">{label}</div>
      <textarea
        className="min-h-[56px] w-full resize-y rounded-md border border-app-border bg-app-panel2 p-2 text-[11.5px] leading-relaxed outline-none focus:border-app-accent/70"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          dirtyRef.current = true;
        }}
        onBlur={() => flushRef.current()}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9.5px] text-app-muted">{label}</span>
      {children}
    </label>
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

/** 标签选择器：按钮触发下拉，预设/自定义分行展示，可勾选切换、搜索、新建与删除自定义标签 */
function TagPicker({
  presets,
  custom,
  current,
  usageOf,
  onAdd,
  onRemove,
  onCreate,
  onDelete,
}: {
  presets: string[];
  custom: Tag[];
  current: Tag[];
  usageOf: (tagId: number) => number;
  onAdd: (name: string) => void;
  onRemove: (tagId: number) => void;
  onCreate: (name: string) => void;
  onDelete: (tagId: number) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [createValue, setCreateValue] = useState('');
  const [confirmDel, setConfirmDel] = useState<Tag | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLInputElement>(null);

  const closePanel = () => {
    setOpen(false);
    setConfirmDel(null);
    setCreating(false);
    setQuery('');
  };

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closePanel();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = normalizeTagName(query).toLowerCase();
  const match = (name: string) => {
    const n = normalizeTagName(name).toLowerCase();
    return !q || n.includes(q);
  };
  const presetRows = presets.filter(match);
  const customRows = custom.filter((tg) => match(tg.name));

  /** 点击标签行：已选则从当前文件移除（不删标签定义），未选则添加 */
  const toggle = (tg: Tag) => {
    const hit = current.find((c) => c.id === tg.id || c.name === tg.name);
    if (hit) onRemove(hit.id);
    else onAdd(normalizeTagName(tg.name));
  };

  const submitCreate = () => {
    const n = normalizeTagName(createValue);
    if (!n) return;
    onCreate(n);
    setCreateValue('');
    setCreating(false);
    createRef.current?.focus();
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        className="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-app-border bg-app-panel2 text-[11px] text-app-muted transition-colors hover:border-app-accent/40 hover:text-app-text"
        onClick={() => (open ? closePanel() : setOpen(true))}
      >
        <Plus size={12} /> {t('inspector.tagAdd')} <ChevronDown size={11} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-full rounded-lg border border-app-border bg-app-panel p-2 shadow-md">
          <div className="mb-1.5 px-1 text-[10.5px] font-semibold text-app-text/90">
            {t('inspector.tagAddTitle')}
          </div>
          <div className="mb-2 flex items-center gap-1 rounded-md border border-app-border bg-app-panel2 px-2 focus-within:border-app-accent/70">
            <Search size={11} className="shrink-0 text-app-muted" />
            <input
              className="h-6 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-app-muted"
              placeholder={t('inspector.tagSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {confirmDel ? (
            <div className="rounded-md border border-app-danger/30 bg-app-danger/5 p-2">
              <p className="text-[11px] leading-relaxed text-app-text/90">
                {usageOf(confirmDel.id) > 0
                  ? t('inspector.tagDeleteConfirm', {
                      name: confirmDel.name,
                      n: usageOf(confirmDel.id),
                    })
                  : t('inspector.tagDeleteConfirmZero', { name: confirmDel.name })}
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  className="px-2 py-1 text-[10.5px] text-app-muted hover:text-app-text"
                  onClick={() => setConfirmDel(null)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="rounded-md bg-app-danger px-2 py-1 text-[10.5px] font-medium text-white hover:opacity-90"
                  onClick={() => {
                    onDelete(confirmDel.id);
                    setConfirmDel(null);
                  }}
                >
                  {t('settings.tagDeleteConfirmBtn')}
                </button>
              </div>
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto pr-0.5">
              {presetRows.length > 0 && (
                <div className="mb-2">
                  <div className="px-1 pb-1 text-[9.5px] font-medium uppercase tracking-wide text-app-muted">
                    {t('inspector.tagPresets')}
                  </div>
                  <div className="flex flex-col">
                    {presetRows.map((name) => (
                      <TagRow
                        key={`p:${name}`}
                        label={name}
                        checked={current.some((c) => c.name === name)}
                        onToggle={() =>
                          toggle(
                            current.find((c) => c.name === name) ?? {
                              id: -1,
                              name,
                              createdTime: '',
                            },
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
              {customRows.length > 0 && (
                <div className="mb-2">
                  <div className="px-1 pb-1 text-[9.5px] font-medium uppercase tracking-wide text-app-muted">
                    {t('inspector.tagCustom')}
                  </div>
                  <div className="flex flex-col">
                    {customRows.map((tg) => (
                      <TagRow
                        key={`c:${tg.id}`}
                        label={tg.name}
                        checked={current.some((c) => c.id === tg.id)}
                        onToggle={() => toggle(tg)}
                        deleteTitle={t('inspector.tagDeleteDefinition')}
                        onDelete={() => setConfirmDel(tg)}
                      />
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                className="flex h-6 w-full items-center gap-1 rounded-md px-1 text-[10.5px] text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-accent"
                onClick={() => {
                  setCreating((v) => !v);
                  requestAnimationFrame(() => createRef.current?.focus());
                }}
              >
                <Plus size={11} /> {t('inspector.tagAddCustom')}
              </button>
              {creating && (
                <div className="mt-1.5 rounded-md border border-app-border bg-app-panel2 p-1.5">
                  <div className="px-1 pb-1 text-[9.5px] font-medium uppercase tracking-wide text-app-muted">
                    {t('inspector.tagNewTitle')}
                  </div>
                  <div className="flex items-center gap-1">
                    <Hash size={11} className="shrink-0 text-app-muted" />
                    <input
                      ref={createRef}
                      className="h-6 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-app-muted"
                      placeholder={t('inspector.tagNewPlaceholder')}
                      value={createValue}
                      onChange={(e) => setCreateValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitCreate();
                        else if (e.key === 'Escape') {
                          setCreating(false);
                          setCreateValue('');
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="rounded-md bg-app-accent px-2 py-0.5 text-[10.5px] font-medium text-white hover:opacity-90"
                      onClick={submitCreate}
                    >
                      {t('inspector.tagCreate')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 下拉框中的标签行：✓ 表示当前文件已拥有；右侧 × 仅对自定义标签提供（删除标签定义） */
function TagRow({
  label,
  checked,
  onToggle,
  deleteTitle,
  onDelete,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  deleteTitle?: string;
  onDelete?: () => void;
}) {
  return (
    <div className="group flex items-center rounded-md px-1 py-0.5 transition-colors hover:bg-app-panel2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left text-[11px] text-app-text/90 hover:text-app-text"
        onClick={onToggle}
      >
        <Hash size={10} className="shrink-0 text-app-muted" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {checked && <Check size={12} className="shrink-0 text-app-accent" />}
      </button>
      {onDelete && (
        <button
          type="button"
          title={deleteTitle}
          className="shrink-0 rounded p-0.5 text-app-muted/50 opacity-60 transition-opacity hover:text-app-danger group-hover:opacity-100"
          onClick={onDelete}
        >
          <X size={11} />
        </button>
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
  /** 保存完成后的短暂提示文案（i18n key），2 秒后自动消失 */
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteFile, setNoteFile] = useState<string | null>(null);
  const [noteDir, setNoteDir] = useState<string | null>(null);
  const [refs, setRefs] = useState<NoteReference[]>([]);
  const refsRef = useRef<NoteReference[]>([]);
  refsRef.current = refs;
  const [notesDir, setNotesDir] = useState('');
  const noteRevision = useApp((s) => s.noteRevision);
  const [exporting, setExporting] = useState(false);
  const loadedRef = useRef(false);
  const mdRef = useRef('');
  const dirtyRef = useRef(false);
  const autoSaveRef = useRef(autoSave);
  mdRef.current = md;
  dirtyRef.current = dirty;
  autoSaveRef.current = autoSave;

  useEffect(() => {
    loadedRef.current = false;
    setLoading(true);
    void (async () => {
      try {
        const note = await window.pkm.getNote(pdf.id);
        if (note) {
          setMd(note.markdown);
          setNoteFile(note.noteFile ?? null);
          setNoteDir(note.noteDir ?? null);
          setRefs(await window.pkm.listNoteReferences(note.id));
        }
      } catch {
        /* ignore */
      }
      loadedRef.current = true;
      setDirty(false);
      setLoading(false);
    })();
  }, [pdf.id, noteRevision]);

  const onRefClick = (refId: number) => {
    const ref = refsRef.current.find((r) => r.id === refId);
    if (!ref) return;
    const s = useApp.getState();
    s.openPdf(ref.pdfId);
    let top: number | null = null;
    if (ref.rect) {
      try {
        const quads = JSON.parse(ref.rect) as Array<{ y: number }>;
        if (Array.isArray(quads) && quads.length) top = Math.min(...quads.map((q) => q.y));
      } catch {
        /* ignore */
      }
    }
    s.requestJump(ref.page, top);
  };

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
        setDirty(false);
        setJustSaved(silent ? 'inspector.autoSaved' : 'inspector.saved');
        setTimeout(() => setJustSaved((v) => (v === (silent ? 'inspector.autoSaved' : 'inspector.saved') ? null : v)), 2000);
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
    // 输入即保存：仅保留极短防抖避免每次击键都触发 IPC
    const timer = setTimeout(() => void save(md, true), 100);
    return () => clearTimeout(timer);
  }, [md, dirty, autoSave, save]);

  // 组件卸载（切换 PDF / 面板 tab / 关闭）前强制落库，防止编辑内容丢失
  useEffect(() => {
    return () => {
      if (loadedRef.current && dirtyRef.current && autoSaveRef.current && mdRef.current != null) {
        void window.pkm.saveNote(pdf.id, mdRef.current).catch(() => undefined);
      }
    };
  }, [pdf.id]);

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
    if (src.startsWith('assets/')) {
      const base = (noteDir ?? notesDir)?.replace(/\\/g, '/');
      if (base) return `file://${base}/${src}`;
    }
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
        <div className="flex flex-wrap items-center justify-between gap-y-1 border-b border-app-border px-3 py-1.5">
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
        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-app-muted">
          <Button
            size="sm"
            variant="outline"
            title={t('note.screenshotHint')}
            onClick={() => useApp.getState().setScreenshotMode(true)}
          >
            <Camera size={12} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={exporting || !md.trim()}
            title={t('note.exportPdf')}
            onClick={() => void exportPdf()}
          >
            <FileDown size={12} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || !md.trim()}
            title={t('note.saveHint')}
            onClick={() => void save(md)}
          >
            <Save size={12} />
          </Button>
          {saving ? (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <Loader2 size={10} className="animate-spin" /> {t('common.saving')}
            </span>
          ) : justSaved ? (
            <span className="flex items-center gap-1 whitespace-nowrap text-emerald-400">
              <Check size={10} /> {t(justSaved)}
            </span>
          ) : dirty ? (
            <span className="whitespace-nowrap">{t('inspector.unsaved')}</span>
          ) : (
            <span className="flex items-center gap-1 whitespace-nowrap">
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
                a: ({ href, children }) => {
                  const m = /^minepdf:\/\/ref\/(\d+)$/.exec(href ?? '');
                  if (m) {
                    return (
                      <a
                        href="#"
                        title={t('literature.jumpRef')}
                        className="cursor-pointer rounded border border-app-accent/30 bg-app-accent/10 px-1 py-px text-[10px] font-medium text-app-accent no-underline transition-colors hover:bg-app-accent/20"
                        onClick={(e) => {
                          e.preventDefault();
                          onRefClick(Number(m[1]));
                        }}
                      >
                        {children}
                      </a>
                    );
                  }
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
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
          {noteFile
            ? `${noteDir ? `${noteDir.split(/[\\/]/).pop()} / ` : ''}${noteFile.split(/[\\/]/).pop()}`
            : t('inspector.noteMirror', { id: pdf.id })}
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
