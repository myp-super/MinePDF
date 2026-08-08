/* Verify strict two-way sync: local folder/file create, move, rename in the
 * Library directory are mirrored without duplicates. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  initDatabase,
  getLibraryPdfDir,
  closeDb,
} = require('../dist-electron/electron/db/database.js');
const { repository } = require('../dist-electron/electron/db/repository.js');
const { scanLibrary } = require('../dist-electron/electron/services/libraryWatcher.js');

app.whenReady().then(async () => {
  const tmp = path.join(app.getPath('temp'), 'pkm-sync-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.setPath('documents', tmp);
  initDatabase();
  const lib = getLibraryPdfDir();

  const mk = (rel, content) => {
    const p = path.join(lib, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };

  const checks = [];
  const alphaPath = mk('alpha.pdf', 'A');
  mk('Deep/beta.pdf', 'B');
  await scanLibrary();
  let pdfs = repository.getPdfs();
  const alpha = pdfs.find((p) => p.filename === 'alpha.pdf');
  const beta = pdfs.find((p) => p.filename === 'beta.pdf');
  const deep = repository.getFolders().find((f) => f.name === 'Deep');
  checks.push(['seedCount', pdfs.length === 2]);
  checks.push(['folderCreated', !!deep && deep.path === 'Deep']);
  checks.push(['subfileInFolder', !!beta && beta.folderId === deep.id]);

  // A: move a root file into an existing folder
  fs.renameSync(alphaPath, path.join(lib, 'Deep', 'alpha.pdf'));
  await scanLibrary();
  pdfs = repository.getPdfs();
  const alpha2 = pdfs.find((p) => p.id === alpha.id);
  checks.push([
    'moveSameId',
    !!alpha2 &&
      alpha2.filepath.toLowerCase().includes('deep') &&
      alpha2.folderId === deep.id,
  ]);
  checks.push(['moveNoDup', pdfs.length === 2]);

  // B: rename a folder in Explorer
  fs.renameSync(path.join(lib, 'Deep'), path.join(lib, 'ControlTheory'));
  await scanLibrary();
  const folders = repository.getFolders();
  const renamed = folders.find((f) => f.id === deep.id);
  checks.push([
    'folderRenamed',
    !!renamed && renamed.name === 'ControlTheory' && renamed.path === 'ControlTheory',
  ]);
  checks.push(['folderNoGhost', folders.filter((f) => f.name === 'Deep').length === 0]);
  const beta3 = repository.getPdfs().find((p) => p.id === beta.id);
  checks.push([
    'filePathRemapped',
    !!beta3 && beta3.filepath.toLowerCase().includes('controltheory'),
  ]);

  // C: rename a file in Explorer
  fs.renameSync(
    path.join(lib, 'ControlTheory', 'beta.pdf'),
    path.join(lib, 'ControlTheory', 'notes.pdf'),
  );
  await scanLibrary();
  const beta4 = repository.getPdfs().find((p) => p.id === beta.id);
  checks.push([
    'fileRenamed',
    !!beta4 && beta4.filename === 'notes.pdf' && beta4.filepath.toLowerCase().endsWith('notes.pdf'),
  ]);

  // D: add a new file inside a folder
  mk('ControlTheory/gamma.pdf', 'G');
  await scanLibrary();
  const gamma = repository.getPdfs().find((p) => p.filename === 'gamma.pdf');
  const ct = repository.getFolders().find((f) => f.name === 'ControlTheory');
  checks.push(['newFileInFolder', !!gamma && gamma.folderId === ct.id]);

  // E: delete a folder in Explorer -> records are kept but marked missing
  // (safety: notes/annotations are never silently dropped)
  fs.rmSync(path.join(lib, 'ControlTheory'), { recursive: true, force: true });
  await scanLibrary();
  checks.push([
    'folderKeptAsGhost',
    repository.getFolders().filter((f) => f.name === 'ControlTheory').length === 1,
  ]);
  checks.push([
    'filesMarkedMissing',
    repository.getPdfs().every((p) => p.status === 'missing'),
  ]);

  // F: in-app folder rename must update DB name + path AND the real directory
  const appFolder = repository.createFolder('AppFolder', null);
  const sub = repository.createFolder('Sub', appFolder.id);
  const appFile = mk('AppFolder/aaa.pdf', 'X');
  await scanLibrary();
  const aaa = repository.getPdfs().find((p) => p.filename === 'aaa.pdf');
  repository.renameFolder(appFolder.id, 'AppRenamed');
  const af = repository.getFolders().find((f) => f.id === appFolder.id);
  const subAfter = repository.getFolders().find((f) => f.id === sub.id);
  checks.push(['appRenameLocal', fs.existsSync(path.join(lib, 'AppRenamed'))]);
  checks.push(['appRenameDb', !!af && af.name === 'AppRenamed' && af.path === 'AppRenamed']);
  checks.push(['appRenameSubtree', !!subAfter && subAfter.path === 'AppRenamed/Sub']);
  const aaa2 = repository.getPdfs().find((p) => p.id === aaa.id);
  checks.push([
    'appRenamePdf',
    !!aaa2 && aaa2.filepath.toLowerCase().includes('apprenamed'),
  ]);

  // G: in-app folder move keeps subtree paths correct
  const top = repository.createFolder('Top', null);
  repository.moveFolder(appFolder.id, top.id);
  const af2 = repository.getFolders().find((f) => f.id === appFolder.id);
  const sub2 = repository.getFolders().find((f) => f.id === sub.id);
  checks.push([
    'appMoveSubtree',
    !!af2 && af2.path === 'Top/AppRenamed' && !!sub2 && sub2.path === 'Top/AppRenamed/Sub',
  ]);
  checks.push([
    'appMoveLocal',
    fs.existsSync(path.join(lib, 'Top', 'AppRenamed', 'Sub')),
  ]);

  console.log(JSON.stringify(checks, null, 2));
  closeDb();
  const ok = checks.every(([, v]) => v === true);
  app.exit(ok ? 0 : 1);
});
