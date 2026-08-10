import { FilePlus2, FolderOpen, FolderSearch } from 'lucide-react';
import React, { useState } from 'react';
import { useT, useTError } from '../i18n';
import { useApp } from '../store';
import { Button } from './ui';
import { FolderTreePicker } from './Sidebar';

export function EmptyState() {
  const t = useT();
  const terr = useTError();
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const libraries = useApp((s) => s.libraries);
  const folders = useApp((s) => s.folders);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{
    title: string;
    onPick: (folderId: number) => void;
  } | null>(null);

  const doImport = async (paths: string[], folderId: number | null) => {
    if (!paths.length) return;
    setBusy(true);
    try {
      const res = await window.pkm.importPdfs(paths, folderId);
      await refresh();
      // 导入成功后自动打开最新导入的 PDF，让用户立刻看到效果
      const first = useApp.getState().pdfs[0];
      if (res.imported > 0 && first) {
        useApp.getState().openPdf(first.id);
      }
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
    } finally {
      setBusy(false);
    }
  };

  const importFiles = async () => {
    const paths = await window.pkm.openPdfDialog();
    if (!paths.length) return;
    setPicker({
      title: t('sidebar.pickImportTitle'),
      onPick: (folderId) => {
        void doImport(paths, folderId);
      },
    });
  };

  const importFolder = async () => {
    const paths = await window.pkm.openFolderDialog();
    if (!paths.length) return;
    setPicker({
      title: t('sidebar.pickImportTitle'),
      onPick: (folderId) => {
        void doImport(paths, folderId);
      },
    });
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
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void importFiles()}
          >
            <FilePlus2 size={13} /> {t('empty.chooseFiles')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void importFolder()}
          >
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
      {picker && (
        <FolderTreePicker
          open
          title={picker.title}
          libraries={libraries}
          folders={folders}
          onPick={(folderId) => {
            const pick = picker.onPick;
            setPicker(null);
            pick(folderId);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </main>
  );
}
