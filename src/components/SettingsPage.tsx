import {
  ArrowLeft,
  Activity,
  BookOpen,
  Database,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderInput,
  FolderOpen,
  Hand,
  Hash,
  Info,
  Languages,
  Library,
  Moon,
  MousePointer2,
  Palette,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Sun,
  Trash2,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useT, useTError } from '../i18n';
import type { AppSettings } from '../shared/types';
import { DEFAULT_TAG_PRESETS, isPresetTag, normalizeTagName } from '../lib/tags';
import { renderDiag } from '../lib/renderDiag';
import { useApp } from '../store';
import { AboutModal } from './AboutModal';
import { UpdateModal } from './UpdateModal';
import { Button, Modal, Toggle } from './ui';

export function SettingsPage() {
  const t = useT();
  const terr = useTError();
  const settings = useApp((s) => s.settings);
  const setView = useApp((s) => s.setView);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const tags = useApp((s) => s.tags);
  const pdfs = useApp((s) => s.pdfs);
  const inboxPdfs = useApp((s) => s.inboxPdfs);
  const [busy, setBusy] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [defaultPdf, setDefaultPdf] = useState<boolean | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    name: string;
    usage: number;
    preset: boolean;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  /** 重命名草稿的 ref：输入框失焦（含 Escape 取消后的失焦）时以最新状态判断是否提交 */
  const renamingRef = useRef<{ id: number; value: string } | null>(null);

  useEffect(() => {
    void window.pkm
      .getAppInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => undefined);
    void window.pkm
      .isDefaultPdfApp()
      .then(setDefaultPdf)
      .catch(() => setDefaultPdf(null));
    const onFocus = () => {
      void window.pkm
        .isDefaultPdfApp()
        .then(setDefaultPdf)
        .catch(() => setDefaultPdf(null));
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const update = async (patch: Partial<AppSettings>) => {
    try {
      await window.pkm.updateSettings(patch);
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const chooseImportDir = async () => {
    const dir = await window.pkm.chooseDirectory(t('settings.defaultImportDir'));
    if (dir) {
      await update({ defaultImportDir: dir });
      toast('success', t('settings.importDirUpdated'));
    }
  };

  const doBackup = async () => {
    setBusy(true);
    try {
      const res = await window.pkm.backupData();
      toast('success', t('settings.backupDone', { path: res.path }));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  // ---------- 标签管理 ----------
  const disabledPresets = settings.disabledTagPresets ?? [];
  const countTag = (tagId: number) =>
    pdfs.filter((p) => p.tags.some((tg) => tg.id === tagId)).length +
    inboxPdfs.filter((p) => p.tags.some((tg) => tg.id === tagId)).length;
  const tagRows: Array<{
    id: number | null;
    name: string;
    usage: number;
    preset: boolean;
    hidden: boolean;
  }> = [
    ...DEFAULT_TAG_PRESETS.map((name) => {
      const db = tags.find((t) => t.name === name);
      return {
        id: db?.id ?? null,
        name,
        usage: db ? countTag(db.id) : 0,
        preset: true,
        hidden: disabledPresets.includes(name),
      };
    }),
    ...tags
      .filter((t) => !isPresetTag(t.name))
      .map((t) => ({
        id: t.id,
        name: t.name,
        usage: countTag(t.id),
        preset: false,
        hidden: false,
      })),
  ];

  const togglePreset = async (name: string) => {
    const next = disabledPresets.includes(name)
      ? disabledPresets.filter((x) => x !== name)
      : [...disabledPresets, name];
    await update({ disabledTagPresets: next });
  };

  const restoreDefaults = async () => {
    await update({ disabledTagPresets: [] });
    toast('success', t('settings.tagsRestored'));
  };

  const requestDelete = (row: (typeof tagRows)[number]) => {
    if (row.id == null) return;
    setDeleteTarget({ id: row.id, name: row.name, usage: row.usage, preset: row.preset });
  };

  const doDeleteTag = async () => {
    if (!deleteTarget) return;
    try {
      // 删除默认标签：同时隐藏，避免它继续出现在推荐列表（恢复默认标签可还原）
      if (deleteTarget.preset && !disabledPresets.includes(deleteTarget.name)) {
        await window.pkm.updateSettings({
          disabledTagPresets: [...disabledPresets, deleteTarget.name],
        });
      }
      await window.pkm.deleteTag(deleteTarget.id);
      await refresh();
      toast('success', t('settings.tagDeleted', { name: deleteTarget.name }));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
    setDeleteTarget(null);
  };

  const startRename = (row: (typeof tagRows)[number]) => {
    if (row.preset || row.id == null) return;
    renamingRef.current = { id: row.id, value: row.name };
    setRenaming(renamingRef.current);
  };

  const commitRename = async () => {
    const r = renamingRef.current;
    if (!r) return;
    const name = normalizeTagName(r.value);
    const old = tags.find((t) => t.id === r.id);
    try {
      if (name && old && name !== old.name) {
        const res = await window.pkm.renameTag(r.id, name);
        if (res && res.id !== r.id) {
          toast('info', t('settings.tagMerged', { name: res.name }));
        }
      }
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
    renamingRef.current = null;
    setRenaming(null);
  };

  const cancelRename = () => {
    renamingRef.current = null;
    setRenaming(null);
  };

  const applyDefaultPdf = async () => {
    setBusy(true);
    try {
      const res = await window.pkm.setPdfAssociation(true);
      setDefaultPdf(res);
      if (res) toast('success', t('settings.defaultPdfApplied'));
      else toast('info', t('settings.defaultPdfNeedsConfirm'));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const cancelDefaultPdf = async () => {
    setBusy(true);
    try {
      await window.pkm.setPdfAssociation(false);
      setDefaultPdf(false);
      toast('success', t('settings.defaultPdfCancelled'));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-app-base">
      <div className="mx-auto max-w-2xl px-8 py-6">
        <button
          className="mb-4 flex items-center gap-1.5 text-xs text-app-muted transition-colors hover:text-app-text"
          onClick={() => setView('library')}
        >
          <ArrowLeft size={13} /> {t('settings.back')}
        </button>
        <h1 className="mb-1 text-lg font-semibold">{t('settings.title')}</h1>
        <p className="mb-6 text-[11.5px] text-app-muted">{t('settings.desc')}</p>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Palette size={14} className="text-app-accent" /> {t('settings.appearance')}
          </div>
          <div className="flex gap-2">
            <button
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs transition-colors ${
                settings.theme === 'dark'
                  ? 'border-app-accent bg-app-accent/15 text-app-text'
                  : 'border-app-border text-app-muted hover:text-app-text'
              }`}
              onClick={() => void update({ theme: 'dark' })}
            >
              <Moon size={13} /> {t('settings.dark')}
            </button>
            <button
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs transition-colors ${
                settings.theme === 'light'
                  ? 'border-app-accent bg-app-accent/15 text-app-text'
                  : 'border-app-border text-app-muted hover:text-app-text'
              }`}
              onClick={() => void update({ theme: 'light' })}
            >
              <Sun size={13} /> {t('settings.light')}
            </button>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Languages size={13} className="shrink-0 text-app-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-app-text/90">{t('settings.language')}</div>
              <div className="text-[10.5px] text-app-muted">{t('settings.languageHint')}</div>
            </div>
            <select
              className="h-8 rounded-md border border-app-border bg-app-panel2 px-2 text-xs outline-none focus:border-app-accent/70"
              value={settings.language}
              onChange={(e) => {
                void update({ language: e.target.value as AppSettings['language'] });
                toast('info', t('settings.updateNeedsRestart'));
              }}
              aria-label={t('settings.language')}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <MousePointer2 size={13} className="shrink-0 text-app-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-app-text/90">{t('settings.uiFontScale')}</div>
              <div className="text-[10.5px] text-app-muted">{t('settings.uiFontScaleHint')}</div>
            </div>
            <div className="flex overflow-hidden rounded-md border border-app-border">
              {([0.9, 1, 1.1] as const).map((scale, i) => (
                <button
                  key={scale}
                  className={`px-2.5 py-1 text-xs transition-colors ${
                    Math.abs(settings.uiFontScale - scale) < 0.001
                      ? 'bg-app-accent/20 text-app-text'
                      : 'bg-app-panel2 text-app-muted hover:text-app-text'
                  } ${i > 0 ? 'border-l border-app-border' : ''}`}
                  onClick={() => void update({ uiFontScale: scale })}
                >
                  {t(scale === 0.9 ? 'settings.fontSmall' : scale === 1 ? 'settings.fontMedium' : 'settings.fontLarge')}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <BookOpen size={14} className="text-app-accent" /> {t('settings.readSection')}
          </div>
          <div className="flex items-center gap-3">
            <Library size={13} className="shrink-0 text-app-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-app-text/90">{t('settings.autoCollapseSidebar')}</div>
              <div className="text-[10.5px] text-app-muted">{t('settings.autoCollapseSidebarHint')}</div>
            </div>
            <Toggle
              checked={settings.autoCollapseSidebar}
              onChange={(v) => void update({ autoCollapseSidebar: v })}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Hand size={13} className="shrink-0 text-app-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-app-text/90">{t('settings.rightDragPan')}</div>
              <div className="text-[10.5px] text-app-muted">{t('settings.rightDragPanHint')}</div>
            </div>
            <Toggle
              checked={settings.rightDragPan}
              onChange={(v) => void update({ rightDragPan: v })}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <MousePointer2 size={13} className="shrink-0 text-app-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-app-text/90">{t('settings.dblClickTogglePanels')}</div>
              <div className="text-[10.5px] text-app-muted">{t('settings.dblClickTogglePanelsHint')}</div>
            </div>
            <Toggle
              checked={settings.dblClickTogglePanels}
              onChange={(v) => void update({ dblClickTogglePanels: v })}
            />
          </div>
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Library size={14} className="text-app-accent" /> {t('settings.librarySection')}
          </div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11.5px] text-app-text/90">{t('settings.defaultImportDir')}</div>
              <div className="mt-0.5 truncate text-[10.5px] text-app-muted">
                {settings.defaultImportDir || t('settings.notSet')}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void chooseImportDir()}>
              {t('settings.choose')}
            </Button>
          </div>
          <div className="mb-2 rounded-lg bg-app-panel2 px-3 py-2 text-[11px] text-app-muted">
            {settings.libraryPdfDir}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => void window.pkm.openLibraryFolder()}>
              <FolderInput size={12} /> {t('settings.openLibraryFolder')}
            </Button>
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-app-muted/80">{t('settings.libraryHint')}</p>
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Save size={14} className="text-app-accent" /> {t('settings.notesSection')}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11.5px] text-app-text/90">{t('settings.autoSaveNotes')}</div>
              <div className="text-[10.5px] text-app-muted">
                {settings.autoSave ? t('settings.autoSaveOn') : t('settings.autoSaveOff')}
              </div>
            </div>
            <Toggle checked={settings.autoSave} onChange={(v) => void update({ autoSave: v })} />
          </div>
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <RefreshCw size={14} className="text-app-accent" /> {t('settings.updateSection')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => setUpdateOpen(true)}>
              <RefreshCw size={12} /> {t('settings.checkUpdate')}
            </Button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-app-border pt-3">
            <div className="min-w-0">
              <div className="text-[11.5px] text-app-text/90">{t('settings.autoCheckUpdate')}</div>
              <div className="text-[10.5px] text-app-muted">{t('settings.autoCheckHint')}</div>
            </div>
            <Toggle
              checked={settings.updateAutoCheck}
              onChange={(v) => void update({ updateAutoCheck: v })}
            />
          </div>
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <FileText size={14} className="text-app-accent" /> {t('settings.defaultPdf')}
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-app-text/90">
                {t('settings.defaultPdfStatus', {
                  status:
                    defaultPdf === true
                      ? t('settings.defaultPdfYes')
                      : defaultPdf === false
                        ? t('settings.defaultPdfNo')
                        : t('settings.defaultPdfUnknown'),
                })}
              </div>
            </div>
            <Button
              size="sm"
              variant={defaultPdf ? 'outline' : 'primary'}
              className="shrink-0 whitespace-nowrap"
              disabled={busy}
              onClick={() =>
                defaultPdf ? void cancelDefaultPdf() : void applyDefaultPdf()
              }
            >
              {defaultPdf ? t('settings.cancelDefaultPdf') : t('settings.setupDefaultPdf')}
            </Button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-app-muted/80">{t('settings.defaultPdfHint')}</p>
        </section>

        <section className="rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Database size={14} className="text-app-accent" /> {t('settings.dataSection')}
          </div>
          <div className="mb-2 rounded-lg bg-app-panel2 px-3 py-2 text-[11px] text-app-muted">
            {settings.libraryPath}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void window.pkm.openDataFolder()}>
              <FolderOpen size={12} /> {t('settings.openDataFolder')}
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void doBackup()}>
              <Download size={12} /> {busy ? t('settings.backingUp') : t('settings.backupNow')}
            </Button>
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-app-muted/80">{t('settings.backupHint')}</p>
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Hash size={14} className="text-app-accent" /> {t('settings.tagsSection')}
          </div>
          <p className="mb-3 text-[10.5px] leading-relaxed text-app-muted/80">{t('settings.tagsHint')}</p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void restoreDefaults()}>
              <RotateCcw size={12} /> {t('settings.restoreDefaultTags')}
            </Button>
            {disabledPresets.length > 0 && (
              <span className="text-[10.5px] text-app-muted">
                {t('settings.hiddenPresets', { n: disabledPresets.length })}
              </span>
            )}
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {tagRows.map((row) => (
              <div
                key={`${row.preset ? 'p' : 'c'}:${row.name}`}
                className="flex items-center gap-2 rounded-lg bg-app-panel2 px-2.5 py-1.5"
              >
                <Hash size={11} className="shrink-0 text-app-muted" />
                {renaming && renaming.id === row.id ? (
                  <input
                    autoFocus
                    className="h-6 min-w-0 flex-1 rounded border border-app-border bg-app-panel px-1.5 text-[11.5px] outline-none focus:border-app-accent/70"
                    value={renaming.value}
                    onChange={(e) => {
                      renamingRef.current = { id: renaming.id, value: e.target.value };
                      setRenaming(renamingRef.current);
                    }}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      else if (e.key === 'Escape') cancelRename();
                    }}
                  />
                ) : (
                  <span
                    className={`min-w-0 flex-1 truncate text-[11.5px] ${
                      row.hidden ? 'text-app-muted/60 line-through' : 'text-app-text/90'
                    }`}
                  >
                    #{row.name}
                  </span>
                )}
                <span className="shrink-0 text-[10px] tabular-nums text-app-muted">
                  {t('settings.tagUsage', { n: row.usage })}
                </span>
                {row.preset ? (
                  <button
                    className="shrink-0 p-0.5 text-app-muted transition-colors hover:text-app-text"
                    title={row.hidden ? t('settings.tagShow') : t('settings.tagHide')}
                    onClick={() => void togglePreset(row.name)}
                  >
                    {row.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                ) : (
                  !(renaming && renaming.id === row.id) && (
                    <button
                      className="shrink-0 p-0.5 text-app-muted transition-colors hover:text-app-text"
                      title={t('settings.tagRename')}
                      onClick={() => startRename(row)}
                    >
                      <Pencil size={12} />
                    </button>
                  )
                )}
                {row.id != null && (
                  <button
                    className="shrink-0 p-0.5 text-app-muted transition-colors hover:text-app-danger"
                    title={t('settings.tagDelete')}
                    onClick={() => requestDelete(row)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
            {tagRows.length === 0 && (
              <p className="text-[11px] text-app-muted">{t('settings.tagsEmpty')}</p>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Info size={14} className="text-app-accent" /> {t('settings.about')}
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11.5px] text-app-text/90">{t('settings.aboutHint')}</div>
              <div className="mt-0.5 text-[10.5px] text-app-muted">
                {t('about.version')}：v{appVersion}
              </div>
            </div>
            <Button size="sm" variant="primary" onClick={() => setAboutOpen(true)}>
              <Info size={12} /> {t('settings.aboutOpen')}
            </Button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-app-border pt-3">
            <div className="min-w-0">
              <div className="text-[11.5px] text-app-text/90">{t('settings.renderDiag')}</div>
              <div className="mt-0.5 text-[10.5px] text-app-muted">{t('settings.renderDiagHint')}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                renderDiag.toggle();
                toast(
                  'info',
                  renderDiag.getState().enabled
                    ? t('settings.renderDiagOn')
                    : t('settings.renderDiagOff'),
                );
              }}
            >
              <Activity size={12} />
              {t('settings.renderDiagToggle')}
            </Button>
          </div>
        </section>
      </div>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
      <Modal
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title={t('settings.tagDeleteTitle')}
        width={400}
      >
        {deleteTarget && (
          <div>
            <p className="text-[12.5px] leading-relaxed text-app-text/90">
              {deleteTarget.usage > 0
                ? t('settings.tagDeleteConfirm', {
                    name: deleteTarget.name,
                    n: deleteTarget.usage,
                  })
                : t('settings.tagDeleteConfirmZero', { name: deleteTarget.name })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={() => void doDeleteTag()}>
                {t('settings.tagDeleteConfirmBtn')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}
