import fs from 'fs';
import path from 'path';
import type {
  AnnotationRecord,
  Folder,
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
  createdTime: String(r.created_time),
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
  createdAt: String(r.created_time),
  updatedAt: String(r.updated_time),
  status: r.status === 'missing' ? 'missing' : 'ok',
  tags: [],
});

function now(): string {
  return new Date().toISOString();
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

/** Write the note mirror file (also useful for direct browsing / backup). */
function writeNoteMirror(pdfId: number, markdown: string): void {
  try {
    fs.writeFileSync(path.join(getDataDir(), 'notes', `${pdfId}.md`), markdown, 'utf8');
  } catch {
    /* mirror failure does not affect main flow */
  }
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
  // ---------- folders (mirrored to real directories under Library) ----------
  getFolders(): Folder[] {
    const db = getDb();
    return (
      db
        .prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE')
        .all() as Row[]
    ).map(mapFolder);
  },

  getFolder(id: number): Folder | null {
    const db = getDb();
    const r = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Row | undefined;
    return r ? mapFolder(r) : null;
  },

  /** Filesystem directory for a folder (or Library root when folderId is null). */
  folderFsDir(folderId: number | null): string {
    if (folderId == null) {
      fs.mkdirSync(getLibraryPdfDir(), { recursive: true });
      return getLibraryPdfDir();
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
    let acc = '';
    let folder: Folder | null = null;
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const existing = db
        .prepare('SELECT * FROM folders WHERE parent_id IS ? AND name = ?')
        .get(parentId, part) as Row | undefined;
      if (existing) {
        folder = mapFolder(existing);
      } else {
        const res = db
          .prepare('INSERT INTO folders (name, parent_id, path, created_time) VALUES (?, ?, ?, ?)')
          .run(part, parentId, acc, now());
        const r = db.prepare('SELECT * FROM folders WHERE id = ?').get(res.lastInsertRowid) as Row;
        folder = mapFolder(r);
      }
      parentId = folder.id;
    }
    if (!folder) throw new Error('无法创建文件夹');
    return folder;
  },

  createFolder(name: string, parentId: number | null): Folder {
    const db = getDb();
    const n = sanitizeFolderName(name);
    if (parentId != null) {
      const parent = this.getFolder(parentId);
      if (!parent) throw new Error('父文件夹不存在');
    }
    const dup = db
      .prepare('SELECT id FROM folders WHERE parent_id IS ? AND name = ?')
      .get(parentId, n);
    if (dup) throw new Error('同级已存在同名文件夹');

    const parent = parentId != null ? this.getFolder(parentId) : null;
    const rel = joinRel(parent?.path ?? '', n);
    realDirForRel(rel); // create the real directory in Library
    const res = db
      .prepare('INSERT INTO folders (name, parent_id, path, created_time) VALUES (?, ?, ?, ?)')
      .run(n, parentId, rel, now());
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
    if (id === parentId) throw new Error('不能移动到自身');
    // Reject moving into its own subtree (cycle check).
    if (parentId != null) {
      let cur: number | null = parentId;
      const visited = new Set<number>();
      while (cur != null && !visited.has(cur)) {
        if (cur === id) throw new Error('不能移动到自身的子文件夹');
        visited.add(cur);
        const r = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur);
        cur = r ? ((r as Row).parent_id as number | null) : null;
      }
    }
    const parent = parentId != null ? this.getFolder(parentId) : null;
    const newRel = joinRel(parent?.path ?? '', f.name);
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
    scope?: 'library' | 'inbox';
  }): PdfRecord {
    const db = getDb();
    const t = now();
    const scope = input.scope ?? 'library';
    const res = db
      .prepare(
        `INSERT INTO pdfs (filename, filepath, title, folder_id, size, page_count, scope, created_time, updated_time, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
      )
      .run(
        input.filename,
        input.filepath,
        input.title,
        input.folderId,
        input.size,
        input.pageCount,
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
    const targetDir = this.folderFsDir(folderId);
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
    ).run(folderId, dest, path.basename(dest), now(), id);
  },

  deletePdf(id: number): void {
    const db = getDb();
    const pdf = this.getPdf(id);
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
    // Clean up mirror files.
    for (const f of [`${id}.md`, `${id}.json`]) {
      const p = path.join(getDataDir(), f.includes('.md') ? 'notes' : 'annotations', f);
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
    const targetDir = this.folderFsDir(folderId);
    let dest = path.join(targetDir, pdf.filename);
    if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(pdf.filepath)) {
      dest = uniqueFileInDir(targetDir, pdf.filename);
    }
    fs.renameSync(pdf.filepath, dest);
    db.prepare(
      `UPDATE pdfs SET scope = 'library', folder_id = ?, filepath = ?, filename = ?, status = 'ok', updated_time = ? WHERE id = ?`,
    ).run(folderId, dest, path.basename(dest), now(), id);
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
      updatedAt: String(r.updated_time),
    };
  },

  upsertNote(pdfId: number, markdown: string): NoteRecord {
    const db = getDb();
    const t = now();
    db.prepare(
      `INSERT INTO notes (pdf_id, markdown, updated_time) VALUES (?, ?, ?)
       ON CONFLICT(pdf_id) DO UPDATE SET markdown = excluded.markdown, updated_time = excluded.updated_time`,
    ).run(pdfId, markdown, t);
    writeNoteMirror(pdfId, markdown);
    return { id: 0, pdfId, markdown, updatedAt: t };
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
