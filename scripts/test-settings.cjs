/* Verify that an empty updateUrl in old config falls back to the built-in feed. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const tmp = path.join(app.getPath('temp'), 'pkm-settings-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.setPath('documents', tmp);
  const { initDatabase, getDataDir, closeDb } =
    require('../dist-electron/electron/db/database.js');
  const { getSettings } = require('../dist-electron/electron/services/settings.js');
  initDatabase();
  const cfg = path.join(getDataDir(), 'config', 'settings.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ theme: 'dark', updateUrl: '' }), 'utf8');
  const s = getSettings();
  const expected = 'https://myp-super.github.io/MinePDF/update.json';
  console.log(JSON.stringify({ got: s.updateUrl, ok: s.updateUrl === expected }));
  closeDb();
  app.exit(s.updateUrl === expected ? 0 : 1);
});
