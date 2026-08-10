import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { SCHEMA_SQL } from './schema';

let db: Database.Database | null = null;

/** Library root: Documents/MinePDF */
export function getLibraryRoot(): string {
  return path.join(app.getPath('documents'), 'MinePDF');
}

/** Data dir: Documents/MinePDF/data */
export function getDataDir(): string {
  return path.join(getLibraryRoot(), 'data');
}

/** PDF library folder: every PDF is managed under Documents/MinePDF/Library */
export function getLibraryPdfDir(): string {
  return path.join(getLibraryRoot(), 'Library');
}

/** 临时阅读区：默认打开/双击预览的 PDF 副本存放目录（不进入知识库） */
export function getInboxDir(): string {
  return path.join(getLibraryRoot(), 'Inbox');
}

function ensureDataDirs(): void {
  for (const sub of ['notes', 'annotations', 'config', 'backups']) {
    fs.mkdirSync(path.join(getDataDir(), sub), { recursive: true });
  }
  fs.mkdirSync(getLibraryPdfDir(), { recursive: true });
  fs.mkdirSync(getInboxDir(), { recursive: true });
}

/** Migrate legacy data dir (PDFKnowledgeManager) to the MinePDF root once. */
function migrateLegacyDir(): void {
  const docs = app.getPath('documents');
  const legacy = path.join(docs, 'PDFKnowledgeManager');
  const mine = getLibraryRoot();
  if (path.resolve(legacy) === path.resolve(mine)) return;
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(mine)) {
      fs.renameSync(legacy, mine);
    }
  } catch {
    /* ignore: user can import again */
  }
}

/**
 * Schema migration: add folders.path (relative path inside Library) to older
 * databases and backfill it from the folder tree. Idempotent.
 */
function migrateSchema(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(folders)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'path')) {
    db.exec(`ALTER TABLE folders ADD COLUMN path TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.some((c) => c.name === 'library_id')) {
    db.exec(`ALTER TABLE folders ADD COLUMN library_id INTEGER`);
  }
  const rows = db
    .prepare('SELECT id, name, parent_id, path FROM folders')
    .all() as Array<Record<string, unknown>>;
  if (rows.some((r) => !String(r.path ?? ''))) {
    const byId = new Map<
      number,
      { name: string; parentId: number | null; path: string }
    >();
    for (const r of rows) {
      byId.set(Number(r.id), {
        name: String(r.name),
        parentId: r.parent_id == null ? null : Number(r.parent_id),
        path: String(r.path ?? ''),
      });
    }
    const resolve = (id: number): string => {
      const f = byId.get(id);
      if (!f) return '';
      if (f.path) return f.path;
      const parent = f.parentId == null ? '' : resolve(f.parentId);
      f.path = parent ? `${parent}/${f.name}` : f.name;
      return f.path;
    };
    const upd = db.prepare('UPDATE folders SET path = ? WHERE id = ?');
    for (const r of rows) {
      upd.run(resolve(Number(r.id)), Number(r.id));
    }
  }
  // pdfs.scope 列（知识库 / 临时区）
  const pdfCols = db.prepare('PRAGMA table_info(pdfs)').all() as Array<{ name: string }>;
  if (!pdfCols.some((c) => c.name === 'scope')) {
    db.exec(`ALTER TABLE pdfs ADD COLUMN scope TEXT NOT NULL DEFAULT 'library'`);
  }
  if (!pdfCols.some((c) => c.name === 'has_outline')) {
    db.exec(`ALTER TABLE pdfs ADD COLUMN has_outline INTEGER NOT NULL DEFAULT 0`);
  }
  // notes.note_file（笔记镜像文件路径，Obsidian 式可读文件名）
  const noteCols = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
  if (!noteCols.some((c) => c.name === 'note_file')) {
    db.exec(`ALTER TABLE notes ADD COLUMN note_file TEXT`);
  }
  if (!noteCols.some((c) => c.name === 'note_dir')) {
    db.exec(`ALTER TABLE notes ADD COLUMN note_dir TEXT`);
  }
  migrateLibraries(db);

  // 手动拖拽排序支持：sort_order 列（仅首次添加时按同级名称回填，之后保留用户排序）
  const libCols = db.prepare('PRAGMA table_info(libraries)').all() as Array<{ name: string }>;
  if (!libCols.some((c) => c.name === 'sort_order')) {
    db.exec(`ALTER TABLE libraries ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    const libs = db
      .prepare('SELECT id, name FROM libraries ORDER BY name COLLATE NOCASE')
      .all() as Array<{ id: number }>;
    const updLib = db.prepare('UPDATE libraries SET sort_order = ? WHERE id = ?');
    libs.forEach((l, i) => updLib.run(i, Number(l.id)));
  }
  const folderCols = db.prepare('PRAGMA table_info(folders)').all() as Array<{ name: string }>;
  if (!folderCols.some((c) => c.name === 'sort_order')) {
    db.exec(`ALTER TABLE folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    const rows = db
      .prepare('SELECT id, parent_id, name FROM folders ORDER BY parent_id, name COLLATE NOCASE')
      .all() as Array<{ id: number; parent_id: number | null }>;
    const updFolder = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?');
    const byParent = new Map<number | null, Array<{ id: number }>>();
    for (const r of rows) {
      const pid = r.parent_id == null ? null : Number(r.parent_id);
      const arr = byParent.get(pid) ?? [];
      arr.push(r);
      byParent.set(pid, arr);
    }
    for (const list of byParent.values()) {
      list.forEach((f, i) => updFolder.run(i, Number(f.id)));
    }
  }
}

/** Next free directory name inside Library root (used for the default library). */
function uniqueLibraryName(base: string): string {
  let name = base;
  let i = 2;
  while (fs.existsSync(path.join(getLibraryPdfDir(), name))) {
    name = `${base} (${i})`;
    i++;
  }
  return name;
}

/**
 * v3.3.0 多知识库迁移：
 * - 新增 libraries 表，每个知识库 = Library 下的一级目录；
 * - 为默认知识库「我的知识库」建立根文件夹行；
 * - 把原有顶层文件夹收进默认知识库（真实目录一并移动），并重映射所有 PDF 路径。
 */
function migrateLibraries(db: Database.Database): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM libraries').get() as { c: number }).c;
  if (count > 0) return;
  const t = new Date().toISOString();
  const libName = uniqueLibraryName('我的知识库');
  const libRes = db.prepare('INSERT INTO libraries (name, created_time) VALUES (?, ?)').run(libName, t);
  const libId = Number(libRes.lastInsertRowid);
  const rootRes = db
    .prepare(
      'INSERT INTO folders (name, parent_id, path, library_id, created_time) VALUES (?, NULL, ?, ?, ?)',
    )
    .run(libName, libName, libId, t);
  const rootId = Number(rootRes.lastInsertRowid);
  const libDir = path.join(getLibraryPdfDir(), libName);
  fs.mkdirSync(libDir, { recursive: true });

  // 顶层文件夹收进默认知识库（移动真实目录 + 更新路径树 + 重映射 PDF）
  const tops = db
    .prepare('SELECT id, name, path FROM folders WHERE parent_id IS NULL AND id != ? ORDER BY id')
    .all(rootId) as Array<{ id: number; name: string; path: string }>;
  const updPath = db.prepare(
    `UPDATE folders SET path = ? || substr(path, ?) WHERE path = ? OR path LIKE ? || '/%'`,
  );
  const updPdf = db.prepare('UPDATE pdfs SET filepath = ?, updated_time = ? WHERE id = ?');
  for (const f of tops) {
    const oldRel = f.path;
    const newRel = `${libName}/${oldRel}`;
    const oldDir = path.join(getLibraryPdfDir(), ...oldRel.split('/'));
    const newDir = path.join(libDir, ...oldRel.split('/'));
    if (fs.existsSync(oldDir) && path.resolve(oldDir) !== path.resolve(newDir)) {
      try {
        fs.renameSync(oldDir, newDir);
      } catch {
        fs.mkdirSync(newDir, { recursive: true });
      }
    }
    db.prepare('UPDATE folders SET parent_id = ?, library_id = ?, path = ? WHERE id = ?').run(
      rootId,
      libId,
      newRel,
      f.id,
    );
    updPath.run(newRel, oldRel.length + 1, oldRel, oldRel);
    const pdfs = db.prepare('SELECT id, filepath FROM pdfs').all() as Array<{
      id: number;
      filepath: string;
    }>;
    for (const p of pdfs) {
      const fp = String(p.filepath);
      if (fp.toLowerCase().startsWith(oldDir.toLowerCase() + path.sep)) {
        const rest = fp.slice(oldDir.length).replace(/^[\\/]+/, '');
        updPdf.run(path.join(newDir, rest), t, Number(p.id));
      }
    }
  }

  // Library 根目录的 PDF 归入默认知识库根文件夹
  const rootPdfs = db
    .prepare("SELECT id, filepath, filename FROM pdfs WHERE folder_id IS NULL AND scope = 'library'")
    .all() as Array<{ id: number; filepath: string; filename: string }>;
  for (const p of rootPdfs) {
    const filename = String(p.filename);
    let dest = path.join(libDir, filename);
    let i = 1;
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    while (fs.existsSync(dest)) {
      dest = path.join(libDir, `${base} (${i})${ext}`);
      i++;
    }
    if (fs.existsSync(String(p.filepath)) && path.resolve(String(p.filepath)) !== path.resolve(dest)) {
      try {
        fs.renameSync(String(p.filepath), dest);
      } catch {
        /* keep original location */
      }
    }
    db.prepare(
      'UPDATE pdfs SET folder_id = ?, filepath = ?, filename = ?, updated_time = ? WHERE id = ?',
    ).run(rootId, dest, path.basename(dest), t, Number(p.id));
  }

  // 兜底：任何仍无知识库的文件夹归入默认库
  db.prepare('UPDATE folders SET library_id = ? WHERE library_id IS NULL').run(libId);
}

/** 去掉非法字符，得到安全的笔记文件夹/文件名 */
function sanitizeNoteName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || '笔记';
}

/** 在 notes 目录下取一个未占用的文件夹名（重名时追加 (2)、(3)…） */
function uniqueNoteDir(notesDir: string, base: string): string {
  let folder = path.join(notesDir, base);
  let i = 2;
  while (fs.existsSync(folder)) {
    folder = path.join(notesDir, `${base} (${i})`);
    i++;
  }
  return folder;
}

/**
 * v1.2.1 及更早版本：笔记是一个平铺的 Markdown 文件
 * （data/notes/<标题> 笔记.md，截图统一放在 data/notes/assets/）。
 * v1.2.2 起改为每篇笔记一个独立文件夹：
 *   data/notes/<标题>/
 *     ├── <标题> 笔记.md
 *     └── assets/<截图.png>
 * 这里把旧文件迁进对应文件夹，并把被引用的截图一并搬入。
 */
function migrateNoteFolders(db: Database.Database): void {
  const notesDir = path.join(getDataDir(), 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  const rows = db
    .prepare(
      `SELECT n.id AS id, n.pdf_id AS pdf_id, n.note_file AS note_file,
              p.title AS title
       FROM notes n LEFT JOIN pdfs p ON p.id = n.pdf_id
       ORDER BY n.id`,
    )
    .all() as Array<{
    id: number;
    pdf_id: number;
    note_file: string | null;
    title: string | null;
  }>;
  const upd = db.prepare(
    'UPDATE notes SET note_file = ?, note_dir = ?, updated_time = ? WHERE id = ?',
  );
  const oldAssetsDir = path.join(notesDir, 'assets');
  for (const r of rows) {
    let source = r.note_file;
    const legacy = path.join(notesDir, `${r.pdf_id}.md`);
    // 已经是新目录结构（notes/<标题>/…）则跳过
    if (source) {
      const rel = path.relative(notesDir, source);
      const parts = rel.split(path.sep);
      if (parts.length >= 2) continue;
    } else if (fs.existsSync(legacy)) {
      source = legacy;
    } else {
      continue;
    }
    if (!fs.existsSync(source)) continue;

    const base = sanitizeNoteName(r.title || '笔记');
    const folder = uniqueNoteDir(notesDir, base);
    fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
    // 旧版 <id>.md 迁入后统一命名为「<标题> 笔记.md」
    const dest =
      path.basename(source) === `${r.pdf_id}.md`
        ? path.join(folder, `${base} 笔记.md`)
        : path.join(folder, path.basename(source));
    try {
      if (path.resolve(source) !== path.resolve(dest)) {
        fs.renameSync(source, dest);
      }
    } catch {
      try {
        fs.copyFileSync(source, dest);
        fs.unlinkSync(source);
      } catch {
        continue;
      }
    }
    // 把 Markdown 中引用的全局截图搬进本笔记自己的 assets/
    try {
      const md = fs.readFileSync(dest, 'utf8');
      const re = /!\[[^\]]*\]\((assets\/[^)\s]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(md))) {
        const from = path.join(notesDir, m[1].replace(/\//g, path.sep));
        const to = path.join(folder, m[1].replace(/\//g, path.sep));
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          try {
            fs.renameSync(from, to);
          } catch {
            try {
              fs.copyFileSync(from, to);
              fs.unlinkSync(from);
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
    upd.run(dest, folder, new Date().toISOString(), r.id);
  }
  // 全局截图目录迁空后可删除
  try {
    if (fs.existsSync(oldAssetsDir) && fs.readdirSync(oldAssetsDir).length === 0) {
      fs.rmdirSync(oldAssetsDir);
    }
  } catch {
    /* ignore */
  }
}

/**
 * After the legacy data dir (PDFKnowledgeManager) is renamed to MinePDF,
 * rewrite stored pdfs.filepath values that still point at the old root.
 */
function remapLegacyPdfPaths(db: Database.Database): void {
  const docs = app.getPath('documents');
  const legacy = path.join(docs, 'PDFKnowledgeManager');
  const mine = getLibraryRoot();
  if (!fs.existsSync(mine) || path.resolve(legacy) === path.resolve(mine)) return;
  const rows = db.prepare('SELECT id, filepath FROM pdfs').all() as Array<{
    id: number;
    filepath: string;
  }>;
  const upd = db.prepare('UPDATE pdfs SET filepath = ? WHERE id = ?');
  for (const r of rows) {
    const rel = path.relative(legacy, r.filepath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      upd.run(path.join(mine, rel), r.id);
    }
  }
}

/** Next free filename inside dir: name.pdf / name (1).pdf / ... */
function uniquePathInDir(dir: string, filename: string): string {
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

/**
 * v1-v3 folders were pure database nodes (virtual). To make the new
 * "folder == real directory" semantics seamless, create the real directory
 * for every folder inside Library and move its PDF files into it.
 * Runs once when upgrading from user_version < 4.
 */
function materializeLegacyFolders(): void {
  if (!db) return;
  const folders = db
    .prepare('SELECT id, path FROM folders ORDER BY id')
    .all() as Array<{ id: number; path: string }>;
  for (const folder of folders) {
    if (!folder.path) continue;
    const parts = folder.path.split('/').filter(Boolean);
    const dir = path.join(getLibraryPdfDir(), ...parts);
    fs.mkdirSync(dir, { recursive: true });
    const pdfs = db
      .prepare(
        `SELECT id, filename, filepath FROM pdfs WHERE folder_id = ? AND status = 'ok'`,
      )
      .all(folder.id) as Array<{ id: number; filename: string; filepath: string }>;
    for (const pdf of pdfs) {
      try {
        if (!fs.existsSync(pdf.filepath)) continue;
        let dest = path.join(dir, pdf.filename);
        if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(pdf.filepath)) {
          dest = uniquePathInDir(dir, pdf.filename);
        }
        if (path.resolve(dest) === path.resolve(pdf.filepath)) continue;
        fs.renameSync(pdf.filepath, dest);
        db.prepare(
          `UPDATE pdfs SET filepath = ?, filename = ?, updated_time = ? WHERE id = ?`,
        ).run(dest, path.basename(dest), new Date().toISOString(), pdf.id);
      } catch {
        /* keep the record; user can relocate it later */
      }
    }
  }
}

/**
 * Initialize the database; if a corrupt file is detected, back it up and rebuild
 * so the app can still boot.
 */
export function initDatabase(): void {
  migrateLegacyDir();
  ensureDataDirs();
  const dbPath = path.join(getDataDir(), 'database.sqlite');
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const verBefore = db.pragma('user_version', { simple: true }) as number;
    db.exec(SCHEMA_SQL);
    migrateSchema(db);
    migrateNoteFolders(db);
    remapLegacyPdfPaths(db);
    if (verBefore < 4) materializeLegacyFolders();
  } catch (err) {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    const backupPath = `${dbPath}.corrupt-${Date.now()}`;
    try {
      if (fs.existsSync(dbPath)) fs.renameSync(dbPath, backupPath);
    } catch {
      /* ignore */
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const verBefore = db.pragma('user_version', { simple: true }) as number;
    db.exec(SCHEMA_SQL);
    migrateSchema(db);
    migrateNoteFolders(db);
    remapLegacyPdfPaths(db);
    if (verBefore < 4) materializeLegacyFolders();
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('database not initialized');
  return db;
}

export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}
