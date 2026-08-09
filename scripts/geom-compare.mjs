// 对比 PDF.js 与 PDFium 对同一 PDF 的页面几何（尺寸/viewBox）
// 用法: node scripts/geom-compare.mjs <pdf路径...>
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { join } from 'node:path';
import koffi from 'koffi';

const dllPath = join(process.cwd(), 'resources', 'pdfium', 'win-x64', 'bin', 'pdfium.dll');
const lib = koffi.load(dllPath);
const FS_SIZEF = koffi.struct('FS_SIZEF', { width: 'float', height: 'float' });
const api = {
  init: lib.func('void FPDF_InitLibrary()'),
  destroyLib: lib.func('void FPDF_DestroyLibrary()'),
  loadDoc: lib.func('void *FPDF_LoadDocument(const char *path, const char *password)'),
  closeDoc: lib.func('void FPDF_CloseDocument(void *doc)'),
  pageCount: lib.func('int FPDF_GetPageCount(void *doc)'),
  pageSize: lib.func('int FPDF_GetPageSizeByIndexF(void *doc, int index, FS_SIZEF *size)'),
};
api.init();

for (const pdfPath of process.argv.slice(2)) {
  const doc = api.loadDoc(pdfPath, null);
  if (!doc) {
    console.log(pdfPath, '-> pdfium open failed');
    continue;
  }
  const n = api.pageCount(doc);
  console.log(`\n=== ${pdfPath.split(/[\\/]/).pop()} (${n} pages) ===`);

  // PDFium 尺寸（每页）
  const sizePtr = koffi.alloc(FS_SIZEF, 1);
  const pdfiumSizes = [];
  for (let i = 0; i < Math.min(n, 12); i++) {
    api.pageSize(doc, i, sizePtr);
    const s = koffi.decode(sizePtr, FS_SIZEF);
    pdfiumSizes.push([s.width, s.height]);
  }
  api.closeDoc(doc);

  // PDF.js viewport 与 viewBox（每页）
  const pdoc = await getDocument({ data: new Uint8Array(await import('node:fs').then((m) => m.readFileSync(pdfPath))), disableWorker: true, isEvalSupported: false }).promise;
  const pnum = Math.min(pdoc.numPages, 12);
  for (let i = 1; i <= pnum; i++) {
    const page = await pdoc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const [pw, ph] = pdfiumSizes[i - 1];
    const dw = Math.abs(vp.width - pw);
    const dh = Math.abs(vp.height - ph);
    const flag = dw > 0.01 || dh > 0.01 ? '  <-- 不一致!' : '';
    console.log(
      `p${i} pdfjs=${vp.width.toFixed(2)}x${vp.height.toFixed(2)} view=${page.view?.join(',')} | pdfium=${pw.toFixed(2)}x${ph.toFixed(2)}${flag}`,
    );
    page.cleanup();
  }
  await pdoc.destroy();
}

api.destroyLib();
