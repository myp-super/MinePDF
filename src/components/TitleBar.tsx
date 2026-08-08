import { Copy, Minus, RefreshCw, Search, Square, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { UpdateResult } from '../shared/types';
import { useApp } from '../store';
import { UpdateModal } from './UpdateModal';

/** Custom frameless title bar with global search + update check. */
export function TitleBar() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updatePending, setUpdatePending] = useState<UpdateResult | null>(null);
  const activePdf = useApp((s) => s.pdfs.find((p) => p.id === s.activePdfId));
  const setSearchOpen = useApp((s) => s.setSearchOpen);

  useEffect(() => {
    void window.pkm.isMaximized().then(setMaximized);
    return window.pkm.onMaximizedChange(setMaximized);
  }, []);

  useEffect(() => {
    void window.pkm
      .getAppInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen]);

  // 后台自动检查到新版本时亮起角标
  useEffect(() => {
    return window.pkm.onUpdateAvailable((r) => setUpdatePending(r));
  }, []);

  return (
    <div className="titlebar-drag flex h-9 shrink-0 items-center border-b border-app-border bg-app-panel">
      <div className="flex items-center gap-2 pl-3.5 pr-2">
        <img
          src="./logo.svg"
          alt=""
          width={16}
          height={16}
          className="h-4 w-4"
          draggable={false}
        />
        <span className="text-[12px] font-semibold tracking-wide text-app-text">{t('app.name')}</span>
        <span className="rounded border border-app-border px-1 py-px text-[9px] leading-none text-app-muted">
          v{appVersion}
        </span>
      </div>
      <div className="min-w-0 flex-1 px-4 text-center">
        {activePdf && (
          <span className="truncate text-[11px] text-app-muted">{activePdf.title}</span>
        )}
      </div>
      <div className="titlebar-no-drag flex items-center">
        <button
          className="mr-1.5 flex h-6 items-center gap-1.5 rounded-md border border-app-border px-2.5 text-[11px] text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          onClick={() => setSearchOpen(true)}
          title={t('titlebar.search')}
        >
          <Search size={12} />
          {t('titlebar.searchLabel')}
          <kbd className="rounded border border-app-border bg-app-panel2 px-1 text-[9px] leading-none text-app-muted">
            Ctrl K
          </kbd>
        </button>
        <button
          className="relative flex h-9 w-9 items-center justify-center text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          onClick={() => {
            setUpdatePending(null);
            setUpdateOpen(true);
          }}
          title={t('settings.checkUpdate')}
          aria-label={t('settings.checkUpdate')}
        >
          <RefreshCw size={14} />
          {updatePending && (
            <span className="absolute right-1.5 top-2 h-1.5 w-1.5 rounded-full bg-app-danger" />
          )}
        </button>
        <button
          className="flex h-9 w-11 items-center justify-center text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          onClick={() => void window.pkm.minimize()}
          title={t('titlebar.minimize')}
          aria-label={t('titlebar.minimize')}
        >
          <Minus size={14} />
        </button>
        <button
          className="flex h-9 w-11 items-center justify-center text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          onClick={() => void window.pkm.toggleMaximize()}
          title={t('titlebar.maximize')}
          aria-label={t('titlebar.maximize')}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          className="flex h-9 w-11 items-center justify-center text-app-muted transition-colors hover:bg-red-500 hover:text-white"
          onClick={() => void window.pkm.close()}
          title={t('titlebar.close')}
          aria-label={t('titlebar.close')}
        >
          <X size={15} />
        </button>
      </div>
      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </div>
  );
}
