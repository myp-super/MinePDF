import fs from 'fs';
import path from 'path';
import type {
  AnnotationRecord,
  Folder,
  LibraryRecord,
  NewAnnotation,
  NoteRecord,
  PdfRecord,
  Quad,
  Tag,
} from '../../src/shared/types';
import { getDataDir, getDb, getInboxDir, getLibraryPdfDir } from './database';

type Row = Record<string, unknown>;

function row<T>(r: Row | undefined): T {
  return (r ?? {}) as T;
}

const mapFolder = (r: Row): Folder => ({
  id: Number(r.id),
  name: String(r.name),
  parentId: r.parent_id == null ? null : Number(r.parent_id),
  path: String(r.path ?? ''),
  libraryId: r.library_id == null ? null : Number(r.library_id),
  createdTime: String(r.created_time),
});

const mapLibrary = (r: Row): LibraryRecord => ({
  id: Number(r.id),
  name: String(r.name),
  rootFolderId: r.root_folder_id == null ? -1 : Number(r.root_folder_id),
  createdAt: String(r.created_time),
});

const mapTag = (r: Row): Tag => ({
  id: Number(r.id),
  name: String(r.name),
  createdTime: String(r.created_time),
});

const mapPdf = (r: Row): PdfRecord => ({
  id: Number(r.id),
  filename: String(r.filename),
  filepath: String(r.filepath),
  title: String(r.title),
  folderId: r.folder_id == null ? null : Number(r.folder_id),
  size: Number(r.size ?? 0),
  pageCount: r.page_count == null ? null : Number(r.page_count),
  hasOutline: Number(r.has_outline ?? 0) === 1,
  createdAt: String(r.created_time),
  updatedAt: String(r.updated_time),
  status: r.status === 'missing' ? 'missing' : 'ok',
  tags: [],
});

function now(): string {
  return new Date().toISOString();
}

/** 去掉文件名中的非法字符 */
function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || '笔记';
}

/**
 * One note = one dedicated folder (Obsidian style):
 *   data/notes/<PDF title>/
 *     ├── <PDF title> 笔记.md
 *     └── assets/          (screenshots owned by this note)
 */
function noteFolderFor(pdf: PdfRecord): { dir: string; file: string } {
  const notesDir = path.join(getDataDir(), 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  const base = sanitizeFilename(pdf.title) || '笔记';
  let folder = path.join(notesDir, base);
  let i = 2;
  const db = getDb();
  while (fs.existsSync(folder) && !db.prepare('SELECT id FROM notes WHERE note_dir = ?').get(folder)) {
    folder = path.join(notesDir, `${base} (${i})`);
    i++;
  }
  fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
  return { dir: folder, file: path.join(folder, `${path.basename(folder)} 笔记.md`) };
}

const ILLEGAL_FOLDER_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Validate a folder name and normalize it (Windows-safe). */
function sanitizeFolderName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error('文件夹名称不能为空');
  if (n === '.' || n === '..' || ILLEGAL_FOLDER_CHARS.test(n) || /[. ]$/.test(n)) {
    throw new Error('文件夹名称包含非法字符（<>:"/\\|?* 等）');
  }
  return n;
}

/** Real filesystem path for a relative folder path inside Library (with mkdir). */
function realDirForRel(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  const dir = path.join(getLibraryPdfDir(), ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Real path without creating it (used for deletion checks). */
function resolveRel(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  return path.join(getLibraryPdfDir(), ...parts);
}

function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** 同级下一个排序号（新文件夹/知识库追加到末尾） */
function nextSiblingOrder(db: ReturnType<typeof getDb>, parentId: number | null): number {
  const r = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM folders WHERE parent_id IS ?')
    .get(parentId) as Row;
  return Number(r.m) + 1;
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

function isInside(target: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Write the annotation mirror file. */
function writeAnnotationMirror(pdfId: number, items: AnnotationRecord[]): void {
  try {
    fs.writeFileSync(
      path.join(getDataDir(), 'annotations', `${pdfId}.json`),
      JSON.stringify(items, null, 2),
      'utf8',
    );
  } catch {
    /* mirror failure does not affect main flow */
  }
}

export const repository = {
  // ---------- libraries（知识库 = Library 下的一级目录） ----------
  getLibraries(): LibraryRecord[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT l.id, l.name, l.created_time, f.id AS root_folder_id
         FROM libraries l
         LEFT JOIN folders f ON f.library_id = l.id AND f.parent_id IS NULL
         ORDER BY l.sort_order, l.name COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map(mapLibrary);
  },

  getLibrary(id: number): LibraryRecord | null {
    return this.getLibraries().find((l) => l.id === id) ?? null;
  },

  /** 默认知识库（迁移后总是存在；用于兼容旧的空 folderId 调用） */
  getDefaultLibrary(): LibraryRecord | null {
    const db = getDb();
    const r = db
      .prepare(
        `SELECT l.id, l.name, l.created_time, f.id AS root_folder_id
         FROM libraries l
         LEFT JOIN folders f ON f.library_id = l.id AND f.parent_id IS NULL
         ORDER BY l.id LIMIT 1`,
      )
      .get() as Row | undefined;
    return r ? mapLibrary(r) : null;
  },

  defaultLibraryRootId(): number {
    const lib = this.getDefaultLibrary();
    if (!lib || lib.rootFolderId <= 0) throw new Error('知识库尚未初始化，请先新建知识库');
    return lib.rootFolderId;
  },

  createLibrary(name: string): LibraryRecord {
    const db = getDb();
    const n = sanitizeFolderName(name);
    const dup = db.prepare('SELECT id FROM libraries WHERE name = ? COLLATE NOCASE').get(n);
    if (dup) throw new Error('已存在同名知识库');
    const dir = path.join(getLibraryPdfDir(), n);
    if (fs.existsSync(dir)) throw new Error('本地目录已存在同名文件夹');
    const t = now();
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM libraries').get() as Row;
    const libRes = db
      .prepare('INSERT INTO libraries (name, sort_order, created_time) VALUES (?, ?, ?)')
      .run(n, Number(maxOrder.m) + 1, t);
    const libId = Number(libRes.lastInsertRowid);
    fs.mkdirSync(dir, { recursive: true });
    const fRes = db
      .prepare(
        'INSERT INTO folders (name, parent_id, path, library_id, created_time) VALUES (?, NULL, ?, ?, ?)',
      )
      .run(n, n, libId, t);
    return { id: libId, name: n, rootFolderId: Number(fRes.lastInsertRowid), createdAt: t };
  },

  renameLibrary(id: number, name: string): void {
    const db = getDb();
    const lib = this.getLibrary(id);
    if (!lib) throw new Error('知识库不存在');
    const n = sanitizeFolderName(name);
    const dup = db.prepare('SELECT id FROM libraries WHERE name = ? COLLATE NOCASE AND id != ?').get(n, id);
    if (dup) throw new Error('已存在同名知识库');
    const oldDir = path.join(getLibraryPdfDir(), lib.name);
    const newDir = path.join(getLibraryPdfDir(), n);
    if (path.resolve(oldDir) !== path.resolve(newDir)) {
      if (fs.existsSync(newDir) && fs.existsSync(oldDir)) throw new Error('本地目录已存在同名文件夹');
      if (fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, newDir);
      } else if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }
    }
    db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(n, id);
    this.applyFolderRename(lib.rootFolderId, n, n);
  },

  deleteLibrary(id: number): void {
    const lib = this.getLibrary(id);
    if (!lib) throw new Error('知识库不存在');
    if (lib.rootFolderId > 0) this.deleteFolder(lib.rootFolderId);
    getDb().prepare('DELETE FROM libraries WHERE id = ?').run(id);
  },

  // ---------- folders (mirrored to real directories under Library) ----------
  getFolders(): Folder[] {
    const db = getDb();
    return (
      db
        .prepare('SELECT * FROM folders ORDER BY sort_order, name COLLATE NOCASE')
        .all() as Row[]
    ).map(mapFolder);
  },

  getFolder(id: number): Folder | null {
    const db = getDb();
    const r = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Row | undefined;
    return r ? mapFolder(r) : null;
  },

  /** Filesystem directory for a folder (null → 默认知识库根目录). */
  folderFsDir(folderId: number | null): string {
    if (folderId == null) {
      const lib = this.getDefaultLibrary();
      const dir = lib ? path.join(getLibraryPdfDir(), lib.name) : getLibraryPdfDir();
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    const f = this.getFolder(folderId);
    if (!f) throw new Error('目标文件夹不存在');
    return realDirForRel(f.path);
  },

  /** Real directory for a folder without creating it (for "show in system"). */
  folderRealDir(folderId: number): string {
    const f = this.getFolder(folderId);
    if (!f) throw new Error('文件夹不存在');
    return resolveRel(f.path);
  },

  /** Ensure a folder row exists for a relative path; creates parent chain. */
  ensureFolderByRelPath(relPath: string): Folder {
    const db = getDb();
    const parts = relPath.split('/').filter(Boolean);
    let parentId: number | null = null;
    let libId: number | null = null;
    let acc = '';
    let folder: Folder | null = null;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      const existing = db
        .prepare('SELECT * FROM folders WHERE parent_id IS ? AND name = ?')
        .get(parentId, part) as Row | undefined;
      if (existing) {
        folder = mapFolder(existing);
        if (i === 0) {
          libId = folder.libraryId;
        } else if (libId != null && folder.libraryId == null) {
          db.prepare('UPDATE folders SET library_id = ? WHERE id = ?').run(libId, folder.id);
          folder = mapFolder(db.prepare('SELECT * FROM folders WHERE id = ?').get(folder.id) as Row);
        }
      } else if (i === 0) {
        // 顶层目录 = 知识库
        let lib = db
          .prepare('SELECT id FROM libraries WHERE name = ? COLLATE NOCASE')
          .get(part) as Row | undefined;
        let newLibId: number;
        if (lib) {
          newLibId = Number(lib.id);
        } else {
          const t = now();
          fs.mkdirSync(path.join(getLibraryPdfDir(), part), { recursive: true });
          const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM libraries').get() as Row;
          const r = db
            .prepare('INSERT INTO libraries (name, sort_order, created_time) VALUES (?, ?, ?)')
            .run(part, Number(maxOrder.m) + 1, t);
          newLibId = Number(r.lastInsertRowid);
        }
        libId = newLibId;
        const res = db
          .prepare(
            'INSERT INTO folders (name, parent_id, path, library_id, sort_order, created_time) VALUES (?, NULL, ?, ?, ?, ?)',
          )
          .run(part, acc, newLibId, nextSiblingOrder(db, null), now());
        folder = mapFolder(db.prepare('SELECT * FROM folders WHERE id = ?').get(res.lastInsertRowid) as Row);
      } else {
        const res = db
          .prepare(
            'INSERT INTO folders (name, parent_id, path, library_id, sort_order, created_time) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(part, parentId, acc, libId, nextSiblingOrder(db, parentId), now());
        folder = mapFolder(db.prepare('SELECT * FROM folders WHERE id = ?').get(res.lastInsertRowid) as Row);
      }
      parentId = folder.id;
    }
    if (!folder) throw new Error('无法创建文件夹');
    return folder;
  },

  createFolder(name: string, parentId: number | null): Folder {
    if (parentId == null) throw new Error('请选择目标知识库或文件夹');
    const db = getDb();
    const n = sanitizeFolderName(name);
    const parent = this.getFolder(parentId);
    if (!parent) throw new Error('父文件夹不存在');
    const dup = db
      .prepare('SELECT id FROM folders WHERE parent_id IS ? AND name = ?')
      .get(parentId, n);
    if (dup) throw new Error('同级已存在同名文件夹');

    const rel = joinRel(parent.path, n);
    realDirForRel(rel); // create the real directory in Library
    const res = db
      .prepare(
        'INSERT INTO folders (name, parent_id, path, library_id, sort_order, created_time) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(n, parentId, rel, parent.libraryId, nextSiblingOrder(db, parentId), now());
    const created = db.prepare('SELECT * FROM folders WHERE id = ?').get(res.lastInsertRowid) as Row;
    return mapFolder(row(created));
  },

  renameFolder(id: number, name: string): void {
    const f = this.getFolder(id);
    if (!f) throw new Error('文件夹不存在');
    const n = sanitizeFolderName(name);
    const db = getDb();
    const dup = db
      .prepare('SELECT id FROM folders WHERE parent_id IS ? AND name = ? AND id != ?')
      .get(f.parentId, n, id);
    if (dup) throw new Error('同级已存在同名文件夹');

    const parent = f.parentId != null ? this.getFolder(f.parentId) : null;
    const newRel = joinRel(parent?.path ?? '', n);
    if (f.path !== newRel) {
      const oldDir = resolveRel(f.path);
      const newDir = resolveRel(newRel);
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      if (fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, newDir);
      } else {
        fs.mkdirSync(newDir, { recursive: true });
      }
    }
    this.applyFolderRename(id, n, newRel);
  },

  moveFolder(id: number, parentId: number | null): void {
    const db = getDb();
    const f = this.getFolder(id);
    if (!f) throw new Error('文件夹不存在');
    if (parentId == null) throw new Error('请选择目标知识库或文件夹');
    if (id === parentId) throw new Error('不能移动到自身');
    // Reject moving into its own subtree (cycle check).
    let cur: number | null = parentId;
    const visited = new Set<number>();
    while (cur != null && !visited.has(cur)) {
      if (cur === id) throw new Error('不能移动到自身的子文件夹');
      visited.add(cur);
      const r = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur);
      cur = r ? ((r as Row).parent_id as number | null) : null;
    }
    const parent = this.getFolder(parentId);
    if (!parent) throw new Error('父文件夹不存在');
    const newRel = joinRel(parent.path, f.name);
    const dup = db
      .prepare('SELECT id FROM folders WHERE parent_id IS ? AND name = ? AND id != ?')
      .get(parentId, f.name, id);
    if (dup) throw new Error('目标位置已存在同名文件夹');

    if (f.path !== newRel) {
      const oldDir = resolveRel(f.path);
      const newDir = resolveRel(newRel);
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      if (fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, newDir);
      } else {
        fs.mkdirSync(newDir, { recursive: true });
      }
    }
    db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(parentId, id);
    this.applyFolderRename(id, f.name, newRel);
    // 移动到新位置后追加到同级末尾（用户可再拖拽排序）
    db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?').run(
      nextSiblingOrder(db, parentId),
      id,
    );
    // 跨知识库移动时，整个子树归属新的知识库
    if (parent.libraryId != null) {
      db.prepare(`UPDATE folders SET library_id = ? WHERE path = ? OR path LIKE ? || '/%'`).run(
        parent.libraryId,
        newRel,
        newRel,
      );
    }
  },

  /** 同级拖拽排序：把文件夹排到 beforeId 之前（beforeId=null 表示排到末尾） */
  reorderFolder(id: number, beforeId: number | null): void {
    const db = getDb();
    const f = this.getFolder(id);
    if (!f) throw new Error('文件夹不存在');
    const siblings = db
      .prepare(
        'SELECT id FROM folders WHERE parent_id IS ? AND id != ? ORDER BY sort_order, name COLLATE NOCASE',
      )
      .all(f.parentId, id) as Row[];
    const ids = siblings.map((r) => Number(r.id));
    let insertAt = ids.length;
    if (beforeId != null) {
      const idx = ids.indexOf(beforeId);
      if (idx !== -1) insertAt = idx;
    }
    ids.splice(insertAt, 0, id);
    const upd = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?');
    ids.forEach((fid, i) => upd.run(i, fid));
  },

  /** 知识库拖拽排序：把知识库排到 beforeId 之前（beforeId=null 表示排到末尾） */
  reorderLibrary(id: number, beforeId: number | null): void {
    const db = getDb();
    if (!this.getLibrary(id)) throw new Error('知识库不存在');
    const siblings = db
      .prepare('SELECT id FROM libraries WHERE id != ? ORDER BY sort_order, name COLLATE NOCASE')
      .all(id) as Row[];
    const ids = siblings.map((r) => Number(r.id));
    let insertAt = ids.length;
    if (beforeId != null) {
      const idx = ids.indexOf(beforeId);
      if (idx !== -1) insertAt = idx;
    }
    ids.splice(insertAt, 0, id);
    const upd = db.prepare('UPDATE libraries SET sort_order = ? WHERE id = ?');
    ids.forEach((fid, i) => upd.run(i, fid));
  },

  /** Update path of a folder and all descendants after rename/move. */
  updateFolderPaths(id: number, newRel: string): void {
    const db = getDb();
    const all = db.prepare('SELECT id, parent_id, name FROM folders').all() as Row[];
    const upd = db.prepare('UPDATE folders SET path = ? WHERE id = ?');
    // Recompute from tree: simpler to walk by parent links.
    const byParent = new Map<number | null, Row[]>();
    for (const r of all) {
      const pid = r.parent_id == null ? null : Number(r.parent_id);
      const arr = byParent.get(pid) ?? [];
      arr.push(r);
      byParent.set(pid, arr);
    }
    const setPath = (fid: number, rel: string): void => {
      upd.run(rel, fid);
      const children = byParent.get(fid) ?? [];
      for (const c of children) {
        setPath(Number(c.id), joinRel(rel, String(c.name)));
      }
    };
    setPath(id, newRel);
  },

  /**
   * Apply a folder rename/move discovered by the library scan:
   * update name + path for the folder and its subtree, and remap every PDF
   * filepath that lives under the old directory.
   */
  applyFolderRename(id: number, newName: string, newRel: string): void {
    const db = getDb();
    const current = this.getFolder(id);
    if (!current) return;
    const oldRel = current.path;
    const all = db.prepare('SELECT id, parent_id, name FROM folders').all() as Row[];
    const byParent = new Map<number | null, Row[]>();
    for (const r of all) {
      const pid = r.parent_id == null ? null : Number(r.parent_id);
      const arr = byParent.get(pid) ?? [];
      arr.push(r);
      byParent.set(pid, arr);
    }
    const upd = db.prepare('UPDATE folders SET name = ?, path = ? WHERE id = ?');
    const walk = (fid: number, rel: string): void => {
      const f = all.find((r) => Number(r.id) === fid);
      const name = fid === id ? newName : String(f?.name ?? '');
      upd.run(name, rel, fid);
      for (const c of byParent.get(fid) ?? []) {
        walk(Number(c.id), joinRel(rel, String(c.name)));
      }
    };
    walk(id, newRel);
    if (oldRel) {
      const oldDir = resolveRel(oldRel);
      const newDir = resolveRel(newRel);
      const pdfs = db.prepare('SELECT id, filepath FROM pdfs').all() as Row[];
      const pu = db.prepare('UPDATE pdfs SET filepath = ?, updated_time = ? WHERE id = ?');
      for (const p of pdfs) {
        const fp = String(p.filepath);
        if (fp.toLowerCase().startsWith(oldDir.toLowerCase() + path.sep)) {
          const rest = fp.slice(oldDir.length).replace(/^[\\/]+/, '');
          pu.run(path.join(newDir, rest), now(), Number(p.id));
        }
      }
    }
  },

  /** Point a PDF record at a new location (used by library scan for move/rename). */
  updatePdfLocation(id: number, newPath: string, folderId: number | null): void {
    getDb()
      .prepare(
        `UPDATE pdfs SET filepath = ?, filename = ?, folder_id = ?, status = 'ok', updated_time = ? WHERE id = ?`,
      )
      .run(newPath, path.basename(newPath), folderId, now(), id);
  },

  deleteFolder(id: number): void {
    const db = getDb();
    // Collect the whole subtree.
    const ids = new Set<number>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      const all = db.prepare('SELECT id, parent_id FROM folders').all() as Row[];
      for (const r of all) {
        if (!ids.has(Number(r.id)) && r.parent_id != null && ids.has(Number(r.parent_id))) {
          ids.add(Number(r.id));
          changed = true;
        }
      }
    }
    const placeholders = [...ids].map(() => '?').join(',');
    const pdfs = db
      .prepare(`SELECT id FROM pdfs WHERE folder_id IN (${placeholders})`)
      .all(...ids) as Row[];
    for (const p of pdfs) {
      this.deletePdf(Number(p.id));
    }
    const root = this.getFolder(id);
    if (root) {
      const realDir = resolveRel(root.path);
      if (fs.existsSync(realDir)) {
        fs.rmSync(realDir, { recursive: true, force: true });
      }
    }
    db.prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).run(...ids);
  },

  // ---------- PDF ----------
  getPdfs(): PdfRecord[] {
    const db = getDb();
    const list = (
      db.prepare("SELECT * FROM pdfs WHERE scope = 'library' ORDER BY created_time DESC").all() as Row[]
    ).map(mapPdf);
    const rows = db
      .prepare(
        `SELECT pt.pdf_id AS pdf_id, t.* FROM pdf_tags pt
         JOIN tags t ON t.id = pt.tag_id ORDER BY t.name COLLATE NOCASE`,
      )
      .all() as Row[];
    const byPdf = new Map<number, Tag[]>();
    for (const r of rows) {
      const pid = Number(r.pdf_id);
      if (!byPdf.has(pid)) byPdf.set(pid, []);
      byPdf.get(pid)!.push(mapTag(r));
    }
    for (const p of list) p.tags = byPdf.get(p.id) ?? [];
    return list;
  },

  getAllFilepaths(): string[] {
    const db = getDb();
    return (db.prepare("SELECT filepath FROM pdfs WHERE scope = 'library'").all() as Row[]).map((r) =>
      String(r.filepath),
    );
  },

  insertPdf(input: {
    filename: string;
    filepath: string;
    title: string;
    folderId: number | null;
    size: number;
    pageCount: number | null;
    hasOutline?: boolean;
    scope?: 'library' | 'inbox';
  }): PdfRecord {
    const db = getDb();
    const t = now();
    const scope = input.scope ?? 'library';
    const res = db
      .prepare(
        `INSERT INTO pdfs (filename, filepath, title, folder_id, size, page_count, has_outline, scope, created_time, updated_time, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
      )
      .run(
        input.filename,
        input.filepath,
        input.title,
        input.folderId,
        input.size,
        input.pageCount,
        input.hasOutline ? 1 : 0,
        scope,
        t,
        t,
      );
    const created = db.prepare('SELECT * FROM pdfs WHERE id = ?').get(res.lastInsertRowid) as Row;
    return mapPdf(row(created));
  },

  getPdf(id: number): PdfRecord | null {
    const db = getDb();
    const r = db.prepare('SELECT * FROM pdfs WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const pdf = mapPdf(r);
    pdf.tags = this.getTagsForPdf(id);
    return pdf;
  },

  getTagsForPdf(pdfId: number): Tag[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT t.* FROM pdf_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pdf_id = ? ORDER BY t.name COLLATE NOCASE`,
      )
      .all(pdfId) as Row[];
    return rows.map(mapTag);
  },

  updatePdfByPath(filepath: string): void {
    const db = getDb();
    const st = fs.statSync(filepath);
    db.prepare(
      `UPDATE pdfs SET filename = ?, size = ?, updated_time = ?, status = 'ok' WHERE filepath = ?`,
    ).run(path.basename(filepath), st.size, now(), filepath);
  },

  setPdfStatus(id: number, status: 'ok' | 'missing'): void {
    getDb()
      .prepare('UPDATE pdfs SET status = ?, updated_time = ? WHERE id = ?')
      .run(status, now(), id);
  },

  updatePdfTitle(id: number, title: string): void {
    getDb()
      .prepare('UPDATE pdfs SET title = ?, updated_time = ? WHERE id = ?')
      .run(title.trim(), now(), id);
  },

  updatePdfPageCount(id: number, pageCount: number): void {
    getDb()
      .prepare('UPDATE pdfs SET page_count = ?, updated_time = ? WHERE id = ?')
      .run(pageCount, now(), id);
  },

  updatePdfHasOutline(id: number, hasOutline: boolean): void {
    getDb()
      .prepare('UPDATE pdfs SET has_outline = ?, updated_time = ? WHERE id = ?')
      .run(hasOutline ? 1 : 0, now(), id);
  },

  relocatePdf(id: number, newPath: string): PdfRecord {
    const db = getDb();
    const pdf = this.getPdf(id);
    if (!pdf) throw new Error('PDF 记录不存在');
    const dup = db.prepare('SELECT id FROM pdfs WHERE filepath = ? AND id != ?').get(newPath, id);
    if (dup) throw new Error('该文件已存在于知识库中');
    db.prepare(
      `UPDATE pdfs SET filepath = ?, filename = ?, status = 'ok', updated_time = ? WHERE id = ?`,
    ).run(newPath, path.basename(newPath), now(), id);
    return this.getPdf(id)!;
  },

  movePdf(id: number, folderId: number | null): void {
    const db = getDb();
    const pdf = this.getPdf(id);
    if (!pdf) throw new Error('PDF 记录不存在');
    const effectiveFolderId = folderId ?? this.defaultLibraryRootId();
    const targetDir = this.folderFsDir(effectiveFolderId);
    let dest = path.join(targetDir, pdf.filename);
    if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(pdf.filepath)) {
      dest = uniqueFileInDir(targetDir, pdf.filename);
    }
    if (path.resolve(dest) !== path.resolve(pdf.filepath)) {
      if (!fs.existsSync(pdf.filepath)) throw new Error('源文件不存在或已被移动');
      fs.renameSync(pdf.filepath, dest);
    }
    db.prepare(
      `UPDATE pdfs SET folder_id = ?, filepath = ?, filename = ?, status = 'ok', updated_time = ? WHERE id = ?`,
    ).run(effectiveFolderId, dest, path.basename(dest), now(), id);
  },

  deletePdf(id: number): void {
    const db = getDb();
    const pdf = this.getPdf(id);
    const noteRow = db
      .prepare('SELECT note_file, note_dir FROM notes WHERE pdf_id = ?')
      .get(id) as Row | undefined;
    db.prepare('DELETE FROM pdfs WHERE id = ?').run(id);
    // Files inside the managed Library tree are owned by the app; remove them.
    if (pdf) {
      const libraryDir = getLibraryPdfDir();
      const inboxDir = getInboxDir();
      if (isInside(pdf.filepath, libraryDir) || isInside(pdf.filepath, inboxDir)) {
        try {
          if (fs.existsSync(pdf.filepath)) fs.unlinkSync(pdf.filepath);
        } catch {
          /* ignore */
        }
      }
    }
    // Clean up mirror files（笔记文件、旧版 <id>.md、标注镜像）
    if (noteRow && noteRow.note_dir) {
      try {
        const dir = String(noteRow.note_dir);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else if (noteRow && noteRow.note_file) {
      try {
        if (fs.existsSync(String(noteRow.note_file))) fs.unlinkSync(String(noteRow.note_file));
      } catch {
        /* ignore */
      }
    } else {
      const legacy = path.join(getDataDir(), 'notes', `${id}.md`);
      try {
        if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
      } catch {
        /* ignore */
      }
    }
    for (const f of [`${id}.json`]) {
      const p = path.join(getDataDir(), 'annotations', f);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  },

  // ---------- 临时阅读区（Inbox，不进入知识库） ----------
  getInboxPdfs(): PdfRecord[] {
    const db = getDb();
    const list = (
      db.prepare("SELECT * FROM pdfs WHERE scope = 'inbox' ORDER BY created_time DESC").all() as Row[]
    ).map(mapPdf);
    for (const p of list) p.tags = this.getTagsForPdf(p.id);
    return list;
  },

  /** 复制外部 PDF 到临时区并登记（不复制到 Library） */
  addToInbox(sourcePath: string): PdfRecord {
    const inboxDir = getInboxDir();
    fs.mkdirSync(inboxDir, { recursive: true });
    const dest = uniqueFileInDir(inboxDir, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, dest);
    const st = fs.statSync(dest);
    return this.insertPdf({
      filename: path.basename(dest),
      filepath: dest,
      title: path.basename(dest).replace(/\.pdf$/i, ''),
      folderId: null,
      size: st.size,
      pageCount: null,
      scope: 'inbox',
    });
  },

  /** 临时区 -> 知识库：移动文件并转为正式条目 */
  moveInboxToLibrary(id: number, folderId: number | null): PdfRecord {
    const db = getDb();
    const pdf = this.getPdf(id);
    if (!pdf) throw new Error('PDF 记录不存在');
    if (!fs.existsSync(pdf.filepath)) throw new Error('源文件不存在或已被移动');
    const effectiveFolderId = folderId ?? this.defaultLibraryRootId();
    const targetDir = this.folderFsDir(effectiveFolderId);
    let dest = path.join(targetDir, pdf.filename);
    if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(pdf.filepath)) {
      dest = uniqueFileInDir(targetDir, pdf.filename);
    }
    fs.renameSync(pdf.filepath, dest);
    db.prepare(
      `UPDATE pdfs SET scope = 'library', folder_id = ?, filepath = ?, filename = ?, status = 'ok', updated_time = ? WHERE id = ?`,
    ).run(effectiveFolderId, dest, path.basename(dest), now(), id);
    return this.getPdf(id)!;
  },

  /** 清空临时区（删除记录与 Inbox 副本） */
  clearInbox(): number {
    const items = this.getInboxPdfs();
    for (const p of items) this.deletePdf(p.id);
    return items.length;
  },

  // ---------- tags ----------
  getTags(): Tag[] {
    const db = getDb();
    return (db.prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE').all() as Row[]).map(mapTag);
  },

  getTagByName(name: string): Tag | null {
    const db = getDb();
    const r = db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(name.trim()) as Row | undefined;
    return r ? mapTag(r) : null;
  },

  createTag(name: string): Tag {
    const db = getDb();
    const res = db.prepare('INSERT INTO tags (name, created_time) VALUES (?, ?)').run(name.trim(), now());
    const r = db.prepare('SELECT * FROM tags WHERE id = ?').get(res.lastInsertRowid) as Row | undefined;
    return mapTag(row(r));
  },

  addTagToPdf(pdfId: number, name: string): Tag {
    const db = getDb();
    let tag = this.getTagByName(name);
    if (!tag) tag = this.createTag(name);
    db.prepare('INSERT OR IGNORE INTO pdf_tags (pdf_id, tag_id) VALUES (?, ?)').run(pdfId, tag.id);
    return tag;
  },

  removeTagFromPdf(pdfId: number, tagId: number): void {
    getDb().prepare('DELETE FROM pdf_tags WHERE pdf_id = ? AND tag_id = ?').run(pdfId, tagId);
  },

  deleteTag(tagId: number): void {
    getDb().prepare('DELETE FROM tags WHERE id = ?').run(tagId);
  },

  // ---------- notes ----------
  getNote(pdfId: number): NoteRecord | null {
    const db = getDb();
    const r = db.prepare('SELECT * FROM notes WHERE pdf_id = ?').get(pdfId) as Row | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      pdfId: Number(r.pdf_id),
      markdown: String(r.markdown),
      noteFile: r.note_file ? String(r.note_file) : undefined,
      noteDir: r.note_dir ? String(r.note_dir) : undefined,
      updatedAt: String(r.updated_time),
    };
  },

  upsertNote(pdfId: number, markdown: string): NoteRecord {
    const db = getDb();
    const t = now();
    // 首次写笔记时，在 data/notes 下创建「PDF标题 笔记.md」可读镜像文件
    let noteFile: string | null = null;
    let noteDir: string | null = null;
    const pdf = this.getPdf(pdfId);
    const existing = db
      .prepare('SELECT note_file, note_dir FROM notes WHERE pdf_id = ?')
      .get(pdfId) as Row | undefined;
    if (existing?.note_file) {
      noteFile = String(existing.note_file);
      noteDir = existing.note_dir ? String(existing.note_dir) : null;
    } else if (pdf) {
      const folder = noteFolderFor(pdf);
      noteDir = folder.dir;
      noteFile = folder.file;
    }
    db.prepare(
      `INSERT INTO notes (pdf_id, markdown, note_file, note_dir, updated_time) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pdf_id) DO UPDATE SET
         markdown = excluded.markdown,
         note_file = COALESCE(notes.note_file, excluded.note_file),
         note_dir = COALESCE(notes.note_dir, excluded.note_dir),
         updated_time = excluded.updated_time`,
    ).run(pdfId, markdown, noteFile, noteDir, t);
    const row = db
      .prepare('SELECT id, note_file, note_dir FROM notes WHERE pdf_id = ?')
      .get(pdfId) as Row | undefined;
    const file = row && row.note_file ? String(row.note_file) : noteFile;
    const dir = row && row.note_dir ? String(row.note_dir) : noteDir;
    if (file) {
      try {
        fs.writeFileSync(file, markdown, 'utf8');
      } catch {
        /* mirror failure does not affect main flow */
      }
    }
    return {
      id: Number(row?.id ?? 0),
      pdfId,
      markdown,
      noteFile: file ?? undefined,
      noteDir: dir ?? undefined,
      updatedAt: t,
    };
  },

  /**
   * Save a screenshot into this note's own assets/ directory and return the
   * Markdown-relative reference (assets/xxx.png) so it travels with the note
   * folder and survives moves/renames.
   */
  saveNoteImage(pdfId: number, dataUrl: string): string {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('无效的图片数据');
    const pdf = this.getPdf(pdfId);
    if (!pdf) throw new Error('PDF 记录不存在');
    const db = getDb();
    let row = db
      .prepare('SELECT note_file, note_dir FROM notes WHERE pdf_id = ?')
      .get(pdfId) as Row | undefined;
    let noteDir = row?.note_dir ? String(row.note_dir) : null;
    if (!noteDir) {
      const folder = noteFolderFor(pdf);
      noteDir = folder.dir;
      db.prepare(
        `INSERT INTO notes (pdf_id, markdown, note_file, note_dir, updated_time)
         VALUES (?, '', ?, ?, ?)
         ON CONFLICT(pdf_id) DO UPDATE SET
           note_file = COALESCE(notes.note_file, excluded.note_file),
           note_dir = COALESCE(notes.note_dir, excluded.note_dir),
           updated_time = excluded.updated_time`,
      ).run(pdfId, path.join(noteDir, `${path.basename(noteDir)} 笔记.md`), noteDir, now());
    }
    const assetsDir = path.join(noteDir!, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const file = path.join(assetsDir, `${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    return `assets/${path.basename(file)}`;
  },

  // ---------- annotations ----------
  listAnnotations(pdfId: number): AnnotationRecord[] {
    const db = getDb();
    return (
      db
        .prepare('SELECT * FROM annotations WHERE pdf_id = ? ORDER BY page ASC, id ASC')
        .all(pdfId) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      pdfId: Number(r.pdf_id),
      page: Number(r.page),
      content: String(r.content),
      note: String(r.note),
      position: String(r.position),
      color: String(r.color),
      createdAt: String(r.created_time),
      updatedAt: String(r.updated_time),
    }));
  },

  createAnnotation(data: NewAnnotation): AnnotationRecord {
    const db = getDb();
    const t = now();
    const res = db
      .prepare(
        `INSERT INTO annotations (pdf_id, page, content, note, position, color, created_time, updated_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(data.pdfId, data.page, data.content, data.note, data.position, data.color, t, t);
    const all = this.listAnnotations(data.pdfId);
    writeAnnotationMirror(data.pdfId, all);
    const created = db.prepare('SELECT * FROM annotations WHERE id = ?').get(res.lastInsertRowid) as Row;
    return {
      id: Number(created.id),
      pdfId: Number(created.pdf_id),
      page: Number(created.page),
      content: String(created.content),
      note: String(created.note),
      position: String(created.position),
      color: String(created.color),
      createdAt: String(created.created_time),
      updatedAt: String(created.updated_time),
    };
  },

  updateAnnotation(
    id: number,
    patch: Partial<Pick<AnnotationRecord, 'note' | 'color' | 'content' | 'page' | 'position'>>,
  ): void {
    const db = getDb();
    const current = db.prepare('SELECT pdf_id FROM annotations WHERE id = ?').get(id) as Row | undefined;
    if (!current) throw new Error('标注不存在');
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ['note', 'color', 'content', 'page', 'position'] as const) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(patch[key]);
      }
    }
    fields.push('updated_time = ?');
    values.push(now(), id);
    db.prepare(`UPDATE annotations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    writeAnnotationMirror(Number(current.pdf_id), this.listAnnotations(Number(current.pdf_id)));
  },

  deleteAnnotation(id: number): void {
    const db = getDb();
    const current = db.prepare('SELECT pdf_id FROM annotations WHERE id = ?').get(id) as Row | undefined;
    db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
    if (current) writeAnnotationMirror(Number(current.pdf_id), this.listAnnotations(Number(current.pdf_id)));
  },

  // ---------- search ----------
  search(q: string): { pdfs: PdfRecord[]; notes: Array<{ pdf: PdfRecord; snippet: string }>; tags: Tag[] } {
    const db = getDb();
    const like = `%${q}%`;
    const pdfRows = db
      .prepare(
        `SELECT * FROM pdfs WHERE scope = 'library' AND (title LIKE ? OR filename LIKE ?) ORDER BY updated_time DESC LIMIT 50`,
      )
      .all(like, like) as Row[];
    const pdfs = pdfRows.map(mapPdf);
    for (const p of pdfs) p.tags = this.getTagsForPdf(p.id);

    const noteRows = db
      .prepare(
        `SELECT p.*, n.markdown AS markdown FROM notes n JOIN pdfs p ON p.id = n.pdf_id AND p.scope = 'library'
         WHERE n.markdown LIKE ? ORDER BY n.updated_time DESC LIMIT 50`,
      )
      .all(like) as Row[];
    const notes = noteRows.map((r) => {
      const pdf = mapPdf(r);
      pdf.tags = this.getTagsForPdf(pdf.id);
      const md = String(r.markdown);
      const idx = md.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 60);
      const end = Math.min(md.length, idx + q.length + 80);
      const snippet =
        (idx >= 0 ? (start > 0 ? '…' : '') + md.slice(start, end) : md.slice(0, 140)) +
        (end < md.length ? '…' : '');
      return { pdf, snippet };
    });

    const tagRows = db
      .prepare('SELECT * FROM tags WHERE name LIKE ? ORDER BY name COLLATE NOCASE LIMIT 20')
      .all(like) as Row[];
    return { pdfs, notes, tags: tagRows.map(mapTag) };
  },

  parseQuads(position: string): Quad[] {
    try {
      return JSON.parse(position) as Quad[];
    } catch {
      return [];
    }
  },
};
