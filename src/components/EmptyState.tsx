import { FilePlus2, FolderOpen, FolderSearch } from 'lucide-react';
import React from 'react';
import { useT, useTError } from '../i18n';
import { useApp } from '../store';
import { Button } from './ui';

export function EmptyState() {
  const t = useT();
  const terr = useTError();
  const selectedFolderId = useApp((s) => s.selectedFolderId);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);

  const doImport = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const res = await window.pkm.importPdfs(paths, selectedFolderId);
      await refresh();
      toast(
        'success',
        t('common.imported', {
          n: res.imported,
          skip: res.skipped ? t('common.imported.skip', { n: res.skipped }) : '',
        }),
      );
      for (const e of res.errors) toast('error', e);
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <main className="flex min-w-0 flex-1 items-center justify-center bg-app-base">
      <div className="flex max-w-lg flex-col items-center px-6 text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-app-border bg-app-panel shadow-sm">
          <FilePlus2 size={26} className="text-app-accent" />
        </div>
        <h2 className="text-[15px] font-semibold">{t('empty.title')}</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-app-muted">{t('empty.desc')}</p>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" onClick={async () => doImport(await window.pkm.openPdfDialog())}>
            <FilePlus2 size={13} /> {t('empty.chooseFiles')}
          </Button>
          <Button variant="outline" onClick={async () => doImport(await window.pkm.openFolderDialog())}>
            <FolderSearch size={13} /> {t('empty.importFolder')}
          </Button>
        </div>

        <div className="mt-6 w-full rounded-lg border border-app-border bg-app-panel px-3 py-2.5 text-left">
          <div className="text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
            {t('empty.libraryFolder')}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-app-text/85">
              {settings.libraryPdfDir}
            </span>
            <button
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
              onClick={() => void window.pkm.openLibraryFolder()}
            >
              <FolderOpen size={11} /> {t('empty.open')}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
