import { app, BrowserWindow, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { closeDb, initDatabase } from './db/database';
import { registerIpc, setMainWindow } from './ipc/register';
import { startLibraryWatcher, stopLibraryWatcher } from './services/libraryWatcher';
import { checkForUpdates } from './services/updater';
import { getSettings } from './services/settings';

const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? '';
const isDev = Boolean(devServerUrl);
const smokeTest = process.env.PKM_SMOKE_TEST === '1';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
/** 双击 PDF / “打开方式”传入的文件路径（临时预览） */
const externalPdfs: string[] = [];

function pdfFromArgv(argv: string[]): string[] {
  return argv.filter((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
}

console.log('[main] boot', { isDev, smokeTest });

// 单实例锁：重复启动时聚焦已有窗口
// 冒烟测试跳过锁，避免残留锁文件导致误判为“第二实例”
const gotLock = smokeTest ? true : app.requestSingleInstanceLock();
console.log('[main] single-instance-lock', gotLock);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已运行时再次用 MinePDF 打开 PDF
    const files = pdfFromArgv(process.argv.slice(1));
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const f of files) mainWindow.webContents.send('app:external-pdf', f);
    } else {
      externalPdfs.push(...files);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.setAppUserModelId('com.minepdf.desktop');

/** 生成一份最小但合法、且带内置书签的一页 PDF（用于冒烟测试与截图） */
function buildTestPdf(): string {
  const objects: Record<number, string> = {};
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n';
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const content = 'BT /F1 18 Tf 72 720 Td (Hello PDF Knowledge Manager 2026) Tj ET\n';
  objects[4] = `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream\nendobj\n`;
  objects[3] =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [8 0 R] >>\nendobj\n';
  objects[5] = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  objects[6] = '6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n';
  objects[7] = '7 0 obj\n<< /Title (Smoke Bookmark) /Parent 6 0 R /Dest [3 0 R /Fit] >>\nendobj\n';
  objects[8] =
    '8 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 700 400 730] /Border [0 0 0] /Dest [3 0 R /XYZ 0 792 null] >>\nendobj\n';

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= 8; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += objects[i];
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 9\n0000000000 65535 f \n';
  for (let i = 1; i <= 8; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b0f1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (isDev) {
    void win.loadURL(`${devServerUrl}/splash.html`);
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/splash.html'));
  }
  win.once('ready-to-show', () => win.show());
  return win;
}

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#0b0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 禁用 Chromium 默认的视觉缩放，Ctrl+滚轮缩放交给阅读器自己处理
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(devServerUrl) && !url.startsWith('file:')) event.preventDefault();
  });
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`[main] did-fail-load code=${code} desc=${desc}`);
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (smokeTest) console.log(`[renderer:${level}] ${message}`);
  });

  win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen-changed', false));

  // 先启动加载、后 await：ready-to-show 可能在 loadURL 期间就已触发，
  // 因此必须在下方监听器注册完成后才等待加载结束，避免事件被错过。
  const indexPath = path.join(__dirname, '../../dist/index.html');
  const loadPromise = isDev
    ? win.loadURL(process.env.PKM_CAPTURE === '1' ? `${devServerUrl}#capture` : devServerUrl)
    : win.loadURL(
        process.env.PKM_CAPTURE === '1'
          ? `${pathToFileURL(indexPath).href}#capture`
          : pathToFileURL(indexPath).href,
      );

  win.once('ready-to-show', () => {
    if (smokeTest) {
      const watchdog = setTimeout(() => {
        console.error('[smoke] watchdog timeout');
        app.exit(2);
      }, 20000);
      // 冒烟测试：验证 preload + React 挂载 + 核心 IPC 全链路
      const testPdfPath = path.join(app.getPath('temp'), 'pkm-smoke-docs', 'smoke-test.pdf');
      const autoScanPdfPath = path.join(
        app.getPath('temp'),
        'pkm-smoke-docs',
        'MinePDF',
        'Library',
        'smoke-autoscan.pdf',
      );
      try {
        fs.mkdirSync(path.dirname(testPdfPath), { recursive: true });
        fs.writeFileSync(testPdfPath, buildTestPdf(), 'latin1');
        fs.mkdirSync(path.dirname(autoScanPdfPath), { recursive: true });
        fs.writeFileSync(autoScanPdfPath, buildTestPdf().replace('2026', '2027'), 'latin1');
      } catch (err) {
        console.error('[smoke] cannot write test pdf', err);
        app.exit(1);
        return;
      }
      const script = `
        (async () => {
          const path = ${JSON.stringify(testPdfPath)};
          const out = { steps: [] };
          const step = async (name, fn) => {
            try { const v = await fn(); out.steps.push([name, true, v]); return v; }
            catch (err) { out.steps.push([name, false, String(err && err.message || err)]); return null; }
          };
          await step('bridge', async () => typeof window.pkm.getSnapshot === 'function');
          await step('updateCheck', async () => (await window.pkm.checkForUpdates()).status === 'disabled');
          const snap = await step('snapshot', () => window.pkm.getSnapshot());
          const folder = await step('createFolder', () => window.pkm.createFolder('冒烟测试', null));
          const imp = await step('import', () => window.pkm.importPdfs([path], folder && folder.id));
          const snap2 = await step('snapshot2', () => window.pkm.getSnapshot());
          const pdf = snap2 && snap2.pdfs.find(p => folder && p.folderId === folder.id);
          out.pdfFound = !!pdf;
          if (pdf) {
            await step('copiedToLibrary', () => pdf.filepath.toLowerCase().indexOf('minepdf') > -1 && path.indexOf(pdf.filepath.toLowerCase()) === -1);
            await step('folderRealDir', () => pdf.filepath.toLowerCase().indexOf('\u5192\u70df\u6d4b\u8bd5') > -1);
            await step('movePdfToRoot', async () => {
              await window.pkm.movePdf(pdf.id, null);
              const snap = await window.pkm.getSnapshot();
              const moved = snap.pdfs.find((p) => p.id === pdf.id);
              return !!moved && moved.filepath.toLowerCase().indexOf('\u5192\u70df\u6d4b\u8bd5') === -1;
            });
            await step('movePdfBack', async () => {
              await window.pkm.movePdf(pdf.id, folder.id);
              const snap = await window.pkm.getSnapshot();
              const back = snap.pdfs.find((p) => p.id === pdf.id);
              return !!back && back.filepath.toLowerCase().indexOf('\u5192\u70df\u6d4b\u8bd5') > -1;
            });
            await step('read', async () => (await window.pkm.readPdf(pdf.id)).byteLength);
            const inboxItem = await step('inboxAdd', () => window.pkm.inboxAdd(path));
            if (inboxItem) {
              await step('inboxList', async () =>
                (await window.pkm.inboxList()).some((p) => p.id === inboxItem.id),
              );
              const moved = await step('inboxToLibrary', () => window.pkm.inboxToLibrary(inboxItem.id, null));
              if (moved) {
                await step('inboxMovedToLibrary', () => moved.filepath.toLowerCase().indexOf('library') > -1);
                await step('deleteInboxMoved', () => window.pkm.deletePdf(moved.id));
              }
              const inbox2 = await step('inboxAdd2', () => window.pkm.inboxAdd(path));
              if (inbox2) await step('inboxRemove', () => window.pkm.inboxRemove(inbox2.id));
              await step('inboxClear', () => window.pkm.inboxClear());
            }
            await step('saveNote', () => window.pkm.saveNote(pdf.id, '# 测试笔记\\n$$E=mc^2$$'));
            const ann = await step('createAnnotation', () => window.pkm.createAnnotation({ pdfId: pdf.id, page: 1, content: '测试高亮', note: '备注', position: JSON.stringify([{x:10,y:20,w:100,h:12}]), color: '#fde047' }));
            if (ann) {
              await step('updateAnnotation', () => window.pkm.updateAnnotation(ann.id, { note: '更新的备注' }));
              await step('listAnnotations', () => window.pkm.listAnnotations(pdf.id));
              await step('deleteAnnotation', () => window.pkm.deleteAnnotation(ann.id));
            }
            const tag = await step('addTag', () => window.pkm.addTag(pdf.id, '冒烟标签'));
            if (tag) await step('deleteTag', () => window.pkm.deleteTag(tag.id));
            await step('search', () => window.pkm.search('Hello'));
            const scan = await step('scanLibrary', () => window.pkm.scanLibrary());
            const snap3 = await step('snapshot3', () => window.pkm.getSnapshot());
            await step('autoscanFound', () => !!snap3 && snap3.pdfs.some(p => p.filename === 'smoke-autoscan.pdf'));
            await step('deletePdf', () => window.pkm.deletePdf(pdf.id));
            const autoPdf = snap3 && snap3.pdfs.find(p => p.filename === 'smoke-autoscan.pdf');
            if (autoPdf) await step('deleteAutoPdf', () => window.pkm.deletePdf(autoPdf.id));
          }
          if (folder) await step('deleteFolder', () => window.pkm.deleteFolder(folder.id));
          return JSON.stringify(out);
        })()
      `;
      void win.webContents
        .executeJavaScript(script)
        .then((result) => {
          clearTimeout(watchdog);
          console.log('[smoke] result', result);
          try {
            fs.writeFileSync(
              path.join(app.getPath('temp'), 'pkm-smoke-result.json'),
              String(result),
              'utf8',
            );
          } catch {
            /* ignore */
          }
          let failed = typeof result !== 'string' || result.includes('"error"');
          try {
            const parsed = JSON.parse(result);
            failed = parsed.steps.some((s: [string, boolean, unknown]) => s[1] !== true);
          } catch {
            failed = true;
          }
          if (process.env.PKM_CAPTURE === '1') {
            // 交付截图：离屏显示主窗口并捕获
            void (async () => {
              try {
                win.setPosition(-3000, 0);
                win.show();
                win.webContents.setBackgroundThrottling(false);
                // 重新导入测试 PDF 并打开，验证带书签的阅读视图
                await win.webContents.executeJavaScript(`
                  (async () => {
                    if (typeof window.__pkmOpenPdf !== 'function') return false;
                    const path = ${JSON.stringify(testPdfPath)};
                    await window.pkm.importPdfs([path], null);
                    const snap = await window.pkm.getSnapshot();
                    const pdf = snap.pdfs.find(p => p.filename === 'smoke-test.pdf');
                    if (!pdf) return false;
                    await window.pkm.createAnnotation({ pdfId: pdf.id, page: 1, content: 'Hello PDF Knowledge Manager 2026', note: 'highlight geometry check', position: JSON.stringify([{x:72,y:702,w:350,h:18}]), color: '#fde047' });
                    window.__pkmOpenPdf(pdf.id);
                    return true;
                  })()
                `);
                await new Promise((r) => setTimeout(r, 3600));
                const linkDiag = await win.webContents.executeJavaScript(`
                  (() => {
                    const ann = document.querySelector('.annotationLayer');
                    if (!ann) return { layer: false };
                    const links = ann.querySelectorAll('a');
                    const clickable = [...links].filter((a) => a.onclick || a.getAttribute('data-internal-link') !== null || (a.getAttribute('href') || '').length > 0);
                    return { layer: true, sections: ann.querySelectorAll('section').length, links: links.length, clickable: clickable.length };
                  })()
                `);
                console.log('[capture] linkDiag', JSON.stringify(linkDiag));
                await win.webContents.executeJavaScript(`
                  (() => {
                    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '书签');
                    if (btn) btn.click();
                    const outlineItems = [...document.querySelectorAll('aside button')].filter(b => (b.className || '').includes('py-[3px]')).length;
                    return { tabClicked: !!btn, outlineItems };
                  })()
                `);
                const outlineDiag = await win.webContents.executeJavaScript(`
                  (() => {
                    const items = [...document.querySelectorAll('aside button')].filter(b => (b.className || '').includes('py-[3px]'));
                    return { count: items.length, firstTitle: items[0] ? items[0].getAttribute('title') : null };
                  })()
                `);
                console.log('[capture] outlineDiag', JSON.stringify(outlineDiag));
                const renderDiag = await win.webContents.executeJavaScript(`
                  (() => {
                    const canvas = document.querySelector('.pdf-page-sheet canvas');
                    if (!canvas) return { canvas: false };
                    const cssW = parseFloat(canvas.style.width) || canvas.getBoundingClientRect().width;
                    return { backingWidth: canvas.width, cssWidth: Math.round(cssW), ratio: +(canvas.width / cssW).toFixed(2) };
                  })()
                `);
                console.log('[capture] renderDiag', JSON.stringify(renderDiag));
                const resizeDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const h = document.querySelector('[data-resize="sidebar"]');
                    if (!h) return { handle: false };
                    const before = document.querySelector('aside').getBoundingClientRect().width;
                    h.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, bubbles: true }));
                    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, bubbles: true }));
                    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    await new Promise((r) => setTimeout(r, 150));
                    const after = document.querySelector('aside').getBoundingClientRect().width;
                    return { handle: true, before: Math.round(before), after: Math.round(after), grew: after > before };
                  })()
                `);
                console.log('[capture] resizeDiag', JSON.stringify(resizeDiag));
                const sidebarDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const collapseBtn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title') || '').includes('折叠侧边栏'));
                    if (!collapseBtn) return { collapseBtn: false };
                    const before = document.querySelector('aside').getBoundingClientRect().width;
                    collapseBtn.click();
                    await new Promise((r) => setTimeout(r, 150));
                    const collapsedW = document.querySelector('aside').getBoundingClientRect().width;
                    const expandBtn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title') || '').includes('展开侧边栏'));
                    if (expandBtn) expandBtn.click();
                    await new Promise((r) => setTimeout(r, 150));
                    const restoredW = document.querySelector('aside').getBoundingClientRect().width;
                    return { collapseBtn: true, before: Math.round(before), collapsedW: Math.round(collapsedW), restoredW: Math.round(restoredW), restored: Math.abs(restoredW - before) < 5 };
                  })()
                `);
                console.log('[capture] sidebarDiag', JSON.stringify(sidebarDiag));
                await new Promise((r) => setTimeout(r, 600));
                const image = await win.webContents.capturePage();
                const outDir = path.join(process.cwd(), 'docs');
                fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(path.join(outDir, 'app-screenshot.png'), image.toPNG());
                console.log('[capture] main window saved to docs/app-screenshot.png');
                // 文档切换验证：A -> B -> A，每步都应有实际渲染内容
                try {
                  fs.mkdirSync(path.dirname(autoScanPdfPath), { recursive: true });
                  fs.writeFileSync(autoScanPdfPath, buildTestPdf().replace('2026', '2027'), 'latin1');
                } catch {
                  /* ignore */
                }
                const switchDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const autoPath = ${JSON.stringify(autoScanPdfPath)};
                    await window.pkm.importPdfs([autoPath], null);
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    const b = snap.pdfs.find((p) => p.filename === 'smoke-autoscan.pdf');
                    if (!a || !b) return { files: { a: !!a, b: !!b } };
                    const state = () => {
                      const c = document.querySelector('.pdf-page-sheet canvas');
                      return { canvas: c ? c.width : 0, textSpans: document.querySelectorAll('.textLayer span').length };
                    };
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 2000));
                    const s1 = state();
                    window.__pkmOpenPdf(b.id);
                    await new Promise((r) => setTimeout(r, 2000));
                    const s2 = state();
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 2000));
                    const s3 = state();
                    return {
                      s1, s2, s3,
                      ok: s1.canvas > 0 && s1.textSpans > 0 && s2.canvas > 0 && s2.textSpans > 0 && s3.canvas > 0 && s3.textSpans > 0,
                    };
                  })()
                `);
                console.log('[capture] switchDiag', JSON.stringify(switchDiag));
                // 多选验证：Ctrl+点击两个 PDF，检查操作栏与批量删除确认
                const multiDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    await window.pkm.importPdfs([${JSON.stringify(testPdfPath)}], null);
                    await new Promise((r) => setTimeout(r, 900));
                    const pdfRows = [...document.querySelectorAll('aside [role="treeitem"]')].filter(
                      (el) => el.querySelector('.lucide-file-text'),
                    );
                    if (pdfRows.length < 2) return { rows: pdfRows.length };
                    pdfRows[0].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
                    pdfRows[1].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
                    await new Promise((r) => setTimeout(r, 150));
                    const noBar = !document.body.textContent.includes('已选 2 项');
                    const noTopDelete = ![...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('删除所选'));
                    pdfRows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
                    await new Promise((r) => setTimeout(r, 150));
                    const menuDelete = document.body.textContent.includes('删除所选');
                    const menuMove = document.body.textContent.includes('移动到…');
                    const cancel = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '取消');
                    if (cancel) cancel.click();
                    return { rows: pdfRows.length, noBar, noTopDelete, menuDelete, menuMove };
                  })()
                `);
                console.log('[capture] multiDiag', JSON.stringify(multiDiag));
                const inboxDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const item = await window.pkm.inboxAdd(${JSON.stringify(testPdfPath)});
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    await new Promise((r) => setTimeout(r, 400));
                    const rows = [...document.querySelectorAll('aside [role="treeitem"]')];
                    const inboxRow = rows.find((el) => (el.getAttribute('title') || '').includes('Inbox'));
                    if (inboxRow) inboxRow.click();
                    await new Promise((r) => setTimeout(r, 2000));
                    const c = document.querySelector('.pdf-page-sheet canvas');
                    const panel = document.querySelector('[data-inbox-panel]');
                    const bar = [...document.querySelectorAll('div')].find((el) => (el.className || '').includes('cursor-row-resize'));
                    let resized = false;
                    if (panel && bar) {
                      const before = panel.getBoundingClientRect().height;
                      bar.dispatchEvent(new MouseEvent('mousedown', { clientY: 0, bubbles: true }));
                      window.dispatchEvent(new MouseEvent('mousemove', { clientY: -120, bubbles: true }));
                      window.dispatchEvent(new MouseEvent('mouseup', { clientY: -120, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 120));
                      const after = panel.getBoundingClientRect().height;
                      resized = after > before;
                    }
                    return { added: !!item, inboxRow: !!inboxRow, openedCanvas: c ? c.width : 0, resized };
                  })()
                `);
                console.log('[capture] inboxDiag', JSON.stringify(inboxDiag));
              } catch (err) {
                console.error('[capture] failed', err);
              }
              app.exit(failed ? 1 : 0);
            })();
            return;
          }
          app.exit(failed ? 1 : 0);
        })
        .catch((err) => {
          clearTimeout(watchdog);
          console.error('[smoke] failed', err);
          app.exit(1);
        });
    } else {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      splashWindow = null;
      win.show();
      win.focus();
    }
  });

  await loadPromise;

  mainWindow = win;
  setMainWindow(win);
  return win;
}

app.whenReady().then(async () => {
  console.log('[main] whenReady');
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection', reason);
  });
  if (smokeTest) {
    // 冒烟测试使用临时文档目录，避免污染用户真实知识库
    const smokeDocs = path.join(app.getPath('temp'), 'pkm-smoke-docs');
    fs.rmSync(smokeDocs, { recursive: true, force: true });
    app.setPath('documents', smokeDocs);
  }
  registerIpc();
  console.log('[main] ipc registered');
  initDatabase();
  console.log('[main] database initialized');
  startLibraryWatcher(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:changed');
    }
  });
  console.log('[main] library watcher started');

  if (!smokeTest) splashWindow = createSplash();
  await createMainWindow();
  console.log('[main] main window created');

  // 启动时若由系统以默认 PDF 应用唤起，把文件交给渲染进程做临时预览
  if (!smokeTest) {
    externalPdfs.push(...pdfFromArgv(process.argv.slice(1)));
    setTimeout(() => {
      for (const f of externalPdfs.splice(0)) {
        mainWindow?.webContents.send('app:external-pdf', f);
      }
    }, 1500);
  }

  // 启动后延迟自动检查更新（设置里开启且配置了更新源时）
  if (!smokeTest && getSettings().updateAutoCheck) {
    setTimeout(() => {
      void checkForUpdates().then((res) => {
        if (res.status === 'available' && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:available', res);
        }
      });
    }, 8000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopLibraryWatcher();
  closeDb();
});

// 供 window 控制 IPC 使用
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
