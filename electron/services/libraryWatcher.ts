import fs from 'fs';
import path from 'path';
import type { Folder, LibraryRecord, PdfRecord } from '../../src/shared/types';
import { getLibraryPdfDir } from '../db/database';
import { repository } from '../db/repository';
import { guessPageCount } from './pdfMeta';

let timer: NodeJS.Timeout | null = null;
let watcher: fs.FSWatcher | null = null;
let fallbackTimer: NodeJS.Timeout | null = null;
let scanning = false;
let listener: (() => void) | null = null;

function isInside(target: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function relDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function nameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

function realPathOf(dir: string, relPath: string): string {
  return relPath ? path.join(dir, ...relPath.split('/')) : dir;
}

/** Next free filename inside dir: name.pdf, name (1).pdf, ... */
function uniqueFileInDir(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

/** Walk Library collecting dirs (relPath -> name) and files (relPath + size). */
async function walkTree(
  base: string,
  foundDirs: Map<string, string>,
  foundFiles: Array<{ relPath: string; size: number }>,
  rel = '',
): Promise<void> {
  let entries;
  try {
    entries = await fs.promises.readdir(rel ? path.join(base, ...rel.split('/')) : base, {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      foundDirs.set(childRel, entry.name);
      await walkTree(base, foundDirs, foundFiles, childRel);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      try {
        const st = await fs.promises.stat(path.join(base, ...childRel.split('/')));
        foundFiles.push({ relPath: childRel, size: st.size });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Strict two-way sync between the Library directory and the database:
 * - folders created/renamed/moved in Explorer are mirrored (rename matched by
 *   "one disappeared folder + one orphan directory at the same parent");
 * - PDF files moved or renamed in Explorer keep their record (matched by
 *   filename, or by same folder + size), so no duplicates appear;
 * - new PDFs are inserted automatically; deleted managed files are marked missing.
 */
export async function scanLibrary(): Promise<{ added: number }> {
  const dir = getLibraryPdfDir();
  const diskDirs = new Map<string, string>();
  const diskFiles: Array<{ relPath: string; size: number }> = [];
  await walkTree(dir, diskDirs, diskFiles);
  const presentFiles = new Set(
    diskFiles.map((f) => path.join(dir, ...f.relPath.split('/')).toLowerCase()),
  );

  // ---------- 0. 知识库 reconcile：顶层目录 ↔ libraries 表（新建/重命名/删除） ----------
  const libraries = repository.getLibraries();
  const libByRel = new Map<string, LibraryRecord>();
  for (const l of libraries) libByRel.set(l.name, l);
  const diskLibDirs = [...diskDirs.keys()].filter((rel) => !rel.includes('/'));
  const consumedLibDirs = new Set<string>();
  for (const l of libraries) {
    if (diskLibDirs.includes(l.name)) {
      consumedLibDirs.add(l.name);
      continue;
    }
    // 知识库目录在本地消失：若同级恰好多出一个目录则视为重命名，否则删除
    const orphans = diskLibDirs.filter(
      (rel) => !libByRel.has(rel) && !consumedLibDirs.has(rel),
    );
    if (orphans.length === 1) {
      repository.renameLibrary(l.id, orphans[0]);
      consumedLibDirs.add(orphans[0]);
      continue;
    }
    repository.deleteLibrary(l.id);
    libByRel.delete(l.name);
  }
  for (const rel of diskLibDirs) {
    if (consumedLibDirs.has(rel) || libByRel.has(rel)) continue;
    const lib = repository.createLibrary(rel);
    libByRel.set(rel, lib);
    consumedLibDirs.add(rel);
  }

  // Library 根目录散落的 PDF 收进默认知识库（保证每个库内文件都在知识库目录下）
  let defaultRootId: number | null = null;
  try {
    defaultRootId = repository.defaultLibraryRootId();
  } catch {
    defaultRootId = null;
  }
  if (defaultRootId != null) {
    const lib = repository.getDefaultLibrary();
    const rootFiles = diskFiles.filter((f) => !f.relPath.includes('/'));
    for (const f of rootFiles) {
      if (!lib) break;
      const src = path.join(dir, f.relPath);
      const targetDir = path.join(dir, lib.name);
      fs.mkdirSync(targetDir, { recursive: true });
      const dest = uniqueFileInDir(targetDir, path.basename(f.relPath));
      try {
        if (path.resolve(src) !== path.resolve(dest)) fs.renameSync(src, dest);
        f.relPath = `${lib.name}/${path.basename(dest)}`;
      } catch {
        /* 保留原位，仍按根目录文件处理 */
      }
    }
  }

  // ---------- 1. folder reconcile (rename detection, top-down) ----------
  const dbFolders = repository.getFolders();
  const folderByRel = new Map<string, Folder>();
  for (const f of dbFolders) folderByRel.set(f.path, f);
  const foldersByParent = new Map<number | null, Folder[]>();
  for (const f of dbFolders) {
    const arr = foldersByParent.get(f.parentId) ?? [];
    arr.push(f);
    foldersByParent.set(f.parentId, arr);
  }
  const consumedDirs = new Set<string>();
  const ordered = [...dbFolders].sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length,
  );

  for (const f of ordered) {
    if (diskDirs.has(f.path)) {
      consumedDirs.add(f.path);
      continue;
    }
    // Folder is missing on disk: try to match it with an orphan directory.
    const parentRel = relDirOf(f.path);
    const diskChildren = [...diskDirs.keys()].filter(
      (rel) => rel !== parentRel && relDirOf(rel) === parentRel,
    );
    const dbChildren = new Set(
      (foldersByParent.get(f.parentId) ?? []).map((c) => c.path),
    );
    const orphans = diskChildren.filter((rel) => !dbChildren.has(rel) && !consumedDirs.has(rel));
    if (orphans.length === 1) {
      const newRel = orphans[0];
      repository.applyFolderRename(f.id, nameOf(newRel), newRel);
      consumedDirs.add(newRel);
      folderByRel.delete(f.path);
      folderByRel.set(newRel, f);
      continue;
    }
    // 目录已在本地删除：严格同步，删除该文件夹及其记录（笔记/标注随之清理）
    if (f.parentId !== null) {
      repository.deleteFolder(f.id);
    }
    folderByRel.delete(f.path);
  }

  // ---------- 2. create rows for remaining (new) disk directories ----------
  const folderIdByRel = new Map<string, number>();
  for (const rel of diskDirs.keys()) {
    if (consumedDirs.has(rel) || folderByRel.has(rel)) {
      if (folderByRel.has(rel)) folderIdByRel.set(rel, folderByRel.get(rel)!.id);
      continue;
    }
    const folder = repository.ensureFolderByRelPath(rel);
    folderByRel.set(rel, folder);
    folderIdByRel.set(rel, folder.id);
  }
  folderIdByRel.set('', defaultRootId ?? -1);

  // ---------- 3. file reconcile (move / rename / insert) ----------
  const dbPdfs = repository.getPdfs();
  const pdfByLowerPath = new Map<string, PdfRecord>();
  for (const p of dbPdfs) pdfByLowerPath.set(p.filepath.toLowerCase(), p);
  const handledPdfIds = new Set<number>();
  const consumedFiles = new Set<string>();

  // 3a. files missing on disk but with an identical record elsewhere by filename
  const missingByName = new Map<string, PdfRecord[]>();
  for (const p of dbPdfs) {
    if (p.status === 'missing' || !fs.existsSync(p.filepath)) {
      const key = p.filename.toLowerCase();
      const arr = missingByName.get(key) ?? [];
      arr.push(p);
      missingByName.set(key, arr);
    }
  }
  for (const f of diskFiles) {
    const full = path.join(dir, ...f.relPath.split('/'));
    const lower = full.toLowerCase();
    if (pdfByLowerPath.has(lower)) continue;
    const key = f.relPath.slice(f.relPath.lastIndexOf('/') + 1).toLowerCase();
    const candidates = missingByName.get(key) ?? [];
    const relDir = relDirOf(f.relPath);
    const sameDir = candidates.filter((c) => {
      const cDir = path.basename(path.dirname(c.filepath)).toLowerCase();
      const target = relDir ? nameOf(relDir).toLowerCase() : '';
      return cDir === target;
    });
    const hit = sameDir[0] ?? candidates[0];
    if (hit) {
      const folderId = relDir ? (folderIdByRel.get(relDir) ?? null) : null;
      repository.updatePdfLocation(hit.id, full, folderId);
      handledPdfIds.add(hit.id);
      consumedFiles.add(lower);
      pdfByLowerPath.set(lower, hit);
      missingByName.set(
        key,
        candidates.filter((c) => c.id !== hit.id),
      );
    }
  }

  // 3b. in-place rename: record exists in the same folder, file gone, size matches
  for (const f of diskFiles) {
    const full = path.join(dir, ...f.relPath.split('/'));
    const lower = full.toLowerCase();
    if (consumedFiles.has(lower) || pdfByLowerPath.has(lower)) continue;
    const relDir = relDirOf(f.relPath);
    const folderId = relDir ? (folderIdByRel.get(relDir) ?? null) : null;
    const candidates = dbPdfs.filter(
      (p) =>
        !handledPdfIds.has(p.id) &&
        (p.folderId ?? null) === folderId &&
        p.status === 'ok' &&
        !fs.existsSync(p.filepath) &&
        p.size === f.size,
    );
    if (candidates.length === 1) {
      repository.updatePdfLocation(candidates[0].id, full, folderId);
      handledPdfIds.add(candidates[0].id);
      consumedFiles.add(lower);
      pdfByLowerPath.set(lower, candidates[0]);
    }
  }

  // 3c. remaining new files -> insert
  let added = 0;
  for (const f of diskFiles) {
    const full = path.join(dir, ...f.relPath.split('/'));
    const lower = full.toLowerCase();
    if (consumedFiles.has(lower) || pdfByLowerPath.has(lower)) continue;
    try {
      const relDir = relDirOf(f.relPath);
      const folderId = relDir ? (folderIdByRel.get(relDir) ?? null) : null;
      repository.insertPdf({
        filename: path.basename(full),
        filepath: full,
        title: path.basename(full).replace(/\.pdf$/i, ''),
        folderId: folderId === -1 ? null : folderId,
        size: f.size,
        pageCount: guessPageCount(full),
      });
      added++;
    } catch {
      /* ignore single-file failure */
    }
  }

  // ---------- 4. managed files deleted from disk -> sync delete records ----------
  for (const p of dbPdfs) {
    if (
      !handledPdfIds.has(p.id) &&
      p.status === 'ok' &&
      isInside(p.filepath, dir) &&
      !presentFiles.has(p.filepath.toLowerCase())
    ) {
      repository.deletePdf(p.id);
    }
  }

  return { added };
}

function notify(): void {
  listener?.();
}

/** Watch the Library tree (fs.watch recursive on Windows) and scan on change. */
export function startLibraryWatcher(onChange: () => void): void {
  listener = onChange;
  const dir = getLibraryPdfDir();
  fs.mkdirSync(dir, { recursive: true });

  const runScan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      await scanLibrary();
      notify();
    } catch {
      /* ignore */
    } finally {
      scanning = false;
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runScan();
    }, 400);
  };

  try {
    watcher = fs.watch(dir, { recursive: true }, () => schedule());
    watcher.on('error', () => {
      watcher?.close();
      fallbackTimer = setInterval(() => void runScan(), 15000);
    });
  } catch {
    fallbackTimer = setInterval(() => void runScan(), 15000);
  }

  void runScan();
}

export function stopLibraryWatcher(): void {
  if (timer) clearTimeout(timer);
  if (fallbackTimer) clearInterval(fallbackTimer);
  try {
    watcher?.close();
  } catch {
    /* ignore */
  }
  watcher = null;
  timer = null;
  fallbackTimer = null;
  listener = null;
}
