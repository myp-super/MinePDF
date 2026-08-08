/* Simulate upgrading a v3 database (virtual folders, empty path) and verify
 * that folders become real directories under Library and PDFs are moved in. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

app.whenReady().then(() => {
  const tmp = path.join(app.getPath('temp'), 'pkm-migration-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.setPath('documents', tmp);

  // Build a legacy PDFKnowledgeManager tree exactly like the previous version.
  const legacy = path.join(tmp, 'PDFKnowledgeManager');
  const library = path.join(legacy, 'Library');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'paper.pdf'), '%PDF-1.4 fake');
  const dataDir = path.join(legacy, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'database.sqlite'));
  db.exec(`
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      path TEXT NOT NULL DEFAULT '',
      created_time TEXT NOT NULL
    );
    CREATE TABLE pdfs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      folder_id INTEGER,
      size INTEGER NOT NULL DEFAULT 0,
      page_count INTEGER,
      created_time TEXT NOT NULL,
      updated_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok'
    );
    PRAGMA user_version = 3;
  `);
  db.prepare(
    `INSERT INTO folders (name, parent_id, path, created_time) VALUES ('深度学习', NULL, '', ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT INTO folders (name, parent_id, path, created_time) VALUES ('Transformer', 1, '', ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT INTO pdfs (filename, filepath, title, folder_id, size, page_count, created_time, updated_time, status)
     VALUES ('paper.pdf', ?, 'paper', 1, 9, 1, ?, ?, 'ok')`,
  ).run(path.join(library, 'paper.pdf'), new Date().toISOString(), new Date().toISOString());
  db.close();

  const { initDatabase, getDb, getLibraryRoot, getLibraryPdfDir, closeDb } =
    require('../dist-electron/electron/db/database.js');
  initDatabase();
  const checks = [];
  const root = getLibraryRoot();
  checks.push(['legacyMigrated', fs.existsSync(path.join(tmp, 'MinePDF'))]);
  checks.push(['rootIsMinePDF', root.toLowerCase().endsWith('minepdf')]);
  const folderDeepLearning = path.join(getLibraryPdfDir(), '深度学习');
  const folderTransformer = path.join(getLibraryPdfDir(), '深度学习', 'Transformer');
  checks.push(['dirCreated', fs.existsSync(folderDeepLearning) && fs.existsSync(folderTransformer)]);
  const row = getDb().prepare('SELECT * FROM pdfs').get();
  const moved = row && row.filepath.toLowerCase().includes('深度学习');
  checks.push(['pdfMoved', moved === true]);
  checks.push(['pdfOnDisk', moved === true && fs.existsSync(row.filepath)]);
  checks.push(['oldFileGone', !fs.existsSync(path.join(library, 'paper.pdf'))]);
  const folderRow = getDb().prepare("SELECT path FROM folders WHERE name = '深度学习'").get();
  checks.push(['pathBackfilled', folderRow && folderRow.path === '深度学习']);
  console.log(JSON.stringify(checks, null, 2));
  closeDb();
  const ok = checks.every(([, v]) => v === true);
  app.exit(ok ? 0 : 1);
});
