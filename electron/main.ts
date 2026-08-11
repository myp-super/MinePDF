import { app, BrowserWindow, screen, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { closeDb, initDatabase } from './db/database';
import {
  ensureNoForcedPdfAssociation,
  onRendererReady,
  registerIpc,
  setMainWindow,
} from './ipc/register';
import { startLibraryWatcher, stopLibraryWatcher } from './services/libraryWatcher';
import { checkForUpdates } from './services/updater';
import { getSettings } from './services/settings';
import { pdfiumShutdown } from './services/pdfium';

const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? '';
const isDev = Boolean(devServerUrl);
const smokeTest = process.env.PKM_SMOKE_TEST === '1';
const bootT0 = Date.now();
const elapsed = (label: string): void => {
  console.log(`[boot:${label}] ${Date.now() - bootT0}ms`);
};

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
/** 双击 PDF / “打开方式”传入的文件路径（临时预览） */
const externalPdfs: string[] = [];
/** 渲染进程是否已就绪（订阅了 app:external-pdf），就绪后才派发外部文件 */
let rendererReady = false;

onRendererReady(() => {
  rendererReady = true;
  flushExternalPdfs();
});

/** 把待处理的系统打开请求派发给渲染进程（未就绪则保留缓冲） */
function flushExternalPdfs(): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  for (const f of externalPdfs.splice(0)) {
    mainWindow.webContents.send('app:external-pdf', f);
  }
}

function pdfFromArgv(argv: string[]): string[] {
  return argv.filter((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
}

console.log('[main] boot', { isDev, smokeTest });
elapsed('module-loaded');

// 单实例锁：重复启动时聚焦已有窗口
// 冒烟测试跳过锁，避免残留锁文件导致误判为“第二实例”
const gotLock = smokeTest ? true : app.requestSingleInstanceLock();
console.log('[main] single-instance-lock', gotLock);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // 已运行时再次用 MinePDF 打开 PDF。
    // 注意：必须用事件参数 argv（新进程的命令行），不能用 process.argv（本进程的）。
    const files = pdfFromArgv(argv.slice(1));
    if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
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

/**
 * 生成一份最小但合法的一页 PDF（用于冒烟测试与截图）。
 * noOutline=true 时不带内置书签，用于验证“无书签默认打开笔记页”。
 */
function buildTestPdf(noOutline = false): string {
  const objects: Record<number, string> = {};
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R${noOutline ? '' : ' /Outlines 6 0 R'} >>\nendobj\n`;
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  // 三个独立文本段，让 PDF.js 文本层生成多个 span，便于验证高亮合并
  const content =
    'BT /F1 18 Tf 72 720 Td (Hello ) Tj /F1 14 Tf (PDF ) Tj /F1 18 Tf (Knowledge Manager 2026) Tj ET\n';
  objects[4] = `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream\nendobj\n`;
  objects[3] =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [8 0 R] >>\nendobj\n';
  objects[5] = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  if (!noOutline) {
    objects[6] = '6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n';
    objects[7] = '7 0 obj\n<< /Title (Smoke Bookmark) /Parent 6 0 R /Dest [3 0 R /Fit] >>\nendobj\n';
  }
  objects[8] =
    '8 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 700 400 730] /Border [0 0 0] /Dest [3 0 R /XYZ 0 792 null] >>\nendobj\n';

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  const ids = Object.keys(objects)
    .map(Number)
    .sort((a, b) => a - b);
  for (const i of ids) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += objects[i];
  }
  const maxId = Math.max(...ids);
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) {
    pdf += offsets[i] != null ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/** 两页链接测试 PDF：页内交叉引用 + 外部网址 + 邮箱 */
function buildLinkTestPdf(): string {
  const objects: Record<number, string> = {};
  // 命名目标（named destination）：论文交叉引用常见形式，走 pdf.js getDestination
  objects[1] =
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(Page2Dest) [4 0 R /Fit]] >> >> >>\nendobj\n';
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n';
  const c1 = 'BT /F1 18 Tf 72 720 Td (Page 1 - internal link below) Tj ET\n';
  const c2 = 'BT /F1 18 Tf 72 720 Td (Page 2 - back link below) Tj ET\n';
  objects[5] = `5 0 obj\n<< /Length ${Buffer.byteLength(c1, 'latin1')} >>\nstream\n${c1}endstream\nendobj\n`;
  objects[6] = `6 0 obj\n<< /Length ${Buffer.byteLength(c2, 'latin1')} >>\nstream\n${c2}endstream\nendobj\n`;
  objects[7] = '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  objects[8] =
    '8 0 obj\n[ << /Type /Annot /Subtype /Link /Rect [72 680 340 710] /Border [0 0 0] /Dest (Page2Dest) >>\n' +
    '  << /Type /Annot /Subtype /Link /Rect [72 630 340 660] /Border [0 0 0] /Dest [4 0 R /Fit] >>\n' +
    '  << /Type /Annot /Subtype /Link /Rect [72 580 340 610] /Border [0 0 0] /A << /S /URI /URI (https://example.com) >> >>\n' +
    '  << /Type /Annot /Subtype /Link /Rect [72 530 340 560] /Border [0 0 0] /A << /S /URI /URI (mailto:test@example.com) >> >> ]\nendobj\n';
  objects[9] =
    '9 0 obj\n[ << /Type /Annot /Subtype /Link /Rect [72 680 340 710] /Border [0 0 0] /Dest [3 0 R /Fit] >> ]\nendobj\n';
  objects[3] =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> /Annots 8 0 R >>\nendobj\n';
  objects[4] =
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> /Annots 9 0 R >>\nendobj\n';

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  const ids = Object.keys(objects)
    .map(Number)
    .sort((a, b) => a - b);
  for (const i of ids) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += objects[i];
  }
  const maxId = Math.max(...ids);
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) {
    pdf += offsets[i] != null ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/** 生成 N 页测试 PDF（性能与会话诊断用，自包含不依赖用户文件） */
function buildMultiPageTestPdf(pages: number): string {
  const objects: Record<number, string> = {};
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`;
  const fontId = pages + 3;
  objects[fontId] = `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;
  for (let i = 0; i < pages; i++) {
    const pageId = 3 + i;
    const contentId = pages + 4 + i;
    const content = `BT /F1 18 Tf 72 720 Td (Page ${i + 1} - MinePDF perf test) Tj ET\n`;
    objects[pageId] =
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`;
    objects[contentId] =
      `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream\nendobj\n`;
  }
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  const ids = Object.keys(objects)
    .map(Number)
    .sort((a, b) => a - b);
  for (const i of ids) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += objects[i];
  }
  const maxId = Math.max(...ids);
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) {
    pdf += offsets[i] != null ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
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

  // 无边框窗口（frame:false）在 Windows 上最大化/还原/拖动缩放后，
  // 偶发“内容整体上移、顶部标题栏被吞”的错位问题。
  // 根因：还原瞬间用过渡中的 bounds 调用 setBounds 会把窗口钉到屏幕外；
  // 这里不再触碰窗口位置，只通知渲染进程重排（CSS 布局由 resize 事件自动跟随）。
  let layoutTimer: NodeJS.Timeout | null = null;
  const reassertLayout = (delay = 120) => {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      layoutTimer = null;
      if (win.isDestroyed()) return;
      win.webContents.send('window:relayout');
    }, delay);
  };
  win.on('maximize', () => {
    win.webContents.send('window:maximized-changed', true);
    // Windows 无边框窗口最大化时会带一圈不可见缩放边框，内容可能被顶出屏幕；
    // 显式钳制到显示器工作区，保证标题栏始终完整可见。
    try {
      const display = screen.getDisplayMatching(win.getBounds());
      win.setBounds(display.workArea);
    } catch {
      /* ignore */
    }
    reassertLayout();
  });
  win.on('unmaximize', () => {
    win.webContents.send('window:maximized-changed', false);
    reassertLayout();
  });
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen-changed', true));
  win.on('leave-full-screen', () => {
    win.webContents.send('window:fullscreen-changed', false);
    reassertLayout();
  });
  win.on('resize', () => reassertLayout(300));

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
    elapsed('ready-to-show');
    if (smokeTest) {
      const watchdog = setTimeout(() => {
        console.error('[smoke] watchdog timeout');
        app.exit(2);
      }, 60000);
      // 冒烟测试：验证 preload + React 挂载 + 核心 IPC 全链路
      const testPdfPath = path.join(app.getPath('temp'), 'pkm-smoke-docs', 'smoke-test.pdf');
      const autoScanPdfPath = path.join(
        app.getPath('temp'),
        'pkm-smoke-docs',
        'MinePDF',
        'Library',
        'smoke-autoscan.pdf',
      );
      // 整文件夹导入回归：外部目录应原样导入（保留目录结构）
      const extImportDir = path.join(app.getPath('temp'), 'pkm-smoke-docs', 'ext-folder');
      const extImportSub = path.join(extImportDir, 'sub');
      // 性能/会话诊断用内置多页 PDF（不依赖用户机器上的真实文件）
      const multiPagePdfPath = path.join(app.getPath('temp'), 'pkm-smoke-docs', 'PID-Tuning-Methods.pdf');
      try {
        fs.mkdirSync(path.dirname(testPdfPath), { recursive: true });
        fs.writeFileSync(testPdfPath, buildTestPdf(), 'latin1');
        fs.mkdirSync(path.dirname(autoScanPdfPath), { recursive: true });
        fs.writeFileSync(autoScanPdfPath, buildTestPdf(true).replace('2026', '2027'), 'latin1');
        fs.mkdirSync(extImportSub, { recursive: true });
        fs.writeFileSync(path.join(extImportSub, 'hello.pdf'), buildTestPdf(true), 'latin1');
        fs.writeFileSync(multiPagePdfPath, buildMultiPageTestPdf(8), 'latin1');
      } catch (err) {
        console.error('[smoke] cannot write test pdf', err);
        app.exit(1);
        return;
      }
      const script = `
        (async () => {
          const path = ${JSON.stringify(testPdfPath)};
          const extDir = ${JSON.stringify(extImportDir)};
          const out = { steps: [] };
          const step = async (name, fn) => {
            try { const v = await fn(); out.steps.push([name, true, v]); return v; }
            catch (err) { out.steps.push([name, false, String(err && err.message || err)]); return null; }
          };
          await step('bridge', async () => typeof window.pkm.getSnapshot === 'function');
          await step('updateCheck', async () => (await window.pkm.checkForUpdates()).status === 'disabled');
          const snap = await step('snapshot', () => window.pkm.getSnapshot());
          const rootId = snap && snap.libraries && snap.libraries[0]
            ? snap.libraries[0].rootFolderId
            : null;
          const folder = await step('createFolder', () => window.pkm.createFolder('冒烟测试', rootId));
          const imp = await step('import', () => window.pkm.importPdfs([path], folder && folder.id));
          const snap2 = await step('snapshot2', () => window.pkm.getSnapshot());
          const pdf = snap2 && snap2.pdfs.find(p => folder && p.folderId === folder.id);
          out.pdfFound = !!pdf;
          if (pdf) {
            await step('copiedToLibrary', () => pdf.filepath.toLowerCase().indexOf('minepdf') > -1 && path.indexOf(pdf.filepath.toLowerCase()) === -1);
            await step('folderRealDir', () => pdf.filepath.toLowerCase().indexOf('\u5192\u70df\u6d4b\u8bd5') > -1);
            await step('movePdfToRoot', async () => {
              await window.pkm.movePdf(pdf.id, rootId);
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
            await step('pdfiumAvailable', async () => await window.pkm.pdfiumAvailable());
            const pdfiumOpen = await step('pdfiumOpen', () => window.pkm.pdfiumOpen(pdf.id));
            if (pdfiumOpen) {
              await step('pdfiumOpenInfo', () => pdfiumOpen.pageCount >= 1 && pdfiumOpen.width > 0);
              const pdfiumRender = await step('pdfiumRender', () =>
                window.pkm.pdfiumRender(pdf.id, 1, 1.5),
              );
              if (pdfiumRender) {
                await step(
                  'pdfiumRenderBytes',
                  () =>
                    pdfiumRender.w > 0 &&
                    pdfiumRender.h > 0 &&
                    pdfiumRender.data.byteLength === pdfiumRender.w * pdfiumRender.h * 4,
                );
              }
            }
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
            const note = await step('saveNote', () => window.pkm.saveNote(pdf.id, '# 测试笔记\\n$$E=mc^2$$'));
            if (note) await step('noteFileNamed', () => (note.noteFile || '').endsWith(' 笔记.md'));
            const imgRel = await step('saveNoteImage', () =>
              window.pkm.saveNoteImage(pdf.id, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
            );
            if (imgRel) await step('noteImageAsset', () => String(imgRel).startsWith('assets/'));
            const note2 = await step('noteAfterImage', () => window.pkm.getNote(pdf.id));
            if (note2) {
              await step('noteDirSet', () =>
                !!note2.noteDir &&
                !!note2.noteFile &&
                note2.noteFile.indexOf(note2.noteDir) === 0,
              );
            }
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
            // 整文件夹导入：外部目录应原样复制（保留目录结构），而不是只挑 PDF
            const folderImp = await step('importFolderWhole', async () => {
              const snap0 = await window.pkm.getSnapshot();
              const root0 = snap0.libraries[0].rootFolderId;
              const res = await window.pkm.importPdfs([extDir], root0);
              const snap = await window.pkm.getSnapshot();
              const f = snap.folders.find((x) => x.parentId === root0 && x.name === 'ext-folder');
              const pdf = snap.pdfs.find(
                (p) => p.filename === 'hello.pdf' && p.filepath.indexOf('ext-folder') > -1,
              );
              const ok = res.imported === 1 && !!f && !!pdf;
              if (f) await window.pkm.deleteFolder(f.id);
              return ok;
            });
            void folderImp;
            // 拖拽排序：同级文件夹与知识库都可重排
            const reorderFolders = await step('reorderFolders', async () => {
              const snap0 = await window.pkm.getSnapshot();
              const root0 = snap0.libraries[0].rootFolderId;
              const a = await window.pkm.createFolder('排序A', root0);
              const b = await window.pkm.createFolder('排序B', root0);
              const c = await window.pkm.createFolder('排序C', root0);
              // 向下移动：A 排到 C 之后 → [B, C, A]
              await window.pkm.reorderFolder(a.id, null, c.id);
              const snap = await window.pkm.getSnapshot();
              const kids = snap.folders.filter((x) => x.parentId === root0);
              const ok =
                kids.findIndex((x) => x.id === b.id) < kids.findIndex((x) => x.id === c.id) &&
                kids.findIndex((x) => x.id === c.id) < kids.findIndex((x) => x.id === a.id);
              await window.pkm.deleteFolder(a.id);
              await window.pkm.deleteFolder(b.id);
              await window.pkm.deleteFolder(c.id);
              return ok;
            });
            void reorderFolders;
            const reorderLibs = await step('reorderLibraries', async () => {
              const lib2 = await window.pkm.createLibrary('排序知识库');
              const libs = await window.pkm.libraryList();
              const first = libs[0];
              // 向上移动：lib2 排到 first 之前
              await window.pkm.reorderLibrary(lib2.id, first.id, null);
              const libsUp = await window.pkm.libraryList();
              const upOk = libsUp[0] && libsUp[0].id === lib2.id;
              // 向下移动：lib2 排到 first 之后
              await window.pkm.reorderLibrary(lib2.id, null, first.id);
              const libs2 = await window.pkm.libraryList();
              const downOk = libs2[0] && libs2[0].id === first.id && libs2[1] && libs2[1].id === lib2.id;
              if (lib2) await window.pkm.deleteLibrary(lib2.id);
              return upOk && downOk;
            });
            void reorderLibs;
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
                    const perfPath = ${JSON.stringify(multiPagePdfPath)};
                    await window.pkm.importPdfs([path], null);
                    await window.pkm.importPdfs([perfPath], null);
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
                    const links = [...document.querySelectorAll('.pdf-link-overlay')];
                    return {
                      layer: links.length > 0,
                      links: links.length,
                      urlLinks: links.filter((a) => a.getAttribute('data-url')).length,
                      destLinks: links.filter((a) => a.getAttribute('data-dest-page')).length,
                    };
                  })()
                `);
                console.log('[capture] linkDiag', JSON.stringify(linkDiag));
                // 链接点击实测：页内跳转 + 外部网址 + 邮箱
                const linkTestPath = path.join(app.getPath('temp'), 'pkm-smoke-docs', 'link-test.pdf');
                try {
                  fs.writeFileSync(linkTestPath, buildLinkTestPdf(), 'latin1');
                } catch {
                  /* ignore */
                }
                const linkClickDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    if (window.__pkmAct) window.__pkmAct('clearScreens');
                    await new Promise((r) => setTimeout(r, 200));
                    const p = ${JSON.stringify(linkTestPath)};
                    await window.pkm.importPdfs([p], null);
                    const snap = await window.pkm.getSnapshot();
                    const pdf = snap.pdfs.find((x) => x.filename === 'link-test.pdf');
                    if (!pdf) return { pdf: false };
                    window.__openCalls = [];
                    const orig = window.pkm.openExternalUrl;
                    window.pkm.openExternalUrl = async (url) => {
                      window.__openCalls.push(String(url));
                    };
                    window.__pkmOpenPdf(pdf.id);
                    await new Promise((r) => setTimeout(r, 2200));
                    const links = [...document.querySelectorAll('.pdf-link-overlay')];
                    const info = links.map((a) => ({
                      url: (a.getAttribute('data-url') || '').slice(0, 60),
                      destPage: a.getAttribute('data-dest-page'),
                    }));
                    const sc = document.querySelector('[data-pan-scroll]');
                    const before = sc ? sc.scrollTop : -1;
                    // 对照：直接设置 scrollTop 验证容器可滚动性
                    if (sc) sc.scrollTop = 400;
                    await new Promise((r) => setTimeout(r, 150));
                    const manualScroll = sc ? sc.scrollTop : -1;
                    if (sc) sc.scrollTop = 0;
                    const destLink = links.find((a) => a.getAttribute('data-dest-page'));
                    if (destLink) destLink.click();
                    await new Promise((r) => setTimeout(r, 700));
                    const after = sc ? sc.scrollTop : -1;
                    const sheets = document.querySelectorAll('.pdf-page-sheet').length;
                    const page2 = [...document.querySelectorAll('.pdf-page-sheet')].some(
                      (el) => el.getAttribute('data-page-number') === '2',
                    );
                    const urlLink = links.find((a) => a.getAttribute('data-url'));
                    if (urlLink) urlLink.click();
                    await new Promise((r) => setTimeout(r, 300));
                    window.pkm.openExternalUrl = orig;
                    return {
                      links: info,
                      internalJumped: after > before,
                      before,
                      after,
                      sheets,
                      page2,
                      manualScroll,
                      scCount: document.querySelectorAll('[data-pan-scroll]').length,
                      openCalls: window.__openCalls,
                    };
                  })()
                `);
                console.log('[capture] linkClickDiag', JSON.stringify(linkClickDiag));
                // 临时诊断：真实 PDF 外链/内链点击（仅 PKM_TEST_PDF 设置时运行）
                if (process.env.PKM_TEST_PDF) {
                  const realLinkDiag = await win.webContents.executeJavaScript(`
                    (async () => {
                      const p = ${JSON.stringify(process.env.PKM_TEST_PDF)};
                      if (window.__pkmAct) window.__pkmAct('clearScreens');
                      await new Promise((r) => setTimeout(r, 200));
                      await window.pkm.importPdfs([p], null);
                      const snap = await window.pkm.getSnapshot();
                      const pdf = snap.pdfs.find((x) => x.filepath.includes('Submission guidelines'));
                      if (!pdf) return { pdf: false };
                      window.__pkmOpenPdf(pdf.id);
                      // 早期检查：pdf.js 很可能尚未解析完，原生链接层应已出现
                      await new Promise((r) => setTimeout(r, 900));
                      const early = document.querySelectorAll('.pdf-link-overlay').length;
                      const earlyAnn = document.querySelector('.annotationLayer section');
                      await new Promise((r) => setTimeout(r, 3100));
                      const sheets = document.querySelectorAll('.pdf-page-sheet').length;
                      const links = [...document.querySelectorAll('.pdf-link-overlay')];
                      const linkInfo = links.slice(0, 8).map((a) => ({
                        url: (a.getAttribute('data-url') || '').slice(0, 60),
                        destPage: a.getAttribute('data-dest-page'),
                      }));
                      const sc = document.querySelector('[data-pan-scroll]');
                      const before = sc ? sc.scrollTop : -1;
                      const internalLink = links.find((a) => a.getAttribute('data-dest-page'));
                      if (internalLink) internalLink.click();
                      await new Promise((r) => setTimeout(r, 800));
                      const after = sc ? sc.scrollTop : -1;
                      const externalLink = links.find((a) => a.getAttribute('data-url'));
                      if (externalLink) externalLink.click();
                      await new Promise((r) => setTimeout(r, 500));
                      return {
                        pdf: true,
                        earlyLinks: early,
                        earlyPdfjsLayer: !!earlyAnn,
                        sheets,
                        links: links.length,
                        linkInfo,
                        internalJumped: after > before,
                        before,
                        after,
                        clickedExternal: !!externalLink,
                      };
                    })()
                  `);
                  console.log('[capture] realLinkDiag', JSON.stringify(realLinkDiag));
                }
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
                    const sheet = document.querySelector('.pdf-page-sheet');
                    return {
                      backingWidth: canvas.width,
                      cssWidth: Math.round(cssW),
                      ratio: +(canvas.width / cssW).toFixed(2),
                      renderer: sheet ? sheet.getAttribute('data-renderer') : null,
                    };
                  })()
                `);
                console.log('[capture] renderDiag', JSON.stringify(renderDiag));
                const geomDiag = await win.webContents.executeJavaScript(`
                  (() => {
                    const sc = document.querySelector('[data-pan-scroll]');
                    const sheet = document.querySelector('.pdf-page-sheet');
                    if (!sc || !sheet) return { sc: !!sc, sheet: !!sheet };
                    const sr = sc.getBoundingClientRect();
                    const r = sheet.getBoundingClientRect();
                    const canvas = sheet.querySelector('canvas');
                    const text = sheet.querySelector('.textLayer');
                    const cr = canvas ? canvas.getBoundingClientRect() : null;
                    const tr = text ? text.getBoundingClientRect() : null;
                    return {
                      scroll: { left: sr.left, top: sr.top, w: sr.width, h: sr.height, sl: sc.scrollLeft, st: sc.scrollTop },
                      sheet: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
                      canvas: cr ? { left: +cr.left.toFixed(1), top: +cr.top.toFixed(1), w: +cr.width.toFixed(1), h: +cr.height.toFixed(1), backing: canvas.width + 'x' + canvas.height } : null,
                      text: tr ? { left: +tr.left.toFixed(1), top: +tr.top.toFixed(1), w: +tr.width.toFixed(1), h: +tr.height.toFixed(1), spans: text.querySelectorAll('span').length } : null,
                      centeredInScroll: Math.abs(r.left + r.width / 2 - (sr.left + sr.width / 2)) < 2,
                    };
                  })()
                `);
                console.log('[capture] geomDiag', JSON.stringify(geomDiag));
                // 内容布局诊断：canvas 内部非白像素的包围盒（验证页面内容实际显示大小/位置）
                const contentDiag = await win.webContents.executeJavaScript(`
                  (() => {
                    const canvas = document.querySelector('.pdf-page-sheet canvas');
                    if (!canvas || !canvas.width) return { canvas: false };
                    const ctx = canvas.getContext('2d');
                    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
                    let transparent = 0;
                    for (let y = 0; y < canvas.height; y++) {
                      for (let x = 0; x < canvas.width; x++) {
                        const i = (y * canvas.width + x) * 4;
                        const a = data[i + 3];
                        if (a === 0) transparent++;
                        if (a > 200 && (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245)) {
                          if (x < minX) minX = x;
                          if (x > maxX) maxX = x;
                          if (y < minY) minY = y;
                          if (y > maxY) maxY = y;
                          count++;
                        }
                      }
                    }
                    const cssW = parseFloat(canvas.style.width);
                    const cssH = parseFloat(canvas.style.height);
                    return {
                      backing: canvas.width + 'x' + canvas.height,
                      css: cssW + 'x' + cssH,
                      contentBackingBox: 'x:[' + minX + ',' + maxX + '] y:[' + minY + ',' + maxY + ']',
                      contentBackingSize: (maxX - minX + 1) + 'x' + (maxY - minY + 1),
                      contentCssSize: Math.round((maxX - minX + 1) * cssW / canvas.width) + 'x' + Math.round((maxY - minY + 1) * cssH / canvas.height),
                      ratio: +(canvas.width / cssW).toFixed(2),
                      fillRatio: +((maxX - minX + 1) * (maxY - minY + 1) / (canvas.width * canvas.height)).toFixed(3),
                      transparentPct: +(100 * transparent / (canvas.width * canvas.height)).toFixed(1),
                    };
                  })()
                `);
                console.log('[capture] contentDiag', JSON.stringify(contentDiag));
                // 方案 B 验证：把边栏/信息面板拖窄后，标签文字应自动隐藏（只剩图标）
                const narrowDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const inspector = document.querySelector('[data-panel="inspector"]');
                    const sidebar = document.querySelector('[data-panel="sidebar"]');
                    if (!inspector || !sidebar) return { inspector: !!inspector, sidebar: !!sidebar };
                    const labels = ['信息', '书签', '笔记'];
                    inspector.style.width = '180px';
                    sidebar.style.width = '170px';
                    await new Promise((r) => setTimeout(r, 150));
                    const labelSpans = [...inspector.querySelectorAll('span')].filter(
                      (s) => labels.includes((s.textContent || '').trim()) && s.children.length === 0,
                    );
                    const libTitle = [...sidebar.querySelectorAll('span')].find(
                      (s) => (s.textContent || '').trim() === '我的知识库' || (s.textContent || '').trim() === 'Library',
                    );
                    const importText = [...sidebar.querySelectorAll('span')].find(
                      (s) => (s.textContent || '').trim() === '导入' || (s.textContent || '').trim() === 'Import',
                    );
                    const result = {
                      labelCount: labelSpans.length,
                      labelsHidden: labelSpans.map((s) => getComputedStyle(s).display),
                      libTitleHidden: libTitle ? getComputedStyle(libTitle).display : null,
                      importHidden: importText ? getComputedStyle(importText).display : null,
                    };
                    inspector.style.width = '';
                    sidebar.style.width = '';
                    return result;
                  })()
                `);
                console.log('[capture] narrowDiag', JSON.stringify(narrowDiag));
                // 便捷操作验证：边栏宽度变化后自动适配宽度；工具栏折叠/展开；沉浸式悬停下拉
                const convenienceDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const pdf = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!pdf) return { pdf: false };
                    window.__pkmOpenPdf(pdf.id);
                    await new Promise((r) => setTimeout(r, 1500));
                    const sheet = () => document.querySelector('.pdf-page-sheet');
                    const sheetW = () => (sheet() ? sheet().getBoundingClientRect().width : 0);
                    // 1) 3.2.1 宽度自适应策略：
                    //    缩小窗口且 PDF 被遮挡 → 自动适配；放大窗口 → 保持缩放；
                    //    缩小但 PDF 未被遮挡 → 保持缩放（不反复重渲染大文件）
                    const w0 = sheetW();
                    window.resizeTo(1100, 760);
                    await new Promise((r) => setTimeout(r, 900));
                    const w1 = sheetW();
                    window.resizeTo(1700, 980);
                    await new Promise((r) => setTimeout(r, 900));
                    const w2 = sheetW();
                    window.resizeTo(1440, 900);
                    await new Promise((r) => setTimeout(r, 900));
                    const w3 = sheetW();
                    const shrinkClipFit = w1 < w0 - 20;
                    const growKeeps = Math.abs(w2 - w1) < 1;
                    const shrinkNoClipKeeps = Math.abs(w3 - w2) < 1;
                    // 2) 工具栏折叠 → 出现“展开工具栏”按钮
                    const collapseBtn = [...document.querySelectorAll('button')].find(
                      (b) => b.title === '折叠工具栏' || b.title === 'Collapse toolbar',
                    );
                    if (collapseBtn) collapseBtn.click();
                    await new Promise((r) => setTimeout(r, 250));
                    const expandBtn = [...document.querySelectorAll('button')].find(
                      (b) => b.title === '展开工具栏' || b.title === 'Expand toolbar',
                    );
                    // 3) 展开并进入沉浸式 → 工具栏自动折叠，hover 顶部自动下拉
                    if (expandBtn) expandBtn.click();
                    await new Promise((r) => setTimeout(r, 200));
                    const immersiveBtn = [...document.querySelectorAll('button')].find(
                      (b) => b.title === '沉浸式阅读（收起边栏并放大，再点恢复）' ||
                        b.title === 'Immersive reading (collapse panels & zoom, click again to restore)',
                    );
                    if (immersiveBtn) immersiveBtn.click();
                    await new Promise((r) => setTimeout(r, 800));
                    const wrap = document.querySelector('.absolute.inset-x-0.top-0.z-30');
                    const tbWrap = wrap ? wrap.querySelector('[data-immersive-toolbar]') : null;
                    const collapsedInImmersive =
                      !!wrap &&
                      (!tbWrap ||
                        getComputedStyle(tbWrap).maxHeight === '0px' ||
                        tbWrap.getBoundingClientRect().height === 0);
                    if (wrap) {
                      wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
                      await new Promise((r) => setTimeout(r, 250));
                    }
                    const hoverShowsToolbar = !!wrap && wrap.querySelectorAll('button').length > 3;
                    // 退出沉浸式并彻底还原窗口状态，避免影响后续诊断
                    // （按钮引用可能已随工具栏重建失效，需重新查找）
                    const exitImmersiveBtn = [...document.querySelectorAll('button')].find(
                      (b) => b.title === '沉浸式阅读（收起边栏并放大，再点恢复）' ||
                        b.title === 'Immersive reading (collapse panels & zoom, click again to restore)',
                    );
                    if (exitImmersiveBtn) exitImmersiveBtn.click();
                    await new Promise((r) => setTimeout(r, 700));
                    if (await window.pkm.isMaximized()) await window.pkm.toggleMaximize();
                    window.resizeTo(1440, 900);
                    await new Promise((r) => setTimeout(r, 500));
                    return {
                      w0,
                      w1,
                      w2,
                      w3,
                      shrinkClipFit,
                      growKeeps,
                      shrinkNoClipKeeps,
                      collapseBtn: !!collapseBtn,
                      expandBtn: !!expandBtn,
                      collapsedInImmersive,
                      hoverShowsToolbar,
                    };
                  })()
                `);
                console.log('[capture] convenienceDiag', JSON.stringify(convenienceDiag));
                // 应用内性能诊断：PDFium IPC 渲染真实 PDF 的每页耗时
                const perfDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const perfPath = ${JSON.stringify(multiPagePdfPath)};
                    let snap = await window.pkm.getSnapshot();
                    let pdf = snap.pdfs.find((p) => p.filename === 'PID-Tuning-Methods.pdf');
                    if (!pdf) {
                      await window.pkm.importPdfs([perfPath], null);
                      snap = await window.pkm.getSnapshot();
                      pdf = snap.pdfs.find((p) => p.filename === 'PID-Tuning-Methods.pdf');
                    }
                    if (!pdf) return { imported: 0, pdf: false };
                    const times = [];
                    for (let p = 1; p <= pdf.pageCount; p++) {
                      const t1 = performance.now();
                      await window.pkm.pdfiumRender(pdf.id, p, 1.5);
                      times.push(+(performance.now() - t1).toFixed(2));
                    }
                    // 基线 IPC 往返（小载荷）
                    const tBase = performance.now();
                    for (let i = 0; i < 20; i++) await window.pkm.pdfiumAvailable();
                    const tinyIpcMs = +(performance.now() - tBase) / 20;
                    // 渲染端大缓冲拷贝成本（Uint8ClampedArray 复制）
                    const resCopy = await window.pkm.pdfiumRender(pdf.id, 1, 1.5);
                    const tCopy = performance.now();
                    const copy = new Uint8ClampedArray(resCopy.data);
                    const copyMs = +(performance.now() - tCopy).toFixed(2);
                    const tBatch = performance.now();
                    await window.pkm.pdfiumRenderBatch(
                      pdf.id,
                      Array.from({ length: pdf.pageCount }, (_, i) => i + 1),
                      1.5,
                    );
                    const batchMs = +(performance.now() - tBatch).toFixed(1);
                    const tOpen = performance.now();
                    window.__pkmOpenPdf(pdf.id);
                    await new Promise((r) => setTimeout(r, 900));
                    const c = document.querySelector('.pdf-page-sheet canvas');
                    return {
                      imported: 1,
                      pageCount: pdf.pageCount,
                      perPageMs: times,
                      avgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
                      batchAllMs: batchMs,
                      tinyIpcMs: +tinyIpcMs.toFixed(2),
                      copyMs,
                      copyLen: copy.length,
                      canvasPainted: c ? c.width : 0,
                      renderer: document.querySelector('.pdf-page-sheet')?.getAttribute('data-renderer'),
                    };
                  })()
                `);
                console.log('[capture] perfDiag', JSON.stringify(perfDiag));
                const fontDiag = await win.webContents.executeJavaScript(`
                  (() => {
                    const body = getComputedStyle(document.body);
                    const all = [...document.querySelectorAll('span,div,button,input,textarea,li')]
                      .map((el) => parseFloat(getComputedStyle(el).fontSize))
                      .filter((n) => n > 0);
                    const editor = document.querySelector('textarea');
                    return {
                      bodyFont: body.fontFamily.split(',')[0].replace(/["']/g, ''),
                      bodySize: body.fontSize,
                      minSeen: all.length ? Math.min(...all) : null,
                      monoTex: editor ? getComputedStyle(editor).fontFamily.split(',')[0].replace(/["']/g, '') : null,
                      monoSize: editor ? getComputedStyle(editor).fontSize : null,
                    };
                  })()
                `);
                console.log('[capture] fontDiag', JSON.stringify(fontDiag));
                const panDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const el = document.querySelector('[data-pan-scroll]');
                    if (!el) return { scroll: false };
                    const snap0 = await window.pkm.getSnapshot();
                    const rightDragPan = snap0.settings.rightDragPan !== false;
                    const rect = el.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    for (let i = 0; i < 4; i++) {
                      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -140, ctrlKey: true, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
                      await new Promise((r) => setTimeout(r, 160));
                    }
                    await new Promise((r) => setTimeout(r, 1200));
                    const overflowX = el.scrollWidth > el.clientWidth + 2;
                    const overflowY = el.scrollHeight > el.clientHeight + 2;
                    const cursorBefore = getComputedStyle(el).cursor;
                    const sl0 = el.scrollLeft, st0 = el.scrollTop;
                    el.dispatchEvent(new MouseEvent('mousedown', { button: rightDragPan ? 2 : 0, buttons: rightDragPan ? 2 : 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
                    await new Promise((r) => setTimeout(r, 80));
                    window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 260, clientY: cy + 160, bubbles: true }));
                    const cursorDuring = getComputedStyle(el).cursor;
                    // 拖拽位移经 rAF 节流异步应用，等一帧再松手
                    await new Promise((r) => setTimeout(r, 120));
                    window.dispatchEvent(new MouseEvent('mouseup', { button: rightDragPan ? 2 : 0, buttons: 0, bubbles: true }));
                    await new Promise((r) => setTimeout(r, 120));
                    const slMoved = el.scrollLeft !== sl0;
                    const stMoved = el.scrollTop !== st0;
                    el.scrollLeft = 0;
                    await new Promise((r) => setTimeout(r, 80));
                    const page = document.querySelector('.pdf-page-sheet');
                    const leftReachable = page ? page.getBoundingClientRect().left >= rect.left - 2 : null;
                    return { rightDragPan, overflowX, overflowY, cursorBefore, cursorDuring, slMoved, stMoved, leftReachable };
                  })()
                `);
                console.log('[capture] panDiag', JSON.stringify(panDiag));
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
                const immersiveDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    // 固定打开 smoke-test.pdf（612pt），保证缩放读数基准一致
                    const snap0 = await window.pkm.getSnapshot();
                    const smoke = snap0.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (smoke) window.__pkmOpenPdf(smoke.id);
                    await new Promise((r) => setTimeout(r, 1600));
                    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('沉浸式阅读'));
                    if (!btn) return { btn: false };
                    const readScale = () => {
                      const c = document.querySelector('.pdf-page-sheet canvas');
                      if (!c) return null;
                      const w = parseFloat(c.style.width) || c.getBoundingClientRect().width;
                      return +(w / 612).toFixed(2);
                    };
                    const before = {
                      sidebarW: document.querySelector('aside').getBoundingClientRect().width,
                      scale: readScale(),
                      maximized: await window.pkm.isMaximized(),
                    };
                    btn.click();
                    await new Promise((r) => setTimeout(r, 1200));
                    const during = {
                      sidebarW: document.querySelector('aside').getBoundingClientRect().width,
                      scale: readScale(),
                      canvasW: document.querySelector('.pdf-page-sheet canvas')?.style.width ?? null,
                      winW: window.innerWidth,
                      maximized: await window.pkm.isMaximized(),
                    };
                    // 沉浸式工具栏已折叠，先 hover 顶部展开，再点退出按钮
                    const wrap = document.querySelector('.absolute.inset-x-0.top-0.z-30');
                    if (wrap) {
                      wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
                      await new Promise((r) => setTimeout(r, 300));
                    }
                    const exitBtn = [...document.querySelectorAll('button')].find(
                      (b) => (b.getAttribute('title') || '').includes('沉浸式阅读'),
                    );
                    if (exitBtn) exitBtn.click();
                    await new Promise((r) => setTimeout(r, 1200));
                    const after = {
                      sidebarW: document.querySelector('aside').getBoundingClientRect().width,
                      scale: readScale(),
                      maximized: await window.pkm.isMaximized(),
                    };
                    return {
                      btn: true,
                      collapsed: during.sidebarW < before.sidebarW - 10,
                      maximizedDuring: during.maximized === true,
                      zoom121: Math.abs(during.scale - 1.21) < 0.02,
                      restoredW: Math.abs(after.sidebarW - before.sidebarW) < 5,
                      // 退出后窗口还原会触发自动适配宽度，scale 变化是预期行为
                      restoredScale: after.scale > 0.3,
                      restoredMax: after.maximized === before.maximized,
                      before, during, after,
                    };
                  })()
                `);
                console.log('[capture] immersiveDiag', JSON.stringify(immersiveDiag));
                await new Promise((r) => setTimeout(r, 600));
                const image = await win.webContents.capturePage();
                const outDir = path.join(process.cwd(), 'docs');
                fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(path.join(outDir, 'app-screenshot.png'), image.toPNG());
                console.log('[capture] main window saved to docs/app-screenshot.png');
                // README 配图 1：主界面（切换到真实论文 PDF 再拍，三栏布局完整可见）
                const picDir = path.join(process.cwd(), 'pic');
                fs.mkdirSync(picDir, { recursive: true });
                await win.webContents.executeJavaScript(`(async () => {
                  const snap = await window.pkm.getSnapshot();
                  const pid = snap.pdfs.find((p) => p.filename === 'PID-Tuning-Methods.pdf');
                  if (pid) window.__pkmOpenPdf(pid.id);
                  return true;
                })()`);
                await new Promise((r) => setTimeout(r, 1600));
                const shotMain = await win.webContents.capturePage();
                fs.writeFileSync(path.join(picDir, 'shot-main.png'), shotMain.toPNG());
                console.log('[capture] saved pic/shot-main.png');
                // 文档切换验证：A -> B -> A，每步都应有实际渲染内容
                try {
                  fs.mkdirSync(path.dirname(autoScanPdfPath), { recursive: true });
                  fs.writeFileSync(autoScanPdfPath, buildTestPdf(true).replace('2026', '2027'), 'latin1');
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
                // 加载动画验证：渲染完成后遮罩应消失、画布有内容
                const loadingDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    // 用较大的 PDF 使渲染期间能捕捉到加载动画
                    const pdf = snap.pdfs.find((p) => p.filename === 'PID-Tuning-Methods.pdf') ||
                      snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!pdf) return { pdf: false };
                    window.__pkmOpenPdf(pdf.id);
                    const t0 = Date.now();
                    await new Promise((r) => setTimeout(r, 60));
                    const overlay = document.querySelector('[data-testid="pdf-loading"]');
                    const logo = overlay ? overlay.querySelector('img.pdf-loading-logo') : null;
                    const during = !!overlay;
                    const logoLoaded = logo ? logo.naturalWidth > 0 : null;
                    const logoSrc = logo ? logo.getAttribute('src') : null;
                    await new Promise((r) => setTimeout(r, 1400));
                    const after = !!document.querySelector('[data-testid="pdf-loading"]');
                    const c = document.querySelector('.pdf-page-sheet canvas');
                    return { during, after, canvasPainted: c ? c.width > 0 : false, waitMs: Date.now() - t0, logoLoaded, logoSrc };
                  })()
                `);
                console.log('[capture] loadingDiag', JSON.stringify(loadingDiag));
                // 会话记忆验证：翻页记录页码；模拟重启后自动恢复并跳转
                const sessionDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    if (window.__pkmAct) window.__pkmAct('clearScreens');
                    localStorage.removeItem('pkm.screensSession');
                    await new Promise((r) => setTimeout(r, 200));
                    const snap = await window.pkm.getSnapshot();
                    const pid = snap.pdfs.find((p) => p.filename === 'PID-Tuning-Methods.pdf');
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!pid || !a) return { pid: !!pid, a: !!a };
                    window.__pkmOpenPdf(pid.id);
                    await new Promise((r) => setTimeout(r, 1500));
                    // 虚拟滚动下第 3 页初始不在预载范围，先显式滚动触发挂载再对齐
                    const sc0 = document.querySelector('[data-pan-scroll]');
                    if (sc0) sc0.scrollTop = 2600;
                    await new Promise((r) => setTimeout(r, 900));
                    const p3 = [...document.querySelectorAll('.pdf-page-sheet')].find(
                      (el) => el.getAttribute('data-page-number') === '3',
                    );
                    if (p3) p3.scrollIntoView();
                    await new Promise((r) => setTimeout(r, 700));
                    const rec1 = JSON.parse(localStorage.getItem('pkm.lastSession') || 'null');
                    // 再开一个标签，模拟多标签阅读场景
                    window.__pkmAct('openPdfInNewTab', a.id);
                    await new Promise((r) => setTimeout(r, 400));
                    const pidTab = window.__pkmStore()
                      .screens[0].tabs.find((t) => t.pdfId === pid.id);
                    if (pidTab) window.__pkmAct('activateTab', window.__pkmStore().screens[0].id, pidTab.id);
                    await new Promise((r) => setTimeout(r, 1200));
                    const snapSaved = JSON.parse(localStorage.getItem('pkm.screensSession') || 'null');
                    // 模拟“关闭后重启”：保留关闭前的快照，清空当前状态并触发恢复
                    const savedSnapshot = localStorage.getItem('pkm.screensSession');
                    if (window.__pkmAct) window.__pkmAct('clearScreens');
                    if (savedSnapshot) localStorage.setItem('pkm.screensSession', savedSnapshot);
                    if (window.__pkmRestoreSession) window.__pkmRestoreSession();
                    await new Promise((r) => setTimeout(r, 2600));
                    const rec2 = JSON.parse(localStorage.getItem('pkm.lastSession') || 'null');
                    const st = window.__pkmStore();
                    const tabsRestored = st.screens.length > 0 && st.screens[0].tabs.length === 2;
                    const restoredPid = st.activePdfId === pid.id;
                    const activeTabPdf = st.screens[0]
                      ? (st.screens[0].tabs.find((t) => t.id === st.screens[0].activeTabId) || {}).pdfId
                      : null;
                    const sc = document.querySelector('[data-pan-scroll]');
                    const p3b = [...document.querySelectorAll('.pdf-page-sheet')].find(
                      (el) => el.getAttribute('data-page-number') === '3',
                    );
                    const rel = p3b && sc
                      ? Math.abs(p3b.getBoundingClientRect().top - sc.getBoundingClientRect().top)
                      : null;
                    const restoredToPage3 = rel != null && rel < 80;
                    const jumpOrCurrent3 = st.jumpPage === 3 || st.currentPage === 3;
                    // 旧格式回退：清除快照后写入单条 lastSession，仍应能恢复
                    localStorage.removeItem('pkm.screensSession');
                    localStorage.setItem(
                      'pkm.lastSession',
                      JSON.stringify({ kind: 'library', pdfId: pid.id, page: 3, ts: Date.now() }),
                    );
                    if (window.__pkmAct) window.__pkmAct('clearScreens');
                    if (window.__pkmRestoreSession) window.__pkmRestoreSession();
                    await new Promise((r) => setTimeout(r, 1800));
                    const stLegacy = window.__pkmStore();
                    const legacyRestored = stLegacy.activePdfId === pid.id;
                    const st3 = document.querySelector('[data-pan-scroll]')
                      ? document.querySelector('[data-pan-scroll]').scrollTop
                      : -1;
                    // 对照：直接设置 scrollTop 验证容器可滚动性
                    const sc2 = document.querySelector('[data-pan-scroll]');
                    const scrollable = sc2 ? sc2.scrollHeight > sc2.clientHeight : false;
                    if (sc2) sc2.scrollTop = 500;
                    await new Promise((r) => setTimeout(r, 150));
                    const manualScroll = sc2 ? sc2.scrollTop : -1;
                    if (sc2) sc2.scrollTop = 0;
                    return {
                      rec1Page: rec1 ? rec1.page : null,
                      rec2Page: rec2 ? rec2.page : null,
                      snapSavedTabs: snapSaved && snapSaved.screens ? snapSaved.screens[0].tabs.length : 0,
                      snapSavedPage: snapSaved ? snapSaved.page : null,
                      tabsRestored,
                      restoredPdf: restoredPid,
                      activeTabPdf,
                      jumpPage: st.jumpPage,
                      currentPage: st.currentPage,
                      scrollTop: sc ? sc.scrollTop : -1,
                      restoredToPage3,
                      jumpOrCurrent3,
                      legacyRestored,
                      st3,
                      p3Exists: !!p3b,
                      scCount: document.querySelectorAll('[data-pan-scroll]').length,
                      scrollable,
                      manualScroll,
                    };
                  })()
                `);
                console.log('[capture] sessionDiag', JSON.stringify(sessionDiag));
                // 3.0.0 标签页 + 分屏功能验证
                const tabsDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    const b = snap.pdfs.find((p) => p.filename === 'smoke-autoscan.pdf');
                    const pid = snap.pdfs.find((p) => p.filename === 'PID-Tuning-Methods.pdf');
                    if (!a || !b || !pid) return { files: !!a && !!b && !!pid };
                    if (window.__pkmAct) window.__pkmAct('clearScreens');
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 500));
                    window.__pkmOpenPdf(b.id);
                    await new Promise((r) => setTimeout(r, 500));
                    const t2 = window.__pkmStore().screens[0] ? window.__pkmStore().screens[0].tabs.length : 0;
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 300));
                    const t3 = window.__pkmStore().screens[0] ? window.__pkmStore().screens[0].tabs.length : 0;
                    const activeAfterA = window.__pkmStore().activePdfId === a.id;
                    window.__pkmAct('openPdfInNewTab', a.id);
                    await new Promise((r) => setTimeout(r, 300));
                    const t4 = window.__pkmStore().screens[0].tabs.length;
                    window.__pkmAct('splitScreen', 'split-h');
                    await new Promise((r) => setTimeout(r, 600));
                    const screens2 = window.__pkmStore().screens.length === 2;
                    window.__pkmAct('openInSplit', pid.id);
                    await new Promise((r) => setTimeout(r, 600));
                    const openedInOther = window.__pkmStore().screens.some((sc) =>
                      sc.tabs.some((t) => t.pdfId === pid.id),
                    );
                    const activePid = window.__pkmStore().activePdfId === pid.id;
                    // 关闭第二屏全部标签 → 屏自动消失，回到单屏
                    const other = window.__pkmStore().screens.find((sc) =>
                      sc.tabs.some((t) => t.pdfId === pid.id),
                    );
                    if (other) window.__pkmAct('closeAllTabs', other.id);
                    await new Promise((r) => setTimeout(r, 400));
                    const singleAgain =
                      window.__pkmStore().screens.length === 1 &&
                      window.__pkmStore().splitLayout === 'single';
                    return { t2, t3, t4, activeAfterA, screens2, openedInOther, activePid, singleAgain };
                  })()
                `);
                console.log('[capture] tabsDiag', JSON.stringify(tabsDiag));
                // 书签面板工具条（搜索/定位/折叠）验证
                const outlineUiDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const pdf = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!pdf) return { pdf: false };
                    window.__pkmOpenPdf(pdf.id);
                    await new Promise((r) => setTimeout(r, 1500));
                    const tabBtn = [...document.querySelectorAll('button')].find(
                      (b) => (b.getAttribute('title') || '').includes('书签'),
                    );
                    if (tabBtn) tabBtn.click();
                    await new Promise((r) => setTimeout(r, 300));
                    const searchInput = [...document.querySelectorAll('input')].some(
                      (i) => i.placeholder === '搜索书签' || i.placeholder === 'Search bookmarks',
                    );
                    const locateBtn = [...document.querySelectorAll('button')].some(
                      (b) => (b.getAttribute('title') || '').includes('定位当前章节'),
                    );
                    const collapseBtn = [...document.querySelectorAll('button')].some(
                      (b) =>
                        (b.getAttribute('title') || '').includes('全部折叠') ||
                        (b.getAttribute('title') || '').includes('全部展开'),
                    );
                    const items = [...document.querySelectorAll('aside button')].filter(
                      (b) => (b.className || '').includes('py-[3px]'),
                    ).length;
                    return { tabBtn: !!tabBtn, searchInput, locateBtn, collapseBtn, items };
                  })()
                `);
                console.log('[capture] outlineUiDiag', JSON.stringify(outlineUiDiag));
                // 分屏窗格激活切换 + 高亮 + 新分屏打开验证
                const paneDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    const pid = snap.pdfs.find((p) => p.filename === 'PID-Tuning-Methods.pdf');
                    if (!a || !pid) return { files: !!a && !!pid };
                    const insp = document.querySelector('[data-panel="inspector"]');
                    const inspW0 = insp ? insp.getBoundingClientRect().width : 0;
                    window.__pkmAct('clearScreens');
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 500));
                    window.__pkmAct('splitScreen', 'split-h');
                    await new Promise((r) => setTimeout(r, 600));
                    const screen2 = window.__pkmStore().screens[1];
                    const inspW1 = insp ? insp.getBoundingClientRect().width : 0;
                    const inspectorStable = Math.abs(inspW1 - inspW0) < 1;
                    window.__pkmAct('activateScreen', screen2.id);
                    await new Promise((r) => setTimeout(r, 300));
                    const activeSwitched = window.__pkmStore().activeScreenId === screen2.id;
                    // 只有选中屏的标签栏带高亮标记（accent 底边），且只有选中屏的活动标签带顶部标记
                    const accentBars = [...document.querySelectorAll('div')].filter(
                      (d) => (d.className || '').includes('border-b-app-accent/70'),
                    ).length;
                    const tabMarks = [...document.querySelectorAll('span')].filter(
                      (s) =>
                        (s.className || '').includes('bg-app-accent') &&
                        (s.className || '').includes('inset-x-0'),
                    ).length;
                    // 选中屏2后打开屏1已有的 PDF：应留在屏2打开（独立打开，不跳回屏1）
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 400));
                    const stayedScreen2 = window.__pkmStore().activeScreenId === screen2.id;
                    const aInScreen2 = window.__pkmStore()
                      .screens.find((sc) => sc.id === screen2.id)
                      .tabs.some((t) => t.pdfId === a.id);
                    // 分割线拖拽调整比例（用专属标识定位分屏分割线，避免误选侧边栏/信息面板的 resize 手柄）
                    const ratio0 = window.__pkmStore().splitRatio;
                    const divider = document.querySelector('[data-split-divider]');
                    let dragRatio = null;
                    if (divider) {
                      const rect = divider.getBoundingClientRect();
                      divider.dispatchEvent(
                        new MouseEvent('mousedown', { clientX: rect.left + 2, clientY: rect.top + 2, bubbles: true, cancelable: true }),
                      );
                      await new Promise((r) => setTimeout(r, 60));
                      window.dispatchEvent(
                        new MouseEvent('mousemove', { clientX: rect.left + 120, clientY: rect.top + 2, bubbles: true }),
                      );
                      // 位移经 rAF 节流异步应用，等一帧再松手
                      await new Promise((r) => setTimeout(r, 150));
                      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                      await new Promise((r) => setTimeout(r, 250));
                      dragRatio = window.__pkmStore().splitRatio;
                    }
                    // Ctrl+滚轮应只缩放所在屏，另一屏与信息面板均不受影响
                    const scs = [...document.querySelectorAll('[data-pan-scroll]')];
                    const sheetOf = (sc) => sc.querySelector('.pdf-page-sheet');
                    const wBefore = scs.map((sc) => (sheetOf(sc) ? sheetOf(sc).getBoundingClientRect().width : 0));
                    if (scs[0]) {
                      const r = scs[0].getBoundingClientRect();
                      scs[0].dispatchEvent(
                        new WheelEvent('wheel', {
                          ctrlKey: true,
                          deltaY: -120,
                          clientX: r.left + r.width / 2,
                          clientY: r.top + 100,
                          bubbles: true,
                          cancelable: true,
                        }),
                      );
                    }
                    await new Promise((r) => setTimeout(r, 400));
                    const wAfter = scs.map((sc) => (sheetOf(sc) ? sheetOf(sc).getBoundingClientRect().width : 0));
                    const zoomScreen1 = wAfter[0] > wBefore[0] + 5;
                    const zoomScreen2Untouched = Math.abs(wAfter[1] - wBefore[1]) < 1;
                    window.__pkmAct('openInSplit', pid.id);
                    await new Promise((r) => setTimeout(r, 500));
                    const hasPid = window.__pkmStore().screens.some((sc) =>
                      sc.tabs.some((t) => t.pdfId === pid.id),
                    );
                    return {
                      activeSwitched,
                      inspectorStable,
                      accentBars,
                      tabMarks,
                      stayedScreen2,
                      aInScreen2,
                      ratio0,
                      dragRatio,
                      dividerFound: !!divider,
                      zoomScreen1,
                      zoomScreen2Untouched,
                      hasPid,
                    };
                  })()
                `);
                console.log('[capture] paneDiag', JSON.stringify(paneDiag));
                // README 配图 2：分屏阅读（两个独立阅读屏 + 信息面板）
                await new Promise((r) => setTimeout(r, 400));
                const shotSplit = await win.webContents.capturePage();
                fs.writeFileSync(path.join(picDir, 'shot-split.png'), shotSplit.toPNG());
                console.log('[capture] saved pic/shot-split.png');
                // 单屏放大：验证 PDF 放大不会挤压信息面板，且信息面板上 Ctrl+滚轮不触发缩放
                const zoomDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!a) return { pdf: false };
                    window.__pkmAct('clearScreens');
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 2000));
                    const insp = () => document.querySelector('[data-panel="inspector"]');
                    const sc = () => document.querySelector('[data-pan-scroll]');
                    const sheet = () => document.querySelector('.pdf-page-sheet');
                    const rect = (el) => (el ? el.getBoundingClientRect() : null);
                    const before = {
                      winW: window.innerWidth,
                      inspW: rect(insp()) ? rect(insp()).width : 0,
                      inspRight: rect(insp()) ? rect(insp()).right : 0,
                      scW: rect(sc()) ? rect(sc()).width : 0,
                      sheetW: rect(sheet()) ? rect(sheet()).width : 0,
                    };
                    const el = sc();
                    if (el) {
                      const r = rect(el);
                      for (let i = 0; i < 8; i++) {
                        el.dispatchEvent(
                          new WheelEvent('wheel', {
                            ctrlKey: true,
                            deltaY: -120,
                            clientX: r.left + r.width / 2,
                            clientY: r.top + 100,
                            bubbles: true,
                            cancelable: true,
                          }),
                        );
                        await new Promise((res) => setTimeout(res, 40));
                      }
                    }
                    await new Promise((res) => setTimeout(res, 600));
                    const after = {
                      winW: window.innerWidth,
                      inspW: rect(insp()) ? rect(insp()).width : 0,
                      inspRight: rect(insp()) ? rect(insp()).right : 0,
                      scW: rect(sc()) ? rect(sc()).width : 0,
                      sheetW: rect(sheet()) ? rect(sheet()).width : 0,
                      sheetRight: rect(sheet()) ? rect(sheet()).right : 0,
                      scScrollW: sc() ? sc().scrollWidth : 0,
                      scClientW: sc() ? sc().clientWidth : 0,
                    };
                    const stable =
                      Math.abs(after.inspW - before.inspW) < 1 &&
                      Math.abs(after.inspRight - before.inspRight) < 1;
                    const grew = after.sheetW > before.sheetW * 1.5;
                    // 鼠标在信息面板上 Ctrl+滚轮：不应触发 PDF 缩放
                    const w0 = rect(sheet()) ? rect(sheet()).width : 0;
                    const ir = rect(insp());
                    if (ir) {
                      insp().dispatchEvent(
                        new WheelEvent('wheel', {
                          ctrlKey: true,
                          deltaY: -120,
                          clientX: ir.left + ir.width / 2,
                          clientY: ir.top + 60,
                          bubbles: true,
                          cancelable: true,
                        }),
                      );
                      await new Promise((res) => setTimeout(res, 250));
                    }
                    const w1 = rect(sheet()) ? rect(sheet()).width : 0;
                    const inspWheelNoZoom = Math.abs(w1 - w0) < 1;
                    return { before, after, stable, grew, inspWheelNoZoom };
                  })()
                `);
                console.log('[capture] zoomDiag', JSON.stringify(zoomDiag));
                const tabDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    const b = snap.pdfs.find((p) => p.filename === 'smoke-autoscan.pdf');
                    if (!a || !b) return { files: !!a && !!b };
                    const activeTab = () => {
                      const btn = [...document.querySelectorAll('button')].find((x) => {
                        const cls = x.className || '';
                        return cls.includes('rounded-t-md') && cls.includes('bg-app-base');
                      });
                      // 3.0.0 起信息面板标签为图标 + title/aria-label，不再显示文字
                      return btn ? (btn.getAttribute('title') || btn.getAttribute('aria-label') || '').trim() : null;
                    };
                    window.__pkmOpenPdf(b.id);
                    await new Promise((r) => setTimeout(r, 1500));
                    const bTab = activeTab();
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 1500));
                    const aTab = activeTab();
                    return { aTab, bTab, ok: aTab === '书签' && bTab === '笔记' };
                  })()
                `);
                console.log('[capture] tabDiag', JSON.stringify(tabDiag));
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
                    const tabLabels = ['书签', '笔记'];
                    const tabs = tabLabels.map((label) =>
                      [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === label),
                    );
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
                    return { added: !!item, inboxRow: !!inboxRow, openedCanvas: c ? c.width : 0, resized, tabs };
                  })()
                `);
                console.log('[capture] inboxDiag', JSON.stringify(inboxDiag));
                const shotDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!a) return { pdf: false };
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 2000));
                    const notesTab = [...document.querySelectorAll('button')].find(
                      (b) =>
                        (b.getAttribute('title') || b.getAttribute('aria-label') || '').trim() === '笔记' ||
                        (b.textContent || '').trim() === '笔记',
                    );
                    if (notesTab) notesTab.click();
                    await new Promise((r) => setTimeout(r, 250));
                    const saveBtnShown = [...document.querySelectorAll('button')].some(
                      (b) =>
                        (b.getAttribute('title') || '').includes('保存') ||
                        (b.textContent || '').trim() === '保存',
                    );
                    const shotBtn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('拖拽框选') || (b.textContent || '').trim() === '截图');
                    if (!shotBtn) return { btn: false };
                    shotBtn.click();
                    await new Promise((r) => setTimeout(r, 250));
                    const overlay = [...document.querySelectorAll('div')].find((el) => (el.className || '').includes('cursor-crosshair'));
                    if (!overlay) return { btn: true, overlayShown: false };
                    const exitBtnShown = [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim().startsWith('退出'));
                    // 先验证右上角常驻「退出」按钮可以退出截图模式
                    let exitWorks = false;
                    const exitBtn1 = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('退出'));
                    if (exitBtn1) {
                      exitBtn1.click();
                      await new Promise((r) => setTimeout(r, 250));
                      exitWorks = ![...document.querySelectorAll('div')].some((el) => (el.className || '').includes('cursor-crosshair'));
                    }
                    if (!exitWorks) return { btn: true, overlayShown: true, exitBtnShown, exitWorks };
                    // 重新进入截图模式并完成一次框选插入
                    const shotBtn2 = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('拖拽框选') || (b.textContent || '').trim() === '截图');
                    if (shotBtn2) shotBtn2.click();
                    await new Promise((r) => setTimeout(r, 600));
                    const overlay2 = [...document.querySelectorAll('div')].find((el) => (el.className || '').includes('cursor-crosshair'));
                    if (!overlay2) return { btn: true, overlayShown: true, exitBtnShown, exitWorks, reenter: false };
                    const or2 = overlay2.getBoundingClientRect();
                    overlay2.dispatchEvent(new MouseEvent('mousedown', { clientX: or2.left + 100, clientY: or2.top + 100, bubbles: true }));
                    window.dispatchEvent(new MouseEvent('mousemove', { clientX: or2.left + 320, clientY: or2.top + 240, bubbles: true }));
                    window.dispatchEvent(new MouseEvent('mouseup', { clientX: or2.left + 320, clientY: or2.top + 240, bubbles: true }));
                    await new Promise((r) => setTimeout(r, 300));
                    const insertBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '插入笔记');
                    const barShown = !!insertBtn;
                    const maskPersist = [...document.querySelectorAll('div')].some(
                      (el) => (el.style.boxShadow || '').includes('100vmax'),
                    );
                    // 框定后：拖动选区内部移动，拖右下角手柄调整大小
                    let moved = false;
                    let resized = false;
                    const selDiv = [...document.querySelectorAll('div')].find(
                      (el) => (el.style.boxShadow || '').includes('100vmax'),
                    );
                    if (selDiv) {
                      const sr = selDiv.getBoundingClientRect();
                      const sx = sr.left + sr.width / 2;
                      const sy = sr.top + sr.height / 2;
                      selDiv.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: sx, clientY: sy, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 80));
                      window.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + 50, clientY: sy + 40, bubbles: true }));
                      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                      await new Promise((r) => setTimeout(r, 150));
                      const sr2 = selDiv.getBoundingClientRect();
                      moved = Math.abs(sr2.left - sr.left) > 2 || Math.abs(sr2.top - sr.top) > 2;
                      const seHandle = [...selDiv.querySelectorAll('div')].find(
                        (d) => d.style.right === '-4px' && d.style.bottom === '-4px',
                      );
                      if (seHandle) {
                        const hr = seHandle.getBoundingClientRect();
                        seHandle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: hr.left + 1, clientY: hr.top + 1, bubbles: true, cancelable: true }));
                        await new Promise((r) => setTimeout(r, 80));
                        window.dispatchEvent(new MouseEvent('mousemove', { clientX: hr.left + 70, clientY: hr.top + 50, bubbles: true }));
                        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                        await new Promise((r) => setTimeout(r, 150));
                        const sr3 = selDiv.getBoundingClientRect();
                        resized = sr3.width > sr2.width + 2 && sr3.height > sr2.height + 2;
                      }
                    }
                    if (insertBtn) insertBtn.click();
                    await new Promise((r) => setTimeout(r, 1000));
                    const note = await window.pkm.getNote(a.id);
                    const inserted = !!(note && note.markdown.includes('assets/'));
                    return { btn: true, overlayShown: true, exitBtnShown, exitWorks, reenter: true, barShown, maskPersist, moved, resized, inserted, saveBtnShown };
                  })()
                `);
                console.log('[capture] shotDiag', JSON.stringify(shotDiag));
                // README 配图 3：图文笔记（笔记面板 + 截图插入 + LaTeX）
                await new Promise((r) => setTimeout(r, 400));
                const shotNotes = await win.webContents.capturePage();
                fs.writeFileSync(path.join(picDir, 'shot-notes.png'), shotNotes.toPNG());
                console.log('[capture] saved pic/shot-notes.png');
                // 知识库自动折叠开关：开启后打开 PDF 自动收起，悬停左边缘临时展开，移出自动收起
                const autoHideDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!a) return { pdf: false };
                    await window.pkm.updateSettings({ autoCollapseSidebar: true });
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    await new Promise((r) => setTimeout(r, 400));
                    window.__pkmAct('clearScreens');
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 900));
                    const collapsedAfterOpen = window.__pkmStore().sidebarCollapsed;
                    // 悬停左侧折叠栏 → 临时展开
                    let hoverExpands = false;
                    const rail = [...document.querySelectorAll('aside')].find(
                      (as) => (as.className || '').includes('w-11') && (as.className || '').includes('shrink-0'),
                    );
                    if (rail) {
                      rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
                      await new Promise((r) => setTimeout(r, 350));
                      hoverExpands = window.__pkmStore().sidebarCollapsed === false;
                    }
                    // 移出侧栏 → 自动收起
                    let leaveCollapses = false;
                    const aside = document.querySelector('[data-panel="sidebar"]');
                    if (aside) {
                      aside.dispatchEvent(
                        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
                      );
                      await new Promise((r) => setTimeout(r, 500));
                      leaveCollapses = window.__pkmStore().sidebarCollapsed === true;
                    }
                    // 恢复现场：关闭设置、展开侧栏
                    await window.pkm.updateSettings({ autoCollapseSidebar: false });
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    window.__pkmAct('clearScreens');
                    window.__pkmAct('setSidebarCollapsed', false);
                    await new Promise((r) => setTimeout(r, 200));
                    return { collapsedAfterOpen, railFound: !!rail, hoverExpands, asideFound: !!aside, leaveCollapses };
                  })()
                `);
                console.log('[capture] autoHideDiag', JSON.stringify(autoHideDiag));
                // 拖拽导入反馈：文件夹高亮放大、离开清除、无全屏虚化遮罩
                const dragDropDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    let folder = snap.folders.find((f) => f.name === '拖放测试');
                    if (!folder) {
                      const snap0 = await window.pkm.getSnapshot();
                      const rootId0 = snap0.libraries && snap0.libraries[0]
                        ? snap0.libraries[0].rootFolderId
                        : null;
                      folder = await window.pkm.createFolder('拖放测试', rootId0);
                    }
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    await new Promise((r) => setTimeout(r, 300));
                    if (!folder) return { folder: false };
                    const dt = new DataTransfer();
                    dt.items.add(new File(['x'], 'drag-test.pdf', { type: 'application/pdf' }));
                    const el = [...document.querySelectorAll('[role="treeitem"]')].find(
                      (n) => (n.textContent || '').includes(folder.name),
                    );
                    if (!el) return { row: false };
                    el.dispatchEvent(
                      new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }),
                    );
                    await new Promise((r) => setTimeout(r, 120));
                    const highlighted =
                      (el.className || '').includes('scale-') &&
                      (el.className || '').includes('ring-1 ring-app-accent');
                    el.dispatchEvent(
                      new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: document.body }),
                    );
                    await new Promise((r) => setTimeout(r, 120));
                    const cleared = !(el.className || '').includes('ring-1 ring-app-accent');
                    const noBlurOverlay = ![...document.querySelectorAll('div')].some(
                      (d) =>
                        (d.className || '').includes('backdrop-blur') &&
                        (d.className || '').includes('fixed'),
                    );
                    try {
                      await window.pkm.deleteFolder(folder.id);
                      if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    } catch {
                      /* ignore */
                    }
                    return { folder: true, row: !!el, highlighted, cleared, noBlurOverlay };
                  })()
                `);
                console.log('[capture] dragDropDiag', JSON.stringify(dragDropDiag));
                const hlMergeDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!a) return { pdf: false };
                    window.__pkmOpenPdf(a.id);
                    await new Promise((r) => setTimeout(r, 2000));
                    const hlBtn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('高亮模式'));
                    if (!hlBtn) return { hlBtn: false };
                    hlBtn.click();
                    await new Promise((r) => setTimeout(r, 150));
                    const spans = [...document.querySelectorAll('.textLayer span')].filter((s) => (s.textContent || '').trim());
                    if (spans.length < 2) return { spans: spans.length };
                    const before = await window.pkm.listAnnotations(a.id);
                    const sc = document.querySelector('[data-pan-scroll]');
                    const r0 = spans[0].getBoundingClientRect();
                    const r1 = spans[spans.length - 1].getBoundingClientRect();
                    sc.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: r0.left + 2, clientY: r0.top + r0.height / 2, bubbles: true, cancelable: true }));
                    await new Promise((r) => setTimeout(r, 120));
                    window.dispatchEvent(new MouseEvent('mousemove', { clientX: r1.left + 2, clientY: r1.top + r1.height / 2, bubbles: true }));
                    await new Promise((r) => setTimeout(r, 200));
                    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true }));
                    await new Promise((r) => setTimeout(r, 900));
                    const after = await window.pkm.listAnnotations(a.id);
                    const added = after.filter((x) => !before.some((y) => y.id === x.id));
                    let quads = null;
                    if (added.length === 1) {
                      try { quads = JSON.parse(added[0].position); } catch { quads = null; }
                    }
                    return { hlBtn: true, spans: spans.length, added: added.length, quads: quads ? quads.length : null, oneBlock: !!quads && quads.length === 1 };
                  })()
                `);
                console.log('[capture] hlMergeDiag', JSON.stringify(hlMergeDiag));
                // 临时诊断：中英混排 PDF 整行拖选是否只出一个连续色块
                if (process.env.PKM_TEST_PDF) {
                  const cjkHlDiag = await win.webContents.executeJavaScript(`
                    (async () => {
                      const p = ${JSON.stringify(process.env.PKM_TEST_PDF)};
                      if (window.__pkmAct) window.__pkmAct('clearScreens');
                      await new Promise((r) => setTimeout(r, 200));
                      await window.pkm.importPdfs([p], null);
                      const snap = await window.pkm.getSnapshot();
                      const pdf = snap.pdfs.find((x) => x.filepath.includes('Submission') || x.filepath.includes('感受野') || x.filepath.includes('英语'));
                      if (!pdf) return { pdf: false };
                      window.__pkmOpenPdf(pdf.id);
                      await new Promise((r) => setTimeout(r, 2500));
                      const hlBtn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('高亮模式'));
                      if (!hlBtn) return { hlBtn: false };
                      hlBtn.click();
                      await new Promise((r) => setTimeout(r, 200));
                      const sc = document.querySelector('[data-pan-scroll]');
                      const sheet = document.querySelector('.pdf-page-sheet');
                      const spans = [...sheet.querySelectorAll('.textLayer span')].filter((s) => (s.textContent || '').trim());
                      const rows = new Map();
                      for (const s of spans) {
                        const r = s.getBoundingClientRect();
                        const key = Math.round(r.top);
                        if (!rows.has(key)) rows.set(key, []);
                        rows.get(key).push(s);
                      }
                      const firstRow = [...rows.values()].find((arr) => arr.length >= 2);
                      if (!firstRow) return { spans: spans.length, rows: rows.size };
                      const rA = firstRow[0].getBoundingClientRect();
                      const rB = firstRow[firstRow.length - 1].getBoundingClientRect();
                      const before = await window.pkm.listAnnotations(pdf.id);
                      sc.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: rA.left + 1, clientY: rA.top + rA.height / 2, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 120));
                      window.dispatchEvent(new MouseEvent('mousemove', { clientX: rB.left + 2, clientY: rB.top + rB.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 200));
                      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 900));
                      const after = await window.pkm.listAnnotations(pdf.id);
                      const added = after.filter((x) => !before.some((y) => y.id === x.id));
                      let quads = null;
                      if (added.length === 1) {
                        try { quads = JSON.parse(added[0].position); } catch { quads = null; }
                      }
                      // 跨行测试：从第 1 行首拖到第 3 行末，应每行一块、共 3 块
                      const rowsArr = [...rows.values()].sort((a, b) => a[0].getBoundingClientRect().top - b[0].getBoundingClientRect().top);
                      let crossQuads = null;
                      if (rowsArr.length >= 3) {
                        const r1 = rowsArr[0][0].getBoundingClientRect();
                        const r3 = rowsArr[2][rowsArr[2].length - 1].getBoundingClientRect();
                        const before2 = await window.pkm.listAnnotations(pdf.id);
                        sc.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: r1.left + 1, clientY: r1.top + r1.height / 2, bubbles: true, cancelable: true }));
                        await new Promise((r) => setTimeout(r, 120));
                        window.dispatchEvent(new MouseEvent('mousemove', { clientX: r3.left + 2, clientY: r3.top + r3.height / 2, bubbles: true }));
                        await new Promise((r) => setTimeout(r, 200));
                        window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true }));
                        await new Promise((r) => setTimeout(r, 900));
                        const after2 = await window.pkm.listAnnotations(pdf.id);
                        const added2 = after2.filter((x) => !before2.some((y) => y.id === x.id));
                        if (added2.length === 1) {
                          try { crossQuads = JSON.parse(added2[0].position); } catch { crossQuads = null; }
                        }
                      }
                      return {
                        pdf: true,
                        spans: spans.length,
                        rows: rows.size,
                        added: added.length,
                        oneLineOneBlock: !!quads && quads.length === 1,
                        quadWidths: quads ? quads.map((q) => Math.round(q.w)) : null,
                        crossLines: crossQuads ? crossQuads.length : null,
                      };
                    })()
                  `);
                  console.log('[capture] cjkHlDiag', JSON.stringify(cjkHlDiag));
                }
                // 交互修复验证：单击不生成高亮；选中高亮后 Delete 可删除
                if (process.env.PKM_TEST_PDF) {
                  const hlFixDiag = await win.webContents.executeJavaScript(`
                    (async () => {
                      const p = ${JSON.stringify(process.env.PKM_TEST_PDF)};
                      if (window.__pkmAct) window.__pkmAct('clearScreens');
                      await new Promise((r) => setTimeout(r, 200));
                      await window.pkm.importPdfs([p], null);
                      const snap = await window.pkm.getSnapshot();
                      const pdf = snap.pdfs.find((x) => x.filepath.includes('Submission') || x.filepath.includes('感受野') || x.filepath.includes('英语'));
                      if (!pdf) return { pdf: false };
                      window.__pkmOpenPdf(pdf.id);
                      await new Promise((r) => setTimeout(r, 2500));
                      const hlBtn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('高亮模式'));
                      if (!hlBtn) return { hlBtn: false };
                      hlBtn.click();
                      await new Promise((r) => setTimeout(r, 200));
                      const sc = document.querySelector('[data-pan-scroll]');
                      const span = [...document.querySelectorAll('.textLayer span')].find((s) => (s.textContent || '').trim());
                      const sr = span.getBoundingClientRect();
                      const before = await window.pkm.listAnnotations(pdf.id);
                      // 1) 单击（无移动）不应生成高亮
                      sc.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: sr.left + 4, clientY: sr.top + sr.height / 2, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 100));
                      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, clientX: sr.left + 4, clientY: sr.top + sr.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 700));
                      const afterClick = await window.pkm.listAnnotations(pdf.id);
                      const clickAdded = afterClick.filter((x) => !before.some((y) => y.id === x.id)).length;
                      // 2) 拖拽一行生成高亮
                      sc.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: sr.left + 2, clientY: sr.top + sr.height / 2, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 100));
                      window.dispatchEvent(new MouseEvent('mousemove', { clientX: sr.left + 180, clientY: sr.top + sr.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 200));
                      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, clientX: sr.left + 180, clientY: sr.top + sr.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 900));
                      const afterDrag = await window.pkm.listAnnotations(pdf.id);
                      const dragAdded = afterDrag.filter((x) => !afterClick.some((y) => y.id === x.id));
                      // 3) 点击色块选中，Delete 删除
                      let deleted = false;
                      if (dragAdded.length === 1) {
                        const hl = document.querySelector('.annotation-hl');
                        if (hl) {
                          hl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                          await new Promise((r) => setTimeout(r, 200));
                          const selBefore = !!document.querySelector('.annotation-hl.selected');
                          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
                          await new Promise((r) => setTimeout(r, 700));
                          const afterDel = await window.pkm.listAnnotations(pdf.id);
                          deleted = selBefore && !afterDel.some((x) => x.id === dragAdded[0].id);
                        }
                      }
                      return { pdf: true, clickAdded, dragAdded: dragAdded.length, deleted };
                    })()
                  `);
                  console.log('[capture] hlFixDiag', JSON.stringify(hlFixDiag));
                }
                // 普通模式连续选区验证：拖拽出蓝色选区，点空白清除
                if (process.env.PKM_TEST_PDF) {
                  const selDiag = await win.webContents.executeJavaScript(`
                    (async () => {
                      const p = ${JSON.stringify(process.env.PKM_TEST_PDF)};
                      if (window.__pkmAct) window.__pkmAct('clearScreens');
                      await new Promise((r) => setTimeout(r, 200));
                      await window.pkm.importPdfs([p], null);
                      const snap = await window.pkm.getSnapshot();
                      const pdf = snap.pdfs.find((x) => x.filepath.includes('Submission') || x.filepath.includes('感受野') || x.filepath.includes('英语'));
                      if (!pdf) return { pdf: false };
                      window.__pkmOpenPdf(pdf.id);
                      await new Promise((r) => setTimeout(r, 2500));
                      const sc = document.querySelector('[data-pan-scroll]');
                      const span = [...document.querySelectorAll('.textLayer span')].find((s) => (s.textContent || '').trim());
                      const sr = span.getBoundingClientRect();
                      // 高亮按钮应处于关闭状态（普通模式）
                      const hlBtn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('高亮模式'));
                      const hlActive = hlBtn ? (hlBtn.className || '').includes('active') || (hlBtn.getAttribute('aria-pressed') === 'true') : false;
                      sc.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: sr.left + 2, clientY: sr.top + sr.height / 2, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 120));
                      window.dispatchEvent(new MouseEvent('mousemove', { clientX: sr.left + 180, clientY: sr.top + sr.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 200));
                      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, clientX: sr.left + 180, clientY: sr.top + sr.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 400));
                      const selCount = document.querySelectorAll('.selection-highlight').length;
                      // 点空白清除选区
                      const scRect = sc.getBoundingClientRect();
                      sc.dispatchEvent(new MouseEvent('click', { clientX: scRect.left + 10, clientY: scRect.top + 10, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 300));
                      const afterClear = document.querySelectorAll('.selection-highlight').length;
                      return { pdf: true, hlActive, selCount, afterClear };
                    })()
                  `);
                  console.log('[capture] selDiag', JSON.stringify(selDiag));
                }
                // 标注流程验证：右键添加标注 -> 保存 -> 圆点出现 -> 点击圆点弹窗
                if (process.env.PKM_TEST_PDF) {
                  const noteDiag = await win.webContents.executeJavaScript(`
                    (async () => {
                      const p = ${JSON.stringify(process.env.PKM_TEST_PDF)};
                      if (window.__pkmAct) window.__pkmAct('clearScreens');
                      await new Promise((r) => setTimeout(r, 200));
                      await window.pkm.importPdfs([p], null);
                      const snap = await window.pkm.getSnapshot();
                      const pdf = snap.pdfs.find((x) => x.filepath.includes('Submission') || x.filepath.includes('感受野') || x.filepath.includes('英语'));
                      if (!pdf) return { pdf: false };
                      window.__pkmOpenPdf(pdf.id);
                      await new Promise((r) => setTimeout(r, 2500));
                      const hlBtn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('高亮模式'));
                      if (!hlBtn) return { hlBtn: false };
                      hlBtn.click();
                      await new Promise((r) => setTimeout(r, 200));
                      const sc = document.querySelector('[data-pan-scroll]');
                      const span = [...document.querySelectorAll('.textLayer span')].find((s) => (s.textContent || '').trim());
                      const sr = span.getBoundingClientRect();
                      // 拖一行生成高亮
                      sc.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: sr.left + 2, clientY: sr.top + sr.height / 2, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 120));
                      window.dispatchEvent(new MouseEvent('mousemove', { clientX: sr.left + 180, clientY: sr.top + sr.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 200));
                      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, clientX: sr.left + 180, clientY: sr.top + sr.height / 2, bubbles: true }));
                      await new Promise((r) => setTimeout(r, 900));
                      const hl = document.querySelector('.annotation-hl');
                      if (!hl) return { hl: false };
                      // 右键 -> 添加标注
                      const hr = hl.getBoundingClientRect();
                      hl.dispatchEvent(new MouseEvent('contextmenu', { clientX: hr.left + 10, clientY: hr.top + 10, bubbles: true, cancelable: true }));
                      await new Promise((r) => setTimeout(r, 300));
                      const addBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '添加标注');
                      let popupOpened = false;
                      if (addBtn) { addBtn.click(); await new Promise((r) => setTimeout(r, 300)); }
                      const popup = [...document.querySelectorAll('div')].find((d) => String(d.className || '').includes('z-[80]'));
                      popupOpened = !!popup;
                      let saved = false;
                      if (popup) {
                        const ta = popup.querySelector('textarea');
                        if (ta) {
                          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                          setter.call(ta, '测试标注内容');
                          ta.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        const saveBtn = [...popup.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存');
                        if (saveBtn) { saveBtn.click(); await new Promise((r) => setTimeout(r, 900)); }
                        const after = await window.pkm.listAnnotations(pdf.id);
                        saved = after.some((x) => (x.note || '').includes('测试标注'));
                      }
                      const dot = document.querySelector('.annotation-dot');
                      const dotTitle = dot ? dot.getAttribute('title') : null;
                      let dotOpensPopup = false;
                      if (dot) {
                        const dr = dot.getBoundingClientRect();
                        dot.dispatchEvent(new MouseEvent('click', { clientX: dr.left + 2, clientY: dr.top + 2, bubbles: true, cancelable: true }));
                        await new Promise((r) => setTimeout(r, 300));
                        dotOpensPopup = [...document.querySelectorAll('div')].some((d) => String(d.className || '').includes('z-[80]'));
                      }
                      return { pdf: true, popupOpened, saved, dot: !!dot, dotTitle, dotOpensPopup };
                    })()
                  `);
                  console.log('[capture] noteDiag', JSON.stringify(noteDiag));
                }
                // 删除 PDF 后，已打开的标签页应被自动清理（含分屏）
                const deleteTabDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!a) return { pdf: false };
                    window.__pkmAct('clearScreens');
                    window.__pkmOpenPdf(a.id);
                    window.__pkmAct('openPdfInNewTab', a.id);
                    await new Promise((r) => setTimeout(r, 300));
                    await window.pkm.deletePdf(a.id);
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    await new Promise((r) => setTimeout(r, 300));
                    const st = window.__pkmStore();
                    const gone = !st.screens.some((sc) => sc.tabs.some((t) => t.pdfId === a.id));
                    return { pdf: true, gone, screensLeft: st.screens.length };
                  })()
                `);
                console.log('[capture] deleteTabDiag', JSON.stringify(deleteTabDiag));
                // 临时区删除：inboxRemove 后 refresh 应清理指向该文件的标签页
                const inboxTabDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const testPath = ${JSON.stringify(testPdfPath)};
                    await window.pkm.importPdfs([testPath], null);
                    const snap = await window.pkm.getSnapshot();
                    const a = snap.pdfs.find((p) => p.filename === 'smoke-test.pdf');
                    if (!a) return { pdf: false };
                    const inboxItem = await window.pkm.inboxAdd(a.filepath);
                    if (typeof window.__pkmAct === 'function') window.__pkmAct('clearScreens');
                    window.__pkmOpenPdf(inboxItem.id);
                    await new Promise((r) => setTimeout(r, 300));
                    await window.pkm.inboxRemove(inboxItem.id);
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    await new Promise((r) => setTimeout(r, 300));
                    const st = window.__pkmStore();
                    const gone = !st.screens.some((sc) => sc.tabs.some((t) => t.pdfId === inboxItem.id));
                    return { pdf: true, inbox: !!inboxItem, gone, screensLeft: st.screens.length };
                  })()
                `);
                console.log('[capture] inboxTabDiag', JSON.stringify(inboxTabDiag));
                // 外部 PDF 桥：主进程发送 app:external-pdf，渲染进程应复制进临时区
                win.webContents.send('app:external-pdf', testPdfPath);
                await new Promise((r) => setTimeout(r, 2500));
                const externalDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const inbox = await window.pkm.inboxList();
                    const hit = inbox.find(
                      (p) => p.filename === 'smoke-test.pdf' &&
                        p.filepath.toLowerCase().indexOf('\\\\inbox\\\\') > -1,
                    );
                    if (hit) await window.pkm.inboxRemove(hit.id);
                    return { found: !!hit };
                  })()
                `);
                console.log('[capture] externalDiag', JSON.stringify(externalDiag));
                // 外部 PDF 首次打开渲染：精确复现 inboxAdd → refresh → openPdf
                win.webContents.send('app:external-pdf', testPdfPath);
                await new Promise((r) => setTimeout(r, 4000));
                const externalRenderDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const st = window.__pkmStore();
                    const canvas = document.querySelector('[data-pan-scroll] canvas');
                    const loading = !!document.querySelector('[data-testid="pdf-loading"]');
                    const painted = canvas ? canvas.width > 0 : false;
                    const inbox = await window.pkm.inboxList();
                    for (const p of inbox) await window.pkm.inboxRemove(p.id);
                    return {
                      activePdfId: st.activePdfId,
                      screens: st.screens.length,
                      painted,
                      canvasW: canvas ? canvas.width : 0,
                      loading,
                    };
                  })()
                `);
                console.log('[capture] externalRenderDiag', JSON.stringify(externalRenderDiag));
                // Chromium IntersectionObserver 对 0 尺寸元素的行为（首屏死锁排查）
                const zeroSizeDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const el = document.createElement('div');
                    el.style.width = '0px';
                    el.style.height = '0px';
                    el.style.position = 'fixed';
                    el.style.top = '100px';
                    el.style.left = '100px';
                    document.body.appendChild(el);
                    const res = await new Promise((resolve) => {
                      const io = new IntersectionObserver((entries) => {
                        io.disconnect();
                        resolve(entries[0] ? entries[0].isIntersecting : null);
                      }, {});
                      io.observe(el);
                    });
                    el.remove();
                    return { zeroSizeIntersecting: res };
                  })()
                `);
                console.log('[capture] zeroSizeDiag', JSON.stringify(zeroSizeDiag));
                // 知识库文件总数：应包含子文件夹里的 PDF
                const countDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const lib = await window.pkm.createLibrary('CountLib');
                    const sub = await window.pkm.createFolder('Sub', lib.rootFolderId);
                    const testPath = ${JSON.stringify(testPdfPath)};
                    await window.pkm.importPdfs([testPath], sub.id);
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    await new Promise((r) => setTimeout(r, 600));
                    const row = [...document.querySelectorAll('[data-panel="sidebar"] [role="treeitem"]')].find(
                      (el) => (el.textContent || '').includes('CountLib'),
                    );
                    const m = row ? /(\\d+)\\s*个文件/.exec(row.textContent || '') : null;
                    const ok = !!m && m[1] === '1';
                    await window.pkm.deleteLibrary(lib.id);
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    return { row: !!row, count: m ? m[1] : null, ok, rowText: (row ? row.textContent || '' : '').slice(0, 80) };
                  })()
                `);
                console.log('[capture] countDiag', JSON.stringify(countDiag));
                // 目录树弹窗：空白区右键 → 新建子文件夹 → 折叠/展开/选中高亮
                const pickerDiag = await win.webContents.executeJavaScript(`
                  (async () => {
                    const lib = await window.pkm.createLibrary('PickerLib');
                    const outer = await window.pkm.createFolder('Outer', lib.rootFolderId);
                    await window.pkm.createFolder('Inner', outer.id);
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    await new Promise((r) => setTimeout(r, 500));
                    const sidebar = document.querySelector('[data-panel="sidebar"]');
                    const scroll = sidebar && sidebar.querySelector('.overflow-y-auto');
                    if (!scroll) return { lib: !!lib, scroll: false };
                    const rect = scroll.getBoundingClientRect();
                    scroll.dispatchEvent(new MouseEvent('contextmenu', {
                      bubbles: true, cancelable: true,
                      clientX: rect.left + 30, clientY: rect.bottom - 20,
                    }));
                    await new Promise((r) => setTimeout(r, 250));
                    const menuBtn = [...document.querySelectorAll('button')].find(
                      (b) => (b.textContent || '').includes('新建子文件夹'),
                    );
                    if (!menuBtn) return { lib: !!lib, menu: false };
                    menuBtn.click();
                    await new Promise((r) => setTimeout(r, 350));
                    const modal = [...document.querySelectorAll('.fixed')].find(
                      (el) => (el.className || '').includes('z-50') &&
                        (el.textContent || '').includes('选择新建在哪个知识库'),
                    );
                    if (!modal) return { lib: !!lib, menu: true, modal: false };
                    const rows = (name) => [...modal.querySelectorAll('div')].filter(
                      (d) => (d.className || '').includes('cursor-pointer') &&
                        (d.textContent || '').trim() === name,
                    );
                    const libRow = rows('PickerLib')[0];
                    const outerVisible = rows('Outer').length > 0;
                    // 用完整鼠标事件序列模拟真实点击
                    const realClick = (el) => {
                      const r = el.getBoundingClientRect();
                      const cx = r.left + r.width / 2;
                      const cy = r.top + r.height / 2;
                      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
                      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
                      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
                    };
                    const rowHtml = libRow ? (libRow.outerHTML || '').slice(0, 120) : '';
                    if (libRow) realClick(libRow);
                    await new Promise((r) => setTimeout(r, 120));
                    const outerCountImmediate = rows('Outer').length;
                    await new Promise((r) => setTimeout(r, 250));
                    const outerCollapsed = outerVisible && rows('Outer').length === 0;
                    if (libRow) realClick(libRow);
                    await new Promise((r) => setTimeout(r, 300));
                    const outerExpandedAgain = rows('Outer').length > 0;
                    const outerRow = rows('Outer')[0];
                    if (outerRow) realClick(outerRow);
                    await new Promise((r) => setTimeout(r, 300));
                    const innerVisible = rows('Inner').length > 0;
                    const selectedHighlight = outerRow
                      ? (outerRow.className || '').includes('bg-app-accent')
                      : false;
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    await new Promise((r) => setTimeout(r, 200));
                    await window.pkm.deleteLibrary(lib.id);
                    if (typeof window.__pkmRefresh === 'function') await window.__pkmRefresh();
                    return {
                      lib: !!lib,
                      menu: true,
                      modal: true,
                      libRow: !!libRow,
                      outerVisible,
                      outerCountImmediate,
                      outerCollapsed,
                      outerExpandedAgain,
                      innerVisible,
                      selectedHighlight,
                      rowHtml,
                    };
                  })()
                `);
                console.log('[capture] pickerDiag', JSON.stringify(pickerDiag));
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
  elapsed('app-whenReady');
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection', reason);
  });
  if (smokeTest) {
    // 冒烟测试使用临时文档目录，避免污染用户真实知识库
    const smokeDocs = path.join(app.getPath('temp'), 'pkm-smoke-docs');
    // Windows 上被杀进程可能短暂持有文件句柄，带重试的清理更稳妥
    for (let i = 0; i < 8; i++) {
      try {
        fs.rmSync(smokeDocs, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 7) throw err;
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
          /* 等待文件锁释放 */
        }
      }
    }
    app.setPath('documents', smokeDocs);
  }
  registerIpc();
  console.log('[main] ipc registered');
  elapsed('ipc-registered');
  initDatabase();
  console.log('[main] database initialized');
  elapsed('db-initialized');
  if (!smokeTest) {
    // 旧版本安装包强写过的 .pdf 关联，只要用户没主动开启就自动撤销
    void ensureNoForcedPdfAssociation();
  }
  startLibraryWatcher(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:changed');
    }
  });
  console.log('[main] library watcher started');
  elapsed('watcher-started');

  if (!smokeTest) splashWindow = createSplash();
  elapsed('splash-created');
  await createMainWindow();
  console.log('[main] main window created');
  elapsed('main-window-created');

  // 启动时若由系统以默认 PDF 应用唤起，把文件交给渲染进程做临时预览
  if (!smokeTest) {
    externalPdfs.push(...pdfFromArgv(process.argv.slice(1)));
    flushExternalPdfs();
    // 兜底：渲染进程就绪信号万一丢失，稍后仍尝试派发一次
    setTimeout(flushExternalPdfs, 3000);
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
  pdfiumShutdown();
  closeDb();
});

// 供 window 控制 IPC 使用
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
