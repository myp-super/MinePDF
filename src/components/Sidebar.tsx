import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Hash,
  Import,
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
import { Button, ConfirmDialog, ContextMenu, type ContextMenuItem, IconButton } from './ui';

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
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useApp((s) => s.toggleSidebarCollapsed);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [rootExpanded, setRootExpanded] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [importMenu, setImportMenu] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
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

  const pdfMenu = (pdf: PdfRecord) => pdfMenuItems(pdf, refresh, toast, openPdf, () => requestRemovePdf(pdf), t, terr);

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
          <span className="truncate">{t('sidebar.library')}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton title={t('sidebar.collapse')} onClick={toggleSidebarCollapsed}>
            <PanelLeftClose size={14} />
          </IconButton>
          <div className="relative">
            <Button size="sm" variant="outline" onClick={() => setImportMenu((v) => !v)}>
              <Import size={12} />
              {t('sidebar.import')}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
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
                onMenu={(x, y) => setMenu({ x, y, items: pdfMenu(p) })}
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
              {t('sidebar.myLibrary')}
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
                    onMenu={(x, y) => setMenu({ x, y, items: pdfMenu(p) })}
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
                onMenu={(x, y) => setMenu({ x, y, items: pdfMenu(p) })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="max-h-44 overflow-y-auto border-t border-app-border px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-app-muted">{t('sidebar.tags')}</span>
          <span className="text-[10px] text-app-muted">{tags.length}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {tags.length === 0 && <span className="text-[11px] text-app-muted/70">{t('sidebar.tagsEmpty')}</span>}
          {tags.map((tg) => {
            const count = pdfs.filter((p) => p.tags.some((x) => x.id === tg.id)).length;
            const active = tagFilterId === tg.id;
            return (
              <button
                key={tg.id}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] transition-colors ${
                  active
                    ? 'border-app-accent bg-app-accent/15 text-app-accent'
                    : 'border-app-border text-app-muted hover:border-app-accent/40 hover:text-app-text'
                }`}
                onClick={() => setTagFilter(active ? null : tg.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      {
                        label: t('sidebar.deleteTag'),
                        danger: true,
                        icon: <Trash2 size={12} />,
                        onClick: async () => {
                          try {
                            await window.pkm.deleteTag(tg.id);
                            await refresh();
                          } catch (err) {
                            toast('error', terr(err instanceof Error ? err.message : String(err)));
                          }
                        },
                      },
                    ],
                  });
                }}
              >
                <Hash size={10} />
                {tg.name}
                <span className="opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
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
              onMenu={(x, y) =>
                onMenu(pdfMenuItems(p, refresh, toast, openPdf, () => onRemovePdf(p), t, terr), x, y)
              }
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
  const activePdfId = useApp((s) => s.activePdfId);
  return (
    <div
      role="treeitem"
      tabIndex={0}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] text-xs transition-colors hover:bg-app-panel2 ${
        activePdfId === pdf.id ? 'bg-app-accent/12 text-app-text' : 'text-app-text/85'
      } focus-visible:ring-2 focus-visible:ring-app-accent/60`}
      style={{ paddingLeft: 14 + depth * 14 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PDF_MIME, String(pdf.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={pdf.filepath}
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
  onRemove: () => void,
  t: TFunc,
  terr: (msg: string) => string,
): ContextMenuItem[] {
  return [
    { label: t('sidebar.openPdf'), icon: <FileText size={12} />, onClick: () => openPdf(pdf.id) },
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
