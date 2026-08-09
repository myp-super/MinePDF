import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileText,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Import,
  Inbox as InboxIcon,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCcw,
  Settings,
  Trash2,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useT, useTError } from '../i18n';
import type { Folder as FolderType, PdfRecord } from '../shared/types';
import { useApp } from '../store';
import { Button, ConfirmDialog, ContextMenu, type ContextMenuItem, IconButton, Modal } from './ui';

const FOLDER_MIME = 'application/x-pkm-folder';
const PDF_MIME = 'application/x-pkm-pdf';

interface ConfirmState {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  action: () => void;
}

function noDrag(e: React.DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function pathsFromDrag(e: React.DragEvent): string[] {
  const paths: string[] = [];
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    try {
      const p = window.pkm.getPathForFile(f);
      if (p) paths.push(p);
    } catch {
      /* ignore */
    }
  }
  return paths;
}

export function Sidebar() {
  const t = useT();
  const terr = useTError();
  const folders = useApp((s) => s.folders);
  const pdfs = useApp((s) => s.pdfs);
  const tags = useApp((s) => s.tags);
  const settings = useApp((s) => s.settings);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const setView = useApp((s) => s.setView);
  const tagFilterId = useApp((s) => s.tagFilterId);
  const setTagFilter = useApp((s) => s.setTagFilter);
  const selectedFolderId = useApp((s) => s.selectedFolderId);
  const setSelectedFolder = useApp((s) => s.setSelectedFolder);
  const openPdf = useApp((s) => s.openPdf);
  const openPdfInNewTab = useApp((s) => s.openPdfInNewTab);
  const openInSplit = useApp((s) => s.openInSplit);
  const activePdfId = useApp((s) => s.activePdfId);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useApp((s) => s.toggleSidebarCollapsed);
  const selectedPdfIds = useApp((s) => s.selectedPdfIds);
  const setSelectedPdfIds = useApp((s) => s.setSelectedPdfIds);
  const clearSelectedPdfs = useApp((s) => s.clearSelectedPdfs);
  const inboxPdfs = useApp((s) => s.inboxPdfs);
  const setInboxPdfs = useApp((s) => s.setInboxPdfs);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [rootExpanded, setRootExpanded] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [importMenu, setImportMenu] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(true);
  const [inboxMoveId, setInboxMoveId] = useState<number | null>(null);
  const [inboxHeight, setInboxHeight] = useState<number>(
    () => Number(localStorage.getItem('pkm.inboxHeight')) || 160,
  );
  const [appVersion, setAppVersion] = useState('1.0.0');

  useEffect(() => {
    void window.pkm
      .getAppInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => undefined);
  }, []);

  const topFolders = useMemo(
    () => folders.filter((f) => f.parentId === null).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    [folders],
  );
  const rootPdfs = useMemo(() => pdfs.filter((p) => p.folderId === null), [pdfs]);

  const q = query.trim().toLowerCase();
  const searchPdfs = q
    ? pdfs.filter((p) => `${p.title} ${p.filename}`.toLowerCase().includes(q))
    : null;
  const tagPdfs =
    tagFilterId != null ? pdfs.filter((p) => p.tags.some((tg) => tg.id === tagFilterId)) : null;

  const toggleExpanded = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const doImport = async (paths: string[], folderId: number | null) => {
    if (!paths.length) return;
    try {
      const res = await window.pkm.importPdfs(paths, folderId);
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

  const importFiles = async () => {
    setImportMenu(false);
    await doImport(await window.pkm.openPdfDialog(), selectedFolderId);
  };
  const importFolder = async () => {
    setImportMenu(false);
    await doImport(await window.pkm.openFolderDialog(), selectedFolderId);
  };

  const createFolder = async (parentId: number | null) => {
    try {
      await window.pkm.createFolder(t('sidebar.newFolderName'), parentId);
      if (parentId != null) toggleExpanded(parentId);
      else setRootExpanded(true);
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  // ---------- 批量操作（Ctrl 多选） ----------
  const batchDelete = () => {
    const ids = selectedPdfIds;
    if (!ids.length) return;
    setConfirm({
      title: t('sidebar.batchDeleteTitle', { n: ids.length }),
      message: t('sidebar.batchDeleteMsg', { n: ids.length }),
      confirmLabel: t('common.delete'),
      danger: true,
      action: async () => {
        try {
          for (const id of ids) await window.pkm.deletePdf(id);
          await refresh();
          clearSelectedPdfs();
          toast('success', t('sidebar.batchDeleted', { n: ids.length }));
        } catch (err) {
          toast('error', terr(err instanceof Error ? err.message : String(err)));
        }
      },
    });
  };

  const batchMoveTo = async (folderId: number | null) => {
    setMoveOpen(false);
    const ids = selectedPdfIds;
    if (!ids.length) return;
    try {
      for (const id of ids) await window.pkm.movePdf(id, folderId);
      await refresh();
      clearSelectedPdfs();
      toast('success', t('sidebar.batchMoved'));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  // ---------- 临时阅读区 ----------
  const removeInboxPdf = async (id: number) => {
    try {
      await window.pkm.inboxRemove(id);
      setInboxPdfs(inboxPdfs.filter((p) => p.id !== id));
      toast('success', t('inbox.removed'));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const clearInbox = () => {
    setConfirm({
      title: t('inbox.clear'),
      message: t('inbox.clearConfirm', { n: inboxPdfs.length }),
      confirmLabel: t('common.delete'),
      danger: true,
      action: async () => {
        try {
          await window.pkm.inboxClear();
          setInboxPdfs([]);
          toast('success', t('inbox.cleared'));
        } catch (err) {
          toast('error', terr(err instanceof Error ? err.message : String(err)));
        }
      },
    });
  };

  const moveInboxToLibrary = async (id: number, folderId: number | null) => {
    setInboxMoveId(null);
    try {
      await window.pkm.inboxToLibrary(id, folderId);
      await refresh();
      toast('success', t('inbox.moved'));
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const openInboxMenu = (pdf: PdfRecord, x: number, y: number) => {
    setMenu({
      x,
      y,
      items: [
        {
          label: t('inbox.toLibrary'),
          icon: <Library size={12} />,
          onClick: () => setInboxMoveId(pdf.id),
        },
        {
          label: t('sidebar.openInReader'),
          icon: <FolderSearch size={12} />,
          onClick: () => {
            void window.pkm
              .openPdfExternal(pdf.id)
              .catch((err: unknown) => toast('error', terr(err instanceof Error ? err.message : String(err))));
          },
        },
        {
          label: t('inbox.remove'),
          danger: true,
          icon: <Trash2 size={12} />,
          onClick: () => void removeInboxPdf(pdf.id),
        },
      ],
    });
  };

  const requestRemovePdf = (pdf: PdfRecord) => {
    const managed =
      settings.libraryPdfDir &&
      pdf.filepath.toLowerCase().startsWith(settings.libraryPdfDir.toLowerCase());
    setConfirm({
      title: t('sidebar.removeFromLibrary'),
      message: managed ? (
        <>
          {t('sidebar.removeManaged', { name: pdf.title })}
          <div className="mt-1 truncate text-[11px] text-app-muted">{pdf.filepath}</div>
        </>
      ) : (
        <>
          {t('sidebar.removeExternal', { name: pdf.title })}
          <div className="mt-1 truncate text-[11px] text-app-muted">{pdf.filepath}</div>
        </>
      ),
      confirmLabel: t('common.remove'),
      danger: true,
      action: async () => {
        try {
          await window.pkm.deletePdf(pdf.id);
          await refresh();
          toast('success', t('sidebar.removed', { name: pdf.title }));
        } catch (err) {
          toast('error', terr(err instanceof Error ? err.message : String(err)));
        }
      },
    });
  };

  /** 右键菜单：多选时显示批量操作，否则单文件菜单 */
  const openPdfMenu = (pdf: PdfRecord, x: number, y: number) => {
    const multi = selectedPdfIds.includes(pdf.id) && selectedPdfIds.length > 1;
    if (multi) {
      setMenu({
        x,
        y,
        items: [
          {
            label: t('sidebar.moveTo'),
            icon: <Folder size={12} />,
            onClick: () => setMoveOpen(true),
          },
          {
            label: t('sidebar.moveToRoot'),
            icon: <Folder size={12} />,
            onClick: () => void batchMoveTo(null),
          },
          {
            label: t('sidebar.batchDelete'),
            danger: true,
            icon: <Trash2 size={12} />,
            onClick: batchDelete,
          },
        ],
      });
      return;
    }
    // 右键即单选该文件，便于“移动到…”针对它操作
    setSelectedPdfIds([pdf.id]);
    setMenu({
      x,
      y,
      items: [
        {
          label: t('sidebar.moveTo'),
          icon: <Folder size={12} />,
          onClick: () => setMoveOpen(true),
        },
        ...pdfMenuItems(
          pdf,
          refresh,
          toast,
          openPdf,
          openPdfInNewTab,
          openInSplit,
          () => requestRemovePdf(pdf),
          t,
          terr,
        ),
      ],
    });
  };

  const handleRootDrop = async (e: React.DragEvent) => {
    noDrag(e);
    if (dragHasFiles(e)) {
      await doImport(pathsFromDrag(e), null);
      return;
    }
    const f = e.dataTransfer.getData(FOLDER_MIME);
    const p = e.dataTransfer.getData(PDF_MIME);
    try {
      if (f) {
        await window.pkm.moveFolder(Number(f), null);
        await refresh();
      } else if (p) {
        await window.pkm.movePdf(Number(p), null);
        await refresh();
      }
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const openTaggedPdf = (p: PdfRecord) => {
    openPdf(p.id);
    setTagFilter(null);
  };

  const rootMenuItems: ContextMenuItem[] = [
    {
      label: t('sidebar.openLibraryFolder'),
      icon: <Library size={12} />,
      onClick: () => void window.pkm.openLibraryFolder(),
    },
    {
      label: t('sidebar.newRootFolder'),
      icon: <FolderPlus size={12} />,
      onClick: () => void createFolder(null),
    },
  ];

  if (sidebarCollapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center border-r border-app-border bg-app-panel py-2">
        <IconButton title={t('sidebar.expand')} onClick={toggleSidebarCollapsed}>
          <PanelLeftOpen size={14} />
        </IconButton>
        <div className="flex-1" />
        <IconButton title={t('sidebar.settings')} onClick={() => setView('settings')}>
          <Settings size={14} />
        </IconButton>
      </aside>
    );
  }

  return (
    <aside
      className="flex shrink-0 flex-col border-r border-app-border bg-app-panel"
      style={{ width: sidebarWidth }}
      data-panel="sidebar"
    >
      <div className="flex items-center justify-between gap-1 px-3 pt-3 pb-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
          <BookMarked size={14} className="shrink-0 text-app-accent" />
          <span className="cq-lib-title truncate whitespace-nowrap">
            {t('sidebar.library')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton title={t('sidebar.collapse')} onClick={toggleSidebarCollapsed}>
            <PanelLeftClose size={14} />
          </IconButton>
          <div className="relative">
            <Button
              size="sm"
              variant="outline"
              title={t('sidebar.import')}
              aria-label={t('sidebar.import')}
              onClick={() => setImportMenu((v) => !v)}
            >
              <Import size={12} />
            </Button>
            {importMenu && (
              <div
                className="animate-pop absolute right-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-lg border border-app-border bg-app-panel shadow-2xl"
                onMouseLeave={() => setImportMenu(false)}
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-app-panel2"
                  onClick={() => void importFiles()}
                >
                  <FileText size={13} /> {t('sidebar.importFiles')}
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-app-panel2"
                  onClick={() => void importFolder()}
                >
                  <FolderSearch size={13} /> {t('sidebar.importFolder')}
                </button>
                <div className="border-t border-app-border px-3 py-1.5 text-[10.5px] leading-relaxed text-app-muted">
                  {t('sidebar.importHint')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2">
          <input
            className="h-7 w-full rounded-md border border-app-border bg-app-panel2 px-2.5 text-xs outline-none placeholder:text-app-muted focus:border-app-accent/70"
            placeholder={t('sidebar.filter')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <IconButton title={t('sidebar.newRootFolder')} onClick={() => void createFolder(null)}>
            <FolderPlus size={14} />
          </IconButton>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onClick={(e) => {
          // 点击树区空白处取消多选
          if (!(e.target as HTMLElement).closest('[role="treeitem"]')) clearSelectedPdfs();
        }}
      >
        {searchPdfs ? (
          <div className="mt-1">
            <div className="px-1.5 py-1 text-[11px] font-medium text-app-muted">
              {t('sidebar.searchResults', { n: searchPdfs.length })}
            </div>
            {searchPdfs.length === 0 && (
              <div className="px-1.5 py-3 text-center text-[11px] text-app-muted">{t('sidebar.noMatch')}</div>
            )}
            {searchPdfs.map((p) => (
              <PdfRow
                key={p.id}
                pdf={p}
                depth={0}
                onClick={() => openPdf(p.id)}
                onMenu={(x, y) => openPdfMenu(p, x, y)}
              />
            ))}
          </div>
        ) : (
          <div className="mt-0.5">
            <div
              role="treeitem"
              tabIndex={0}
              className="group flex cursor-pointer items-center gap-1 rounded-md px-1 py-1.5 text-xs font-semibold hover:bg-app-panel2 focus-visible:ring-2 focus-visible:ring-app-accent/60"
              onClick={() => setSelectedFolder(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSelectedFolder(null);
              }}
              onDragOver={noDrag}
              onDrop={(e) => void handleRootDrop(e)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: rootMenuItems });
              }}
              title={t('sidebar.dragHint')}
            >
              <button
                className="flex h-4 w-4 items-center justify-center text-app-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  setRootExpanded((v) => !v);
                }}
                aria-label={t('sidebar.expandCollapse')}
              >
                {rootExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <BookMarked size={14} className="text-app-accent" />
              <span className="cq-mylib-label whitespace-nowrap">
                {t('sidebar.myLibrary')}
              </span>
              <span className="ml-auto pr-1 text-[10px] font-normal text-app-muted">
                {t('sidebar.filesCount', { n: pdfs.length })}
              </span>
            </div>
            {rootExpanded && (
              <div>
                {rootPdfs.map((p) => (
                  <PdfRow
                    key={p.id}
                    pdf={p}
                    depth={0}
                    onClick={() => openPdf(p.id)}
                    onMenu={(x, y) => openPdfMenu(p, x, y)}
                  />
                ))}
                {topFolders.map((f) => (
                  <FolderNode
                    key={f.id}
                    folder={f}
                    depth={0}
                    expanded={expanded}
                    toggleExpanded={toggleExpanded}
                    refresh={refresh}
                    toast={toast}
                    openPdf={openPdf}
                    onMenu={(items, x, y) => setMenu({ x, y, items })}
                    onPdfMenu={openPdfMenu}
                    setConfirm={setConfirm}
                    createChild={() => void createFolder(f.id)}
                    onRemovePdf={requestRemovePdf}
                    onDropFiles={(paths) => doImport(paths, f.id)}
                  />
                ))}
                {rootPdfs.length === 0 && topFolders.length === 0 && (
                  <div className="px-2 py-3 text-center text-[11px] text-app-muted">{t('sidebar.emptyHint')}</div>
                )}
              </div>
            )}
          </div>
        )}

        {tagFilterId != null && (
          <div className="mt-3 border-t border-app-border pt-2">
            <div className="flex items-center justify-between px-1.5 pb-1">
              <span className="text-[11px] font-medium text-app-muted">
                #{tags.find((tg) => tg.id === tagFilterId)?.name ?? t('sidebar.tags')}
              </span>
              <button
                className="text-[10.5px] text-app-muted hover:text-app-text"
                onClick={() => setTagFilter(null)}
              >
                {t('sidebar.filterTag')}
              </button>
            </div>
            {(tagPdfs ?? []).map((p) => (
              <PdfRow
                key={p.id}
                pdf={p}
                depth={0}
                onClick={() => openTaggedPdf(p)}
                onMenu={(x, y) => openPdfMenu(p, x, y)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 临时区分隔条：可拖拽调整列表高度 */}
      <div
        className="h-1 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-app-accent/50 active:bg-app-accent"
        title={t('inbox.resize')}
        onMouseDown={(e) => {
          e.preventDefault();
          const startY = e.clientY;
          const startH = inboxHeight;
          const move = (ev: MouseEvent) => {
            const next = Math.min(420, Math.max(90, startH - (ev.clientY - startY)));
            const el = document.querySelector('[data-inbox-panel]') as HTMLElement | null;
            if (el) el.style.setProperty('height', `${next}px`);
          };
          const up = (ev: MouseEvent) => {
            const next = Math.min(420, Math.max(90, startH - (ev.clientY - startY)));
            localStorage.setItem('pkm.inboxHeight', String(next));
            setInboxHeight(next);
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'row-resize';
        }}
      />

      {/* 临时阅读区：双击 / “打开方式”打开的 PDF，不进入知识库 */}
      <div className="border-t border-app-border">
        <div className="flex items-center justify-between px-2 py-1">
          <button
            className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-app-muted transition-colors hover:text-app-text"
            onClick={() => setInboxOpen((v) => !v)}
          >
            <InboxIcon size={12} className="shrink-0 text-app-accent2/90" />
            <span className="truncate">{t('inbox.title')}</span>
            <span className="text-[10px] text-app-muted/70">{inboxPdfs.length}</span>
          </button>
          <div className="flex shrink-0 items-center">
            {inboxPdfs.length > 0 && (
              <IconButton title={t('inbox.clear')} onClick={clearInbox}>
                <Trash2 size={12} />
              </IconButton>
            )}
            <IconButton
              title={inboxOpen ? t('inbox.collapse') : t('inbox.expand')}
              onClick={() => setInboxOpen((v) => !v)}
            >
              {inboxOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </IconButton>
          </div>
        </div>
        {inboxOpen && (
          <div
            data-inbox-panel
            className="overflow-y-auto px-2 pb-2"
            style={{ height: inboxHeight }}
          >
            {inboxPdfs.length === 0 && (
              <div className="px-2 py-2 text-[10.5px] leading-relaxed text-app-muted/80">
                {t('inbox.empty')}
              </div>
            )}
            {inboxPdfs.map((p) => (
              <div
                key={p.id}
                role="treeitem"
                tabIndex={0}
                className={`flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] text-xs transition-colors hover:bg-app-panel2 ${
                  activePdfId === p.id
                    ? 'bg-app-accent/12 text-app-text'
                    : 'text-app-text/85'
                }`}
                style={{ paddingLeft: 14 }}
                onClick={() => openPdf(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openPdf(p.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openInboxMenu(p, e.clientX, e.clientY);
                }}
                title={p.filepath}
              >
                <FileText size={13} className="shrink-0 text-app-accent2/80" />
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-app-border px-2.5 py-2">
        <button
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[11px] text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          onClick={() => void window.pkm.openLibraryFolder()}
          title={settings.libraryPdfDir}
        >
          <Library size={13} className="shrink-0 text-app-accent2" />
          <span className="min-w-0 flex-1 truncate">{settings.libraryPdfDir || t('sidebar.libraryDir')}</span>
          <span className="shrink-0 text-[10px] text-app-muted/70">{t('sidebar.open')}</span>
        </button>
        <div className="mt-1 flex items-center justify-between px-1.5">
          <span className="text-[10px] text-app-muted/60">v{appVersion}</span>
          <IconButton title={t('sidebar.settings')} onClick={() => setView('settings')}>
            <Settings size={14} />
          </IconButton>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.action}
          onCancel={() => setConfirm(null)}
        />
      )}
      {moveOpen && (
        <Modal open onClose={() => setMoveOpen(false)} title={t('sidebar.moveTitle')} width={360}>
          <div className="max-h-[50vh] space-y-0.5 overflow-y-auto">
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-panel2"
              onClick={() => void batchMoveTo(null)}
            >
              <BookMarked size={13} className="text-app-accent" />
              {t('sidebar.moveToRoot')}
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-panel2"
                style={{ paddingLeft: 8 + f.path.split('/').length * 12 }}
                onClick={() => void batchMoveTo(f.id)}
              >
                <Folder size={13} className="shrink-0 text-app-accent2/90" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {inboxMoveId != null && (
        <Modal open onClose={() => setInboxMoveId(null)} title={t('inbox.toLibrary')} width={360}>
          <div className="max-h-[50vh] space-y-0.5 overflow-y-auto">
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-panel2"
              onClick={() => void moveInboxToLibrary(inboxMoveId, null)}
            >
              <BookMarked size={13} className="text-app-accent" />
              {t('sidebar.moveToRoot')}
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-panel2"
                style={{ paddingLeft: 8 + f.path.split('/').length * 12 }}
                onClick={() => void moveInboxToLibrary(inboxMoveId, f.id)}
              >
                <Folder size={13} className="shrink-0 text-app-accent2/90" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </aside>
  );
}

function FolderNode({
  folder,
  depth,
  expanded,
  toggleExpanded,
  refresh,
  toast,
  openPdf,
  onMenu,
  onPdfMenu,
  setConfirm,
  createChild,
  onRemovePdf,
  onDropFiles,
}: {
  folder: FolderType;
  depth: number;
  expanded: Set<number>;
  toggleExpanded: (id: number) => void;
  refresh: () => Promise<void>;
  toast: (kind: 'info' | 'success' | 'error', text: string) => void;
  openPdf: (id: number) => void;
  onMenu: (items: ContextMenuItem[], x: number, y: number) => void;
  onPdfMenu: (pdf: PdfRecord, x: number, y: number) => void;
  setConfirm: (c: ConfirmState) => void;
  createChild: () => void;
  onRemovePdf: (pdf: PdfRecord) => void;
  onDropFiles: (paths: string[]) => Promise<void>;
}) {
  const t = useT();
  const terr = useTError();
  const folders = useApp((s) => s.folders);
  const pdfs = useApp((s) => s.pdfs);
  const selectedFolderId = useApp((s) => s.selectedFolderId);
  const setSelectedFolder = useApp((s) => s.setSelectedFolder);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const [dragOver, setDragOver] = useState(false);

  const children = folders.filter((f) => f.parentId === folder.id);
  const pdfsIn = pdfs.filter((p) => p.folderId === folder.id);
  const isOpen = expanded.has(folder.id);

  const handleDrop = async (e: React.DragEvent) => {
    noDrag(e);
    setDragOver(false);
    if (dragHasFiles(e)) {
      await onDropFiles(pathsFromDrag(e));
      return;
    }
    const f = e.dataTransfer.getData(FOLDER_MIME);
    const p = e.dataTransfer.getData(PDF_MIME);
    try {
      if (f) {
        await window.pkm.moveFolder(Number(f), folder.id);
        await refresh();
        toggleExpanded(folder.id);
      } else if (p) {
        await window.pkm.movePdf(Number(p), folder.id);
        await refresh();
        toggleExpanded(folder.id);
      }
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const commitRename = async () => {
    setRenaming(false);
    const next = name.trim();
    if (!next || next === folder.name) return;
    try {
      await window.pkm.renameFolder(folder.id, next);
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
      setName(folder.name);
    }
  };

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu(
      [
        { label: t('sidebar.newChildFolder'), icon: <FolderPlus size={12} />, onClick: createChild },
        { label: t('sidebar.rename'), icon: <RefreshCcw size={12} />, onClick: () => setRenaming(true) },
        {
          label: t('sidebar.moveToRoot'),
          icon: <Folder size={12} />,
          onClick: async () => {
            try {
              await window.pkm.moveFolder(folder.id, null);
              await refresh();
            } catch (err) {
              toast('error', terr(err instanceof Error ? err.message : String(err)));
            }
          },
        },
        {
          label: t('sidebar.revealInSystem'),
          icon: <Folder size={12} />,
          onClick: () => {
            void window.pkm.revealFolder(folder.id);
          },
        },
        {
          label: t('sidebar.deleteFolder'),
          danger: true,
          icon: <Trash2 size={12} />,
          onClick: () =>
            setConfirm({
              title: t('sidebar.deleteFolder'),
              message: t('sidebar.deleteFolderMsg', { name: folder.name }),
              confirmLabel: t('common.delete'),
              danger: true,
              action: async () => {
                try {
                  await window.pkm.deleteFolder(folder.id);
                  await refresh();
                  toast('success', t('sidebar.folderDeleted', { name: folder.name }));
                } catch (err) {
                  toast('error', terr(err instanceof Error ? err.message : String(err)));
                }
              },
            }),
        },
      ],
      e.clientX,
      e.clientY,
    );
  };

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        className={`group flex cursor-pointer items-center gap-1 rounded-md py-[3px] text-xs transition-colors ${
          dragOver
            ? 'bg-app-accent/15 outline outline-1 outline-app-accent'
            : 'hover:bg-app-panel2'
        } ${selectedFolderId === folder.id ? 'bg-app-accent/10 text-app-text' : 'text-app-text/90'} focus-visible:ring-2 focus-visible:ring-app-accent/60`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_MIME, String(folder.id));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={noDrag}
        onDragEnter={(e) => {
          noDrag(e);
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void handleDrop(e)}
        onClick={() => setSelectedFolder(folder.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setSelectedFolder(folder.id);
        }}
        onContextMenu={openMenu}
      >
        <button
          className="flex h-4 w-4 items-center justify-center text-app-muted"
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(folder.id);
          }}
          aria-label={t('sidebar.expandCollapseFolder')}
        >
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {isOpen ? (
          <FolderOpen size={13} className="text-app-accent2/90" />
        ) : (
          <Folder size={13} className="text-app-accent2/90" />
        )}
        {renaming ? (
          <input
            autoFocus
            className="h-5 min-w-0 flex-1 rounded border border-app-accent bg-app-panel2 px-1 text-xs outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') {
                setRenaming(false);
                setName(folder.name);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        )}
        {!renaming && (
          <button
            className="mr-1 hidden text-app-muted hover:text-app-text group-hover:block"
            title={t('sidebar.newChildFolder')}
            onClick={(e) => {
              e.stopPropagation();
              createChild();
              toggleExpanded(folder.id);
            }}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {isOpen && (
        <div>
          {children.map((f) => (
            <FolderNode
              key={f.id}
              folder={f}
              depth={depth + 1}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              refresh={refresh}
              toast={toast}
              openPdf={openPdf}
              onMenu={onMenu}
              onPdfMenu={onPdfMenu}
              setConfirm={setConfirm}
              createChild={() => {
                void (async () => {
                  try {
                    await window.pkm.createFolder(t('sidebar.newFolderName'), f.id);
                    toggleExpanded(f.id);
                    await refresh();
                  } catch (err) {
                    toast('error', terr(err instanceof Error ? err.message : String(err)));
                  }
                })();
              }}
              onRemovePdf={onRemovePdf}
              onDropFiles={onDropFiles}
            />
          ))}
          {pdfsIn.map((p) => (
            <PdfRow
              key={p.id}
              pdf={p}
              depth={depth + 1}
              onClick={() => openPdf(p.id)}
              onMenu={(x, y) => onPdfMenu(p, x, y)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PdfRow({
  pdf,
  depth,
  onClick,
  onMenu,
}: {
  pdf: PdfRecord;
  depth: number;
  onClick: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();
  const activePdfId = useApp((s) => s.activePdfId);
  const selectedPdfIds = useApp((s) => s.selectedPdfIds);
  const setSelectedPdfIds = useApp((s) => s.setSelectedPdfIds);
  const toggleSelectedPdf = useApp((s) => s.toggleSelectedPdf);
  const selected = selectedPdfIds.includes(pdf.id);
  return (
    <div
      role="treeitem"
      tabIndex={0}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] text-xs transition-colors hover:bg-app-panel2 ${
        selected
          ? 'bg-app-accent/20 text-app-text ring-1 ring-inset ring-app-accent/50'
          : activePdfId === pdf.id
            ? 'bg-app-accent/12 text-app-text'
            : 'text-app-text/85'
      } focus-visible:ring-2 focus-visible:ring-app-accent/60`}
      style={{ paddingLeft: 14 + depth * 14 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PDF_MIME, String(pdf.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          toggleSelectedPdf(pdf.id);
          return;
        }
        setSelectedPdfIds([pdf.id]);
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={`${pdf.filepath}\n${t('sidebar.selectHint')}`}
    >
      <FileText size={13} className={pdf.status === 'missing' ? 'text-app-danger' : 'text-app-muted'} />
      <span className={`min-w-0 flex-1 truncate ${pdf.status === 'missing' ? 'text-app-danger/80' : ''}`}>
        {pdf.title}
      </span>
      {pdf.tags.length > 0 && (
        <span className="shrink-0 pr-1 text-[9.5px] text-app-muted">#{pdf.tags.length}</span>
      )}
    </div>
  );
}

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

function pdfMenuItems(
  pdf: PdfRecord,
  refresh: () => Promise<void>,
  toast: (kind: 'info' | 'success' | 'error', text: string) => void,
  openPdf: (id: number) => void,
  openPdfInNewTab: (id: number) => void,
  openInSplit: (id: number) => void,
  onRemove: () => void,
  t: TFunc,
  terr: (msg: string) => string,
): ContextMenuItem[] {
  return [
    { label: t('sidebar.openPdf'), icon: <FileText size={12} />, onClick: () => openPdf(pdf.id) },
    {
      label: t('sidebar.openNewTab'),
      icon: <FilePlus2 size={12} />,
      onClick: () => openPdfInNewTab(pdf.id),
    },
    {
      label: t('sidebar.openInSplit'),
      icon: <Columns2 size={12} />,
      onClick: () => openInSplit(pdf.id),
    },
    {
      label: t('sidebar.revealInSystem'),
      icon: <Folder size={12} />,
      onClick: () => {
        void window.pkm.revealPdf(pdf.id).catch(() => undefined);
      },
    },
    {
      label: t('sidebar.openInReader'),
      icon: <FolderSearch size={12} />,
      onClick: () => {
        void window.pkm
          .openPdfExternal(pdf.id)
          .catch((err: unknown) => toast('error', terr(err instanceof Error ? err.message : String(err))));
      },
    },
    {
      label: t('sidebar.moveToRoot'),
      icon: <Folder size={12} />,
      onClick: async () => {
        try {
          await window.pkm.movePdf(pdf.id, null);
          await refresh();
        } catch (err) {
          toast('error', terr(err instanceof Error ? err.message : String(err)));
        }
      },
    },
    ...(pdf.status === 'missing'
      ? [
          {
            label: t('sidebar.relocate'),
            icon: <FolderSearch size={12} />,
            onClick: async () => {
              try {
                await window.pkm.relocatePdf(pdf.id);
                await refresh();
              } catch (err) {
                toast('error', terr(err instanceof Error ? err.message : String(err)));
              }
            },
          },
        ]
      : []),
    {
      label: t('sidebar.removeFromLibrary'),
      danger: true,
      icon: <Trash2 size={12} />,
      onClick: onRemove,
    },
  ];
}
