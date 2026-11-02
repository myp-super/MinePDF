/* Verify whole-folder import: directory structure is preserved and each PDF
 * lands in the matching library folder. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const tmp = path.join(app.getPath('temp'), 'pkm-import-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.setPath('documents', tmp);
  const { initDatabase, closeDb } =
    require('../dist-electron/electron/db/database.js');
  const { importPdfs } = require('../dist-electron/electron/services/import.js');
  const { repository } = require('../dist-electron/electron/db/repository.js');
  initDatabase();
  const outside = path.join(tmp, 'papers');
  fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'empty', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'documents'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'a.pdf'), '%PDF-1.4 x');
  fs.writeFileSync(path.join(outside, 'sub', 'b.pdf'), '%PDF-1.4 y');
  fs.writeFileSync(path.join(outside, 'documents', 'readme.txt'), 'not a pdf');

  const target = repository.createFolder('drop-here', repository.defaultLibraryRootId());
  const targetDir = repository.folderFsDir(target.id);
  const importedRootPath = `${target.path}/papers`;
  const res = await importPdfs([outside], target.id);
  const checks = [];
  checks.push(['imported', res.imported === 2]);
  checks.push(['dirCopied', fs.existsSync(path.join(targetDir, 'papers', 'a.pdf'))]);
  checks.push(['subCopied', fs.existsSync(path.join(targetDir, 'papers', 'sub', 'b.pdf'))]);
  checks.push(['txtCopied', fs.existsSync(path.join(targetDir, 'papers', 'documents', 'readme.txt'))]);
  const fRoot = repository.getFolders().find((f) => f.path === importedRootPath);
  const fSub = repository.getFolders().find((f) => f.path === `${importedRootPath}/sub`);
  checks.push(['folderRoot', !!fRoot]);
  checks.push(['folderSub', !!fSub]);
  checks.push([
    'emptyNestedFolder',
    repository.getFolders().some((f) => f.path === `${importedRootPath}/empty/nested`),
  ]);
  checks.push([
    'nonPdfFolder',
    repository.getFolders().some((f) => f.path === `${importedRootPath}/documents`),
  ]);
  const a = repository.getPdfs().find((p) => p.filename === 'a.pdf');
  const b = repository.getPdfs().find((p) => p.filename === 'b.pdf');
  checks.push(['aInRoot', !!a && a.folderId === fRoot.id]);
  checks.push(['bInSub', !!b && b.folderId === fSub.id]);
  checks.push(['txtIgnored', repository.getPdfs().length === 2]);

  console.log(JSON.stringify({ res, checks }, null, 2));
  closeDb();
  app.exit(checks.every(([, v]) => v === true) ? 0 : 1);
});
