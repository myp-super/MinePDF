import {
  ArrowLeft,
  Database,
  Download,
  FolderInput,
  FolderOpen,
  HardDrive,
  Languages,
  Library,
  Moon,
  Palette,
  RefreshCw,
  Save,
  Sun,
} from 'lucide-react';
import React, { useState } from 'react';
import { useT, useTError } from '../i18n';
import type { AppSettings } from '../shared/types';
import { useApp } from '../store';
import { Button, Toggle } from './ui';

export function SettingsPage() {
  const t = useT();
  const terr = useTError();
  const settings = useApp((s) => s.settings);
  const setView = useApp((s) => s.setView);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateUrlDraft, setUpdateUrlDraft] = useState(settings.updateUrl);

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

  const saveUpdateUrl = async () => {
    try {
      await update({ updateUrl: updateUrlDraft.trim() });
      toast('success', t('settings.updateSourceSaved'));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const res = await window.pkm.checkForUpdates();
      if (res.status === 'up-to-date') toast('success', t('update.upToDate'));
      else if (res.status === 'disabled') toast('info', t('update.disabled'));
      else if (res.status === 'error') toast('error', t('update.error', { msg: res.error ?? '' }));
      else if (res.latest) toast('info', t('update.newVersion', { version: res.latest.version }));
    } finally {
      setChecking(false);
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
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <HardDrive size={14} className="text-app-accent" /> {t('settings.importSection')}
          </div>
          <div className="mb-2 flex items-center justify-between gap-3">
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
          <p className="text-[10.5px] leading-relaxed text-app-muted/80">{t('settings.importHint')}</p>
        </section>

        <section className="mb-4 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Library size={14} className="text-app-accent" /> {t('settings.librarySection')}
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
          <div className="mb-2 flex items-center gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-app-border bg-app-panel2 px-2.5 text-[11.5px] outline-none placeholder:text-app-muted focus:border-app-accent/70"
              placeholder="https://example.com/updates/update.json"
              value={updateUrlDraft}
              onChange={(e) => setUpdateUrlDraft(e.target.value)}
              onBlur={() => void saveUpdateUrl()}
            />
            <Button size="sm" variant="outline" onClick={() => void saveUpdateUrl()}>
              {t('common.confirm')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={checking} onClick={() => void checkUpdate()}>
              <RefreshCw size={12} /> {checking ? t('settings.checking') : t('settings.checkUpdate')}
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
          <p className="mt-2 text-[10.5px] leading-relaxed text-app-muted/80">{t('settings.updateUrlHint')}</p>
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
      </div>
    </main>
  );
}
