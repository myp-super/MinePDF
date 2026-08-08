// 启动页截图工具：加载 dist/splash.html，离屏渲染后保存 PNG。
// 用法: electron scripts/capture-splash.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 460,
    height: 320,
    show: true,
    frame: false,
    backgroundColor: '#0b0f1a',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setPosition(-2000, 0); // 离屏渲染，避免打扰用户
  win.webContents.setBackgroundThrottling(false);
  await win.loadFile(path.join(__dirname, '../dist/splash.html'));
  await new Promise((r) => setTimeout(r, 1600));
  const image = await win.webContents.capturePage();
  const outDir = path.join(__dirname, '../docs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'splash-screenshot.png'), image.toPNG());
  console.log('[capture] splash saved to docs/splash-screenshot.png');
  app.exit(0);
});
