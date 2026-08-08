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

function ensureDataDirs(): void {
  for (const sub of ['notes', 'annotations', 'config', 'backups']) {
    fs.mkdirSync(path.join(getDataDir(), sub), { recursive: true });
  }
  fs.mkdirSync(getLibraryPdfDir(), { recursive: true });
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
