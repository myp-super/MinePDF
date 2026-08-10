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
  LibraryBig,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCcw,
  Settings,
  Trash2,
} from 'lucide-react';
import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useT, useTError } from '../i18n';
import type { Folder as FolderType, LibraryRecord, PdfRecord } from '../shared/types';
import { useApp } from '../store';
import { Button, ConfirmDialog, ContextMenu, type ContextMenuItem, IconButton, Modal } from './ui';

const FOLDER_MIME = 'application/x-pkm-folder';
const PDF_MIME = 'application/x-pkm-pdf';
const LIBRARY_MIME = 'application/x-pkm-library';

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

/** 同级拖拽排序：先归入目标父级（如需），再排到 beforeId 之前 */
async function reorderFolderInto(
  folders: FolderType[],
  draggedId: number,
  beforeId: number | null,
  targetParentId: number,
): Promise<void> {
  const dragged = folders.find((x) => x.id === draggedId);
  if (!dragged) return;
  if (dragged.parentId !== targetParentId) {
    await window.pkm.moveFolder(draggedId, targetParentId);
  }
  await window.pkm.reorderFolder(draggedId, beforeId);
}

/** 行与行之间的插入指示条：拖到此处表示“排在该行之前” */
function InsertZone({
  onDrop,
}: {
  onDrop: (draggedId: number, kind: 'folder' | 'library') => void;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return (
    <div
      className={over ? 'mx-0.5 h-1 rounded-full bg-app-accent/80' : 'h-1'}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        depth.current += 1;
        setOver(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        const f = e.dataTransfer.getData(FOLDER_MIME);
        const l = e.dataTransfer.getData(LIBRARY_MIME);
        if (f) onDrop(Number(f), 'folder');
        else if (l) onDrop(Number(l), 'library');
      }}
    />
  );
}

export function Sidebar() {
  const t = useT();
  const terr = useTError();
  const folders = useApp((s) => s.folders);
  const libraries = useApp((s) => s.libraries);
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
  const setSidebarCollapsed = useApp((s) => s.setSidebarCollapsed);
  const selectedPdfIds = useApp((s) => s.selectedPdfIds);
  const setSelectedPdfIds = useApp((s) => s.setSelectedPdfIds);
  const clearSelectedPdfs = useApp((s) => s.clearSelectedPdfs);
  const inboxPdfs = useApp((s) => s.inboxPdfs);
  const setInboxPdfs = useApp((s) => s.setInboxPdfs);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [importMenu, setImportMenu] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [renamingNode, setRenamingNode] = useState<{ kind: 'library' | 'folder'; id: number } | null>(null);
  const [picker, setPicker] = useState<{
    title: string;
    onPick: (folderId: number) => void;
  } | null>(null);
  const [inboxOpen, setInboxOpen] = useState(true);
  const [inboxHeight, setInboxHeight] = useState<number>(
    () => Number(localStorage.getItem('pkm.inboxHeight')) || 160,
  );
  const [appVersion, setAppVersion] = useState('1.0.0');
  /** 知识库自动折叠：阅读 PDF 时悬停左边缘临时展开，移出后自动收起 */
  const autoHide = settings.autoCollapseSidebar && activePdfId != null;
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    };
  }, []);

  const scheduleAutoHide = () => {
    if (!autoHide) return;
    if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    autoHideTimer.current = setTimeout(() => {
      autoHideTimer.current = null;
      setSidebarCollapsed(true);
    }, 250);
  };
  const cancelAutoHide = () => {
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
  };

  useEffect(() => {
    void window.pkm
      .getAppInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => undefined);
  }, []);

  const defaultLibrary = useMemo(() => libraries[0] ?? null, [libraries]);

  const seenLibIds = useRef<Set<number>>(new Set());
  // 知识库默认展开（Obsidian 式）：只对首次出现的新知识库自动展开，
  // 用户手动折叠/展开的状态在刷新后保持，不会被自动还原
  useEffect(() => {
    setExpanded((s) => {
      const next = new Set(s);
      let changed = false;
      for (const l of libraries) {
        if (seenLibIds.current.has(l.id)) continue;
        seenLibIds.current.add(l.id);
        if (!next.has(l.rootFolderId)) {
          next.add(l.rootFolderId);
          changed = true;
        }
      }
      return changed ? next : s;
    });
  }, [libraries]);

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
    const paths = await window.pkm.openPdfDialog();
    if (paths.length) importToPicker(paths);
  };
  const importFolder = async () => {
    setImportMenu(false);
    const paths = await window.pkm.openFolderDialog();
    if (paths.length) importToPicker(paths);
  };

  /** 选择目标目录（树形弹窗）后再执行 */
  const importToPicker = (paths: string[]) => {
    setPicker({
      title: t('sidebar.pickImportTitle'),
      onPick: (folderId) => void doImport(paths, folderId),
    });
  };

  /** 新建知识库：创建后立即进入重命名 */
  const createLibraryAndRename = async () => {
    try {
      const lib = await window.pkm.createLibrary(t('sidebar.newLibraryName'));
      await refresh();
      setExpanded((s) => new Set(s).add(lib.rootFolderId));
      setRenamingNode({ kind: 'library', id: lib.rootFolderId });
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  /** 新建子文件夹：先弹树形选择框，确定后创建并进入重命名 */
  const createSubfolderWithPicker = () => {
    setPicker({
      title: t('sidebar.pickFolderTitle'),
      onPick: async (folderId) => {
        try {
          const created = await window.pkm.createFolder(t('sidebar.newSubfolderName'), folderId);
          // 展开新文件夹的所有祖先
          const ids = new Set<number>();
          let cur: FolderType | undefined = folders.find((f) => f.id === folderId);
          while (cur) {
            ids.add(cur.id);
            if (cur.parentId == null) break;
            const pid = cur.parentId;
            cur = folders.find((f) => f.id === pid);
          }
          setExpanded((s) => new Set([...s, ...ids]));
          await refresh();
          setRenamingNode({ kind: 'folder', id: created.id });
        } catch (err) {
          toast('error', terr(err instanceof Error ? err.message : String(err)));
        }
      },
    });
  };

  /** 新建子文件夹（父级已确定，直接创建并进入重命名） */
  const createFolder = async (parentId: number) => {
    try {
      const created = await window.pkm.createFolder(t('sidebar.newSubfolderName'), parentId);
      toggleExpanded(parentId);
      await refresh();
      setRenamingNode({ kind: 'folder', id: created.id });
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

  const batchMoveTo = async (folderId: number) => {
    setPicker(null);
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

  const moveInboxToLibrary = async (id: number, folderId: number) => {
    setPicker(null);
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
          onClick: () =>
            setPicker({
              title: t('sidebar.moveTitle'),
              onPick: (folderId) => void moveInboxToLibrary(pdf.id, folderId),
            }),
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
            onClick: () =>
              setPicker({
                title: t('sidebar.moveTitle'),
                onPick: (folderId) => void batchMoveTo(folderId),
              }),
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
          onClick: () =>
            setPicker({
              title: t('sidebar.moveTitle'),
              onPick: (folderId) =>
                void (async () => {
                  try {
                    await window.pkm.movePdf(pdf.id, folderId);
                    await refresh();
                  } catch (err) {
                    toast('error', terr(err instanceof Error ? err.message : String(err)));
                  }
                })(),
            }),
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

  const openTaggedPdf = (p: PdfRecord) => {
    openPdf(p.id);
    setTagFilter(null);
  };

  /** 知识库区空白处右键菜单 */
  const blankMenuItems: ContextMenuItem[] = [
    {
      label: t('sidebar.newLibrary'),
      icon: <LibraryBig size={12} />,
      onClick: () => void createLibraryAndRename(),
    },
    {
      label: t('sidebar.newSubfolder'),
      icon: <FolderPlus size={12} />,
      onClick: createSubfolderWithPicker,
    },
    {
      label: t('sidebar.importFiles'),
      icon: <Import size={12} />,
      onClick: () => void importFiles(),
    },
  ];

  if (sidebarCollapsed) {
    return (
      <aside
        className="flex w-11 shrink-0 flex-col items-center border-r border-app-border bg-app-panel py-2"
        onMouseEnter={() => {
          // 自动折叠开启且正在阅读：悬停即临时展开知识库
          if (autoHide) {
            cancelAutoHide();
            setSidebarCollapsed(false);
          }
        }}
      >
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
      onMouseEnter={cancelAutoHide}
      onMouseLeave={scheduleAutoHide}
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
          <IconButton title={t('sidebar.newLibrary')} onClick={() => void createLibraryAndRename()}>
            <LibraryBig size={14} />
          </IconButton>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onClick={(e) => {
          // 点击树区空白处取消多选
          if (!(e.target as HTMLElement).closest('[role="treeitem"]')) clearSelectedPdfs();
        }}
        onContextMenu={(e) => {
          // 知识库区空白处右键：新建知识库 / 新建子文件夹 / 导入 PDF
          if (!(e.target as HTMLElement).closest('[role="treeitem"]')) {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, items: blankMenuItems });
          }
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
            {libraries.map((lib) => (
              <Fragment key={lib.id}>
                <InsertZone
                  onDrop={(id, kind) => {
                    if (kind !== 'library') return;
                    void (async () => {
                      try {
                        await window.pkm.reorderLibrary(id, lib.id);
                        await refresh();
                      } catch (err) {
                        toast('error', terr(err instanceof Error ? err.message : String(err)));
                      }
                    })();
                  }}
                />
                <LibraryNode
                  lib={lib}
                defaultLibrary={defaultLibrary}
                expanded={expanded}
                toggleExpanded={toggleExpanded}
                refresh={refresh}
                toast={toast}
                openPdf={openPdf}
                onMenu={(items, x, y) => setMenu({ x, y, items })}
                onPdfMenu={openPdfMenu}
                setConfirm={setConfirm}
                autoRename={
                  renamingNode?.kind === 'library' && renamingNode.id === lib.rootFolderId
                }
                renamingId={renamingNode?.kind === 'folder' ? renamingNode.id : null}
                onRenameDone={() => setRenamingNode(null)}
                createChild={(parentId) => void createFolder(parentId)}
                onPickFolder={createSubfolderWithPicker}
                onMoveTo={(folderId) =>
                  setPicker({
                    title: t('sidebar.moveTitle'),
                    onPick: (targetId) =>
                      void (async () => {
                        try {
                          await window.pkm.moveFolder(folderId, targetId);
                          await refresh();
                        } catch (err) {
                          toast('error', terr(err instanceof Error ? err.message : String(err)));
                        }
                      })(),
                  })
                }
                onRemovePdf={requestRemovePdf}
                onDropFiles={(paths) => doImport(paths, lib.rootFolderId)}
                onDropFolder={(folderId) =>
                  void (async () => {
                    try {
                      await window.pkm.moveFolder(folderId, lib.rootFolderId);
                      await refresh();
                    } catch (err) {
                      toast('error', terr(err instanceof Error ? err.message : String(err)));
                    }
                  })()
                }
                onDropPdf={(pdfId) =>
                  void (async () => {
                    try {
                      await window.pkm.movePdf(pdfId, lib.rootFolderId);
                      await refresh();
                    } catch (err) {
                      toast('error', terr(err instanceof Error ? err.message : String(err)));
                    }
                  })()
                }
                />
              </Fragment>
            ))}
            <InsertZone
              onDrop={(id, kind) => {
                if (kind !== 'library') return;
                void (async () => {
                  try {
                    await window.pkm.reorderLibrary(id, null);
                    await refresh();
                  } catch (err) {
                    toast('error', terr(err instanceof Error ? err.message : String(err)));
                  }
                })();
              }}
            />
            {libraries.length === 0 && (
              <div
                className="cursor-pointer rounded-md border border-dashed border-app-border px-2 py-3 text-center text-[11px] text-app-muted transition-colors hover:border-app-accent/50 hover:bg-app-panel2"
                onClick={() => void createLibraryAndRename()}
              >
                {t('sidebar.noLibraryHint')}
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
      {picker && (
        <FolderTreePicker
          open
          title={picker.title}
          libraries={libraries}
          folders={folders}
          onPick={(folderId) => {
            const pick = picker.onPick;
            setPicker(null);
            void pick(folderId);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </aside>
  );
}

function LibraryNode({
  lib,
  defaultLibrary,
  expanded,
  toggleExpanded,
  refresh,
  toast,
  openPdf,
  onMenu,
  onPdfMenu,
  setConfirm,
  autoRename,
  onRenameDone,
  renamingId,
  createChild,
  onPickFolder,
  onMoveTo,
  onRemovePdf,
  onDropFiles,
  onDropFolder,
  onDropPdf,
}: {
  lib: LibraryRecord;
  defaultLibrary: LibraryRecord | null;
  expanded: Set<number>;
  toggleExpanded: (id: number) => void;
  refresh: () => Promise<void>;
  toast: (kind: 'info' | 'success' | 'error', text: string) => void;
  openPdf: (id: number) => void;
  onMenu: (items: ContextMenuItem[], x: number, y: number) => void;
  onPdfMenu: (pdf: PdfRecord, x: number, y: number) => void;
  setConfirm: (c: ConfirmState) => void;
  autoRename: boolean;
  onRenameDone: () => void;
  renamingId: number | null;
  createChild: (parentId: number) => void;
  onPickFolder: () => void;
  onMoveTo: (folderId: number) => void;
  onRemovePdf: (pdf: PdfRecord) => void;
  onDropFiles: (paths: string[]) => Promise<void>;
  onDropFolder: (folderId: number) => void;
  onDropPdf: (pdfId: number) => void;
}) {
  const t = useT();
  const terr = useTError();
  const folders = useApp((s) => s.folders);
  const pdfs = useApp((s) => s.pdfs);
  const selectedFolderId = useApp((s) => s.selectedFolderId);
  const setSelectedFolder = useApp((s) => s.setSelectedFolder);
  const [localRenaming, setLocalRenaming] = useState(false);
  const [name, setName] = useState(lib.name);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const isOpen = expanded.has(lib.rootFolderId);
  const isDefault = defaultLibrary?.id === lib.id;
  const children = folders.filter((f) => f.parentId === lib.rootFolderId);
  const pdfsIn = pdfs.filter(
    (p) => p.folderId === lib.rootFolderId || (isDefault && p.folderId === null),
  );
  const renaming = localRenaming || autoRename;

  const commitRename = async () => {
    setLocalRenaming(false);
    onRenameDone();
    const next = name.trim();
    if (!next || next === lib.name) {
      setName(lib.name);
      return;
    }
    try {
      await window.pkm.renameLibrary(lib.id, next);
      await refresh();
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
      setName(lib.name);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    noDrag(e);
    dragDepth.current = 0;
    setDragOver(false);
    if (dragHasFiles(e)) {
      await onDropFiles(pathsFromDrag(e));
      return;
    }
    const f = e.dataTransfer.getData(FOLDER_MIME);
    const p = e.dataTransfer.getData(PDF_MIME);
    try {
      if (f) {
        onDropFolder(Number(f));
        toggleExpanded(lib.rootFolderId);
      } else if (p) {
        onDropPdf(Number(p));
        toggleExpanded(lib.rootFolderId);
      }
    } catch (err) {
      toast('error', terr(err instanceof Error ? err.message : String(err)));
    }
  };

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu(
      [
        {
          label: t('sidebar.newSubfolder'),
          icon: <FolderPlus size={12} />,
          onClick: () => {
            onPickFolder();
            toggleExpanded(lib.rootFolderId);
          },
        },
        {
          label: t('sidebar.rename'),
          icon: <RefreshCcw size={12} />,
          onClick: () => setLocalRenaming(true),
        },
        {
          label: t('sidebar.revealInSystem'),
          icon: <Folder size={12} />,
          onClick: () => void window.pkm.revealFolder(lib.rootFolderId),
        },
        {
          label: t('sidebar.deleteLibrary'),
          danger: true,
          icon: <Trash2 size={12} />,
          onClick: () =>
            setConfirm({
              title: t('sidebar.deleteLibrary'),
              message: t('sidebar.deleteLibraryMsg', { name: lib.name }),
              confirmLabel: t('common.delete'),
              danger: true,
              action: async () => {
                try {
                  await window.pkm.deleteLibrary(lib.id);
                  await refresh();
                  toast('success', t('sidebar.libraryDeleted', { name: lib.name }));
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
        className={`group flex cursor-pointer items-center gap-1 rounded-md py-1.5 text-xs font-semibold transition-all duration-150 ${
          dragOver
            ? 'scale-[1.02] bg-app-accent/20 text-app-text shadow-lg ring-1 ring-app-accent'
            : 'hover:bg-app-panel2'
        } ${
          selectedFolderId === lib.rootFolderId && !dragOver
            ? 'bg-app-accent/10 text-app-text'
            : 'text-app-text/90'
        } focus-visible:ring-2 focus-visible:ring-app-accent/60`}
        style={{ paddingLeft: 6 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(LIBRARY_MIME, String(lib.id));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={noDrag}
        onDragEnter={(e) => {
          noDrag(e);
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={(e) => void handleDrop(e)}
        onClick={() => setSelectedFolder(lib.rootFolderId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setSelectedFolder(lib.rootFolderId);
        }}
        onContextMenu={openMenu}
        title={t('sidebar.dragHint')}
      >
        <button
          className="flex h-4 w-4 items-center justify-center text-app-muted"
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(lib.rootFolderId);
          }}
          aria-label={t('sidebar.expandCollapse')}
        >
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <BookMarked size={dragOver ? 16 : 14} className={dragOver ? 'text-app-accent' : 'text-app-accent'} />
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
                setLocalRenaming(false);
                setName(lib.name);
                onRenameDone();
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="cq-mylib-label min-w-0 flex-1 truncate whitespace-nowrap">{lib.name}</span>
        )}
        {!renaming && (
          <span className="ml-auto pr-1 text-[10px] font-normal text-app-muted">
            {t('sidebar.filesCount', { n: pdfsIn.length })}
          </span>
        )}
      </div>
      {isOpen && (
        <div>
          {children.map((f) => (
            <Fragment key={f.id}>
              <InsertZone
                onDrop={(id, kind) => {
                  if (kind !== 'folder') return;
                  void (async () => {
                    try {
                      await reorderFolderInto(folders, id, f.id, lib.rootFolderId);
                      await refresh();
                    } catch (err) {
                      toast('error', terr(err instanceof Error ? err.message : String(err)));
                    }
                  })();
                }}
              />
              <FolderNode
                folder={f}
                depth={0}
                renamingId={renamingId}
                expanded={expanded}
                toggleExpanded={toggleExpanded}
                refresh={refresh}
                toast={toast}
                openPdf={openPdf}
                onMenu={onMenu}
                onPdfMenu={onPdfMenu}
                setConfirm={setConfirm}
                createChild={createChild}
                onMoveTo={onMoveTo}
                onRenameDone={onRenameDone}
                onRemovePdf={onRemovePdf}
                onDropFiles={onDropFiles}
              />
            </Fragment>
          ))}
          <InsertZone
            onDrop={(id, kind) => {
              if (kind !== 'folder') return;
              void (async () => {
                try {
                  await reorderFolderInto(folders, id, null, lib.rootFolderId);
                  await refresh();
                } catch (err) {
                  toast('error', terr(err instanceof Error ? err.message : String(err)));
                }
              })();
            }}
          />
          {pdfsIn.map((p) => (
            <PdfRow
              key={p.id}
              pdf={p}
              depth={0}
              onClick={() => openPdf(p.id)}
              onMenu={(x, y) => onPdfMenu(p, x, y)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 树形目录选择弹窗：新建子文件夹 / 导入 / 移动 PDF 共用 */
export function FolderTreePicker({
  open,
  title,
  libraries,
  folders,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  libraries: LibraryRecord[];
  folders: FolderType[];
  onPick: (folderId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(libraries.map((l) => l.rootFolderId)),
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  useEffect(() => {
    if (open) {
      setExpanded(new Set(libraries.map((l) => l.rootFolderId)));
      setSelectedId(libraries[0]?.rootFolderId ?? null);
    }
  }, [open, libraries]);

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderFolder = (parentId: number, depth: number) => {
    const children = folders.filter((f) => f.parentId === parentId);
    return (
      <div>
        {children.map((f) => (
          <div key={f.id}>
            <div
              className={`flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-panel2 ${
                selectedId === f.id ? 'bg-app-accent/15 text-app-text' : ''
              }`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => {
                setSelectedId(f.id);
                toggle(f.id);
              }}
            >
              <button
                className="flex h-4 w-4 shrink-0 items-center justify-center text-app-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(f.id);
                  toggle(f.id);
                }}
                aria-label={t('sidebar.expandCollapseFolder')}
              >
                {expanded.has(f.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <Folder size={13} className="shrink-0 text-app-accent2/90" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
            </div>
            {expanded.has(f.id) && renderFolder(f.id, depth + 1)}
          </div>
        ))}
      </div>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={title} width={380}>
      <div className="max-h-[55vh] space-y-0.5 overflow-y-auto">
        {libraries.length === 0 && (
          <div className="px-2 py-3 text-center text-[11px] text-app-muted">
            {t('sidebar.noLibraryHint')}
          </div>
        )}
        {libraries.map((lib) => (
          <div key={lib.id}>
            <div
              className={`flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-panel2 ${
                selectedId === lib.rootFolderId ? 'bg-app-accent/15 text-app-text' : ''
              }`}
              onClick={() => {
                setSelectedId(lib.rootFolderId);
                toggle(lib.rootFolderId);
              }}
            >
              <button
                className="flex h-4 w-4 shrink-0 items-center justify-center text-app-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(lib.rootFolderId);
                  toggle(lib.rootFolderId);
                }}
                aria-label={t('sidebar.expandCollapse')}
              >
                {expanded.has(lib.rootFolderId) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <BookMarked size={13} className="shrink-0 text-app-accent" />
              <span className="min-w-0 flex-1 truncate font-medium">{lib.name}</span>
            </div>
            {expanded.has(lib.rootFolderId) && renderFolder(lib.rootFolderId, 1)}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-app-border pt-2">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-app-muted">
          {selectedId != null
            ? t('sidebar.pickSelected', {
                name:
                  folders.find((f) => f.id === selectedId)?.name ??
                  libraries.find((l) => l.rootFolderId === selectedId)?.name ??
                  '',
              })
            : t('sidebar.pickHint')}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={selectedId == null}
          onClick={() => {
            if (selectedId != null) onPick(selectedId);
          }}
        >
          {t('sidebar.pickConfirm')}
        </Button>
      </div>
    </Modal>
  );
}

function FolderNode({
  folder,
  depth,
  renamingId,
  expanded,
  toggleExpanded,
  refresh,
  toast,
  openPdf,
  onMenu,
  onPdfMenu,
  setConfirm,
  createChild,
  onMoveTo,
  onRenameDone,
  onRemovePdf,
  onDropFiles,
}: {
  folder: FolderType;
  depth: number;
  renamingId: number | null;
  expanded: Set<number>;
  toggleExpanded: (id: number) => void;
  refresh: () => Promise<void>;
  toast: (kind: 'info' | 'success' | 'error', text: string) => void;
  openPdf: (id: number) => void;
  onMenu: (items: ContextMenuItem[], x: number, y: number) => void;
  onPdfMenu: (pdf: PdfRecord, x: number, y: number) => void;
  setConfirm: (c: ConfirmState) => void;
  createChild: (parentId: number) => void;
  onMoveTo?: (folderId: number) => void;
  onRenameDone?: () => void;
  onRemovePdf: (pdf: PdfRecord) => void;
  onDropFiles: (paths: string[]) => Promise<void>;
}) {
  const t = useT();
  const terr = useTError();
  const folders = useApp((s) => s.folders);
  const pdfs = useApp((s) => s.pdfs);
  const selectedFolderId = useApp((s) => s.selectedFolderId);
  const setSelectedFolder = useApp((s) => s.setSelectedFolder);
  const [localRenaming, setLocalRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const [dragOver, setDragOver] = useState(false);
  // 拖入计数器：行内包含多个子元素，直接 onDragLeave 会在子元素间闪烁，
  // 用 enter/leave 深度计数保证只在真正离开该行时才取消高亮。
  const dragDepth = useRef(0);

  const children = folders.filter((f) => f.parentId === folder.id);
  const pdfsIn = pdfs.filter((p) => p.folderId === folder.id);
  const isOpen = expanded.has(folder.id);
  const renaming = localRenaming || renamingId === folder.id;

  const handleDrop = async (e: React.DragEvent) => {
    noDrag(e);
    dragDepth.current = 0;
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
    setLocalRenaming(false);
    onRenameDone?.();
    const next = name.trim();
    if (!next || next === folder.name) {
      setName(folder.name);
      return;
    }
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
        {
          label: t('sidebar.newChildFolder'),
          icon: <FolderPlus size={12} />,
          onClick: () => createChild(folder.id),
        },
        {
          label: t('sidebar.rename'),
          icon: <RefreshCcw size={12} />,
          onClick: () => setLocalRenaming(true),
        },
        ...(onMoveTo
          ? [
              {
                label: t('sidebar.moveTo'),
                icon: <Folder size={12} />,
                onClick: () => onMoveTo!(folder.id),
              },
            ]
          : []),
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
        className={`group flex cursor-pointer items-center gap-1 rounded-md py-[3px] text-xs transition-all duration-150 ${
          dragOver
            ? 'scale-[1.03] bg-app-accent/20 text-app-text shadow-lg ring-1 ring-app-accent'
            : 'hover:bg-app-panel2'
        } ${selectedFolderId === folder.id && !dragOver ? 'bg-app-accent/10 text-app-text' : 'text-app-text/90'} focus-visible:ring-2 focus-visible:ring-app-accent/60`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_MIME, String(folder.id));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={noDrag}
        onDragEnter={(e) => {
          noDrag(e);
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
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
          <FolderOpen
            size={dragOver ? 16 : 13}
            className={`transition-all ${dragOver ? 'text-app-accent' : 'text-app-accent2/90'}`}
          />
        ) : (
          <Folder
            size={dragOver ? 16 : 13}
            className={`transition-all ${dragOver ? 'text-app-accent' : 'text-app-accent2/90'}`}
          />
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
                setLocalRenaming(false);
                setName(folder.name);
                onRenameDone?.();
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
              createChild(folder.id);
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
            <Fragment key={f.id}>
              <InsertZone
                onDrop={(id, kind) => {
                  if (kind !== 'folder') return;
                  void (async () => {
                    try {
                      await reorderFolderInto(folders, id, f.id, folder.id);
                      await refresh();
                    } catch (err) {
                      toast('error', terr(err instanceof Error ? err.message : String(err)));
                    }
                  })();
                }}
              />
              <FolderNode
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
                renamingId={renamingId}
                createChild={createChild}
                onMoveTo={onMoveTo}
                onRenameDone={onRenameDone}
                onRemovePdf={onRemovePdf}
                onDropFiles={onDropFiles}
              />
            </Fragment>
          ))}
          <InsertZone
            onDrop={(id, kind) => {
              if (kind !== 'folder') return;
              void (async () => {
                try {
                  await reorderFolderInto(folders, id, null, folder.id);
                  await refresh();
                } catch (err) {
                  toast('error', terr(err instanceof Error ? err.message : String(err)));
                }
              })();
            }}
          />
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
