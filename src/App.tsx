import React, { Fragment, useEffect, useState } from 'react';
import { AlertTriangle, FolderSearch, Trash2 } from 'lucide-react';
import { useT, useTError } from './i18n';
import type { PdfRecord } from './shared/types';
import { useApp } from './store';
import { EmptyState } from './components/EmptyState';
import { Inspector } from './components/Inspector';
import { SearchModal } from './components/SearchModal';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { Button, Modal, ResizeHandle } from './components/ui';
import { ScreenViewer, SplitDivider } from './components/Viewer/ScreenViewer';

export default function App() {
  const t = useT();
  const terr = useTError();
  const ready = useApp((s) => s.ready);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const toasts = useApp((s) => s.toasts);
  const dismissToast = useApp((s) => s.dismissToast);
  const settings = useApp((s) => s.settings);
  const view = useApp((s) => s.view);
  const activePdf = useApp(
    (s) => s.pdfs.find((p) => p.id === s.activePdfId) ?? s.inboxPdfs.find((p) => p.id === s.activePdfId),
  );
  const screens = useApp((s) => s.screens);
  const activeScreenId = useApp((s) => s.activeScreenId);
  const splitLayout = useApp((s) => s.splitLayout);
  const splitRatio = useApp((s) => s.splitRatio);
  const setSplitRatio = useApp((s) => s.setSplitRatio);
  const activeScreen = screens.find((sc) => sc.id === activeScreenId) ?? screens[0] ?? null;
  const selectedFolderId = useApp((s) => s.selectedFolderId);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const setSidebarWidth = useApp((s) => s.setSidebarWidth);
  const inspectorWidth = useApp((s) => s.inspectorWidth);
  const setInspectorWidth = useApp((s) => s.setInspectorWidth);
  const inspectorCollapsed = useApp((s) => s.inspectorCollapsed);
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed);

  const [dragging, setDragging] = useState(false);
  const [missingPdf, setMissingPdf] = useState<PdfRecord | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [snap, inbox] = await Promise.all([window.pkm.getSnapshot(), window.pkm.inboxList()]);
        useApp.setState({
          folders: snap.folders,
          pdfs: snap.pdfs,
          inboxPdfs: inbox,
          tags: snap.tags,
          settings: snap.settings,
          ready: true,
        });
      } catch (err) {
        toast('error', t('app.initFailed', { msg: err instanceof Error ? err.message : String(err) }));
        useApp.getState().setReady(true);
      }
    })();
  }, [t, toast]);

  // 启动后恢复上次阅读会话（关闭前正在读的 PDF 与页码）
  useEffect(() => {
    if (ready) useApp.getState().restoreLastSession();
  }, [ready]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.lang = settings.language === 'en-US' ? 'en' : 'zh-CN';
  }, [settings.theme, settings.language]);

  useEffect(() => {
    if (window.location.hash.includes('capture')) {
      const w = window as unknown as {
  __pkmOpenPdf?: (id: number) => void;
  __pkmRestoreSession?: () => void;
  __pkmStore?: () => unknown;
  __pkmAct?: (name: string, ...args: unknown[]) => void;
        __pkmRefresh?: () => void;
      };
  w.__pkmOpenPdf = (id: number) => useApp.getState().openPdf(id);
  w.__pkmRestoreSession = () => useApp.getState().restoreLastSession();
  w.__pkmStore = () => {
    const s = useApp.getState();
    return {
      screens: s.screens.map((sc) => ({
        id: sc.id,
        tabs: sc.tabs.map((t) => ({ id: t.id, pdfId: t.pdfId, title: t.title, kind: t.kind })),
        activeTabId: sc.activeTabId,
      })),
      activeScreenId: s.activeScreenId,
      activePdfId: s.activePdfId,
      jumpPage: s.jumpPage,
      currentPage: s.currentPage,
      splitLayout: s.splitLayout,
      splitRatio: s.splitRatio,
    };
  };
  w.__pkmAct = (name, ...args) => {
    const s = useApp.getState();
    const actions: Record<string, (...a: never[]) => void> = {
      openPdfInNewTab: s.openPdfInNewTab,
      openInSplit: s.openInSplit,
      activateScreen: s.activateScreen,
      activateTab: s.activateTab,
      closeTab: s.closeTab,
      closeAllTabs: s.closeAllTabs,
      closeOtherTabs: s.closeOtherTabs,
      clearScreens: s.clearScreens,
      splitScreen: s.splitScreen,
      unsplitScreen: s.unsplitScreen,
      setSplitRatio: s.setSplitRatio,
    };
    (actions[name] as (...a: unknown[]) => void)?.(...args);
  };
      w.__pkmRefresh = () => {
        void refresh();
      };
    }
  }, [refresh]);

  useEffect(() => {
    return window.pkm.onLibraryChanged(() => void refresh());
  }, [refresh]);

  // 系统用 MinePDF 打开 PDF（双击 / 打开方式）→ 复制进临时区并预览
  useEffect(() => {
    return window.pkm.onExternalPdf((filePath) => {
      void (async () => {
        try {
          const item = await window.pkm.inboxAdd(filePath);
          await refresh();
          useApp.getState().setSelectedFolder(null);
          useApp.getState().openPdf(item.id);
          toast('success', t('inbox.added'));
        } catch (err) {
          toast('error', terr(err instanceof Error ? err.message : String(err)));
        }
      })();
    });
  }, [refresh, t, terr, toast]);

  // Ctrl+B 折叠 / 展开左侧边栏（沉浸阅读）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
        useApp.getState().toggleSidebarCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget == null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (!hasFiles(e) || !e.dataTransfer?.files.length) return;
      const paths: string[] = [];
      for (const f of Array.from(e.dataTransfer.files)) {
        try {
          const p = window.pkm.getPathForFile(f);
          if (p) paths.push(p);
        } catch {
          /* ignore */
        }
      }
      if (!paths.length) return;
      void (async () => {
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
      })();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [refresh, selectedFolderId, t, terr, toast]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-app-base">
        <div className="flex items-center gap-3 text-sm text-app-muted">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
          {t('viewer.loading')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app-base text-app-text">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {!sidebarCollapsed && (
          <ResizeHandle
            width={sidebarWidth}
            min={180}
            max={420}
            dir={1}
            panel="sidebar"
            onCommit={setSidebarWidth}
            title={t('common.resize')}
          />
        )}
        {view === 'settings' ? (
          <SettingsPage />
        ) : activeScreen ? (
          splitLayout !== 'single' && screens.length > 1 ? (
            <div
              className={`animate-pop flex min-h-0 min-w-0 flex-1 ${
                splitLayout === 'split-h' ? 'flex-row' : 'flex-col'
              }`}
            >
              {screens.map((screen, idx) => (
                <Fragment key={screen.id}>
                  {idx > 0 && (
                    <SplitDivider
                      orientation={splitLayout === 'split-h' ? 'v' : 'h'}
                      ratio={splitRatio}
                      onRatio={setSplitRatio}
                    />
                  )}
                  <div
                    className={`relative flex min-h-0 min-w-0 ${
                      screen.id === activeScreenId
                        ? 'ring-2 ring-inset ring-app-accent/70'
                        : 'ring-1 ring-inset ring-app-border/40'
                    }`}
                    style={{
                      flexGrow: idx === 0 ? splitRatio : 1 - splitRatio,
                      flexBasis: 0,
                      overflow: 'hidden',
                    }}
                  >
                    <ScreenViewer
                      screen={screen}
                      active={screen.id === activeScreenId}
                      onMissing={setMissingPdf}
                    />
                  </div>
                </Fragment>
              ))}
            </div>
          ) : (
            <div className="relative flex min-h-0 flex-1">
              <ScreenViewer
                screen={activeScreen}
                active
                onMissing={setMissingPdf}
              />
            </div>
          )
        ) : (
          <EmptyState />
        )}
        {!inspectorCollapsed && (
          <ResizeHandle
            width={inspectorWidth}
            min={220}
            max={520}
            dir={-1}
            panel="inspector"
            onCommit={setInspectorWidth}
            title={t('common.resize')}
          />
        )}
        <Inspector />
      </div>

      <SearchModal />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-app-accent/10 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-app-accent bg-app-panel px-10 py-8 shadow-2xl">
            <FolderSearch size={30} className="text-app-accent" />
            <span className="text-sm font-medium">{t('app.dragDropHint')}</span>
          </div>
        </div>
      )}

      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 top-12 z-[70] flex w-80 flex-col gap-2"
      >
        {toasts.map((toastItem) => (
          <div
            key={toastItem.id}
            className={`animate-toast pointer-events-auto rounded-lg border px-3.5 py-2.5 text-[11.5px] shadow-xl backdrop-blur ${
              toastItem.kind === 'error'
                ? 'border-app-danger/50 bg-app-danger/15 text-app-danger'
                : toastItem.kind === 'success'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-app-border bg-app-panel text-app-text'
            }`}
          >
            {toastItem.text}
          </div>
        ))}
      </div>

      <MissingPdfModal
        pdf={missingPdf}
        onClose={() => setMissingPdf(null)}
        onRelocated={async (p) => {
          setMissingPdf(null);
          await refresh();
          useApp.getState().openPdf(p.id);
        }}
        onRemoved={async () => {
          setMissingPdf(null);
          await refresh();
        }}
        toast={toast}
      />
    </div>
  );
}

function MissingPdfModal({
  pdf,
  onClose,
  onRelocated,
  onRemoved,
  toast,
}: {
  pdf: PdfRecord | null;
  onClose: () => void;
  onRelocated: (p: PdfRecord) => Promise<void>;
  onRemoved: () => Promise<void>;
  toast: (kind: 'info' | 'success' | 'error', text: string) => void;
}) {
  const t = useT();
  const terr = useTError();
  if (!pdf) return null;
  return (
    <Modal open onClose={onClose} title={t('app.fileMissing')} width={440}>
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-app-danger" />
        <div className="min-w-0">
          <p className="text-[12.5px]">{t('app.missingMsg', { title: pdf.title })}</p>
          <p className="mt-1.5 break-all rounded-md bg-app-panel2 px-2.5 py-1.5 text-[11px] text-app-muted">
            {pdf.filepath}
          </p>
          <div className="mt-4 flex gap-2">
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  const updated = await window.pkm.relocatePdf(pdf.id);
                  await onRelocated(updated);
                  toast('success', t('app.relocated'));
                } catch (err) {
                  toast('error', terr(err instanceof Error ? err.message : String(err)));
                }
              }}
            >
              <FolderSearch size={12} /> {t('app.relocate')}
            </Button>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              className="ml-auto"
              onClick={async () => {
                try {
                  await window.pkm.deletePdf(pdf.id);
                  await onRemoved();
                  toast('success', t('sidebar.removed', { name: pdf.title }));
                } catch (err) {
                  toast('error', terr(err instanceof Error ? err.message : String(err)));
                }
              }}
            >
              <Trash2 size={12} /> {t('app.removeFromLibrary')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
