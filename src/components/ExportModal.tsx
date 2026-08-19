import React, { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { useT } from '../i18n';
import type { ExportFormat, PdfRecord } from '../shared/types';
import { useApp } from '../store';
import { Button, Modal } from './ui';

type Scope = 'current' | 'filtered' | 'all' | 'custom';

/**
 * 导出文献：范围（当前文献 / 当前筛选结果 / 全部文献 / 自定义选择）+ 格式（Excel/CSV）。
 * 顺序严格跟随当前列表顺序；自定义选择支持搜索与全选。
 */
export function ExportModal({
  open,
  onClose,
  currentPdf,
}: {
  open: boolean;
  onClose: () => void;
  currentPdf: PdfRecord;
}) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const pdfs = useApp((s) => s.pdfs);
  const tagFilterId = useApp((s) => s.tagFilterId);
  const readingFilter = useApp((s) => s.readingFilter);
  const libraryQuery = useApp((s) => s.libraryQuery);
  const [scope, setScope] = useState<Scope>('current');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  /** 当前筛选结果（尊重标签/阅读状态/搜索，顺序 = 知识库顺序） */
  const filtered = useMemo(() => {
    const qq = libraryQuery.trim().toLowerCase();
    return pdfs.filter((p) => {
      if (tagFilterId != null && !p.tags.some((x) => x.id === tagFilterId)) return false;
      if (readingFilter !== 'all' && (p.literature?.readingStatus ?? 'unread') !== readingFilter) {
        return false;
      }
      if (qq) {
        const l = p.literature;
        return `${p.title} ${p.filename} ${l?.title ?? ''} ${l?.authors ?? ''} ${l?.journal ?? ''} ${l?.doi ?? ''} ${l?.keywords ?? ''}`
          .toLowerCase()
          .includes(qq);
      }
      return true;
    });
  }, [pdfs, tagFilterId, readingFilter, libraryQuery]);

  const customList = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return filtered.filter((p) => !qq || `${p.title} ${p.filename}`.toLowerCase().includes(qq));
  }, [filtered, q]);

  const resolveIds = (): number[] => {
    if (scope === 'current') return [currentPdf.id];
    if (scope === 'filtered') return filtered.map((p) => p.id);
    if (scope === 'all') return pdfs.map((p) => p.id);
    return customList.filter((p) => sel.has(p.id)).map((p) => p.id);
  };

  const doExport = async () => {
    const ids = resolveIds();
    if (!ids.length) {
      toast('error', t('export.empty'));
      return;
    }
    setBusy(true);
    try {
      const path = await window.pkm.exportLiterature(ids, format);
      if (path) toast('success', t('export.done', { path }));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const toggleAll = () => {
    if (customList.every((p) => sel.has(p.id))) {
      setSel(new Set());
    } else {
      setSel(new Set(customList.map((p) => p.id)));
    }
  };

  const scopeOptions: Array<[Scope, string]> = [
    ['current', t('export.scopeCurrent')],
    ['filtered', t('export.scopeFiltered')],
    ['all', t('export.scopeAll')],
    ['custom', t('export.scopeCustom')],
  ];

  return (
    <Modal open={open} onClose={onClose} title={t('export.title')} width={460}>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
            {t('export.scope')}
          </div>
          <div className="space-y-1">
            {scopeOptions.map(([s, label]) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-[12px] text-app-text/90">
                <input
                  type="radio"
                  className="accent-[#5b8def]"
                  checked={scope === s}
                  onChange={() => setScope(s)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {scope === 'custom' && (
          <div className="rounded-lg border border-app-border bg-app-panel2 p-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-app-border bg-app-panel px-2">
                <Search size={11} className="shrink-0 text-app-muted" />
                <input
                  className="h-6 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-app-muted"
                  placeholder={t('export.search')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <button className="text-[10.5px] text-app-accent hover:underline" onClick={toggleAll}>
                {t('export.selectAll')}
              </button>
            </div>
            <div className="max-h-52 space-y-0.5 overflow-y-auto pr-1">
              {customList.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11.5px] hover:bg-app-panel"
                >
                  <input
                    type="checkbox"
                    className="accent-[#5b8def]"
                    checked={sel.has(p.id)}
                    onChange={() => {
                      const next = new Set(sel);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      setSel(next);
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                </label>
              ))}
              {customList.length === 0 && (
                <p className="px-1.5 py-1 text-[10.5px] text-app-muted">{t('export.emptyList')}</p>
              )}
            </div>
            <div className="mt-1 border-t border-app-border pt-1 text-[10.5px] text-app-muted">
              {t('export.selected', { n: sel.size })}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
            {t('export.format')}
          </div>
          <div className="flex gap-1.5">
            {(
              [
                ['xlsx', 'Excel (.xlsx)'],
                ['csv', 'CSV (.csv)'],
              ] as Array<[ExportFormat, string]>
            ).map(([f, label]) => (
              <button
                key={f}
                className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                  format === f
                    ? 'border-app-accent/60 bg-app-accent/15 text-app-text'
                    : 'border-app-border text-app-muted hover:text-app-text'
                }`}
                onClick={() => setFormat(f)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void doExport()}>
            <Download size={12} /> {busy ? t('common.saving') : t('export.action')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
