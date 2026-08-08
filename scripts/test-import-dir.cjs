/* Verify importing a whole folder (recursive) into the library. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const tmp = path.join(app.getPath('temp'), 'pkm-import-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.setPath('documents', tmp);
  const { initDatabase, closeDb } = require('../dist-electron/electron/db/database.js');
  const { importPdfs } = require('../dist-electron/electron/services/import.js');
  const { repository } = require('../dist-electron/electron/db/repository.js');
  initDatabase();

  const outside = path.join(tmp, 'outside-folder');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'a.pdf'), '%PDF-1.4 x');
  fs.mkdirSync(path.join(outside, 'sub'));
  fs.writeFileSync(path.join(outside, 'sub', 'b.pdf'), '%PDF-1.4 y');
  fs.writeFileSync(path.join(outside, 'readme.txt'), 'not a pdf');

  const res = await importPdfs([outside], null);
  const pdfs = repository.getPdfs();
  console.log(JSON.stringify({ res, pdfCount: pdfs.length, names: pdfs.map((p) => p.filename) }));
  closeDb();
  app.exit(res.imported === 2 && pdfs.length === 2 ? 0 : 1);
});
