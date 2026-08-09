// 验证 PDFium 对 /Rotate 90 页面的尺寸与渲染行为（与 PDF.js 保持一致）
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

const outDir = join(process.cwd(), 'benchmark', 'out');
const pdfPath = join(outDir, 'rotated-test.pdf');

// 构造带 /Rotate 90 的单页 PDF（612x792 -> 显示尺寸 792x612）
const content = 'BT /F1 20 Tf 72 720 Td (Rotated Hello) Tj ET';
const objs = {
  1: '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  2: '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  3: '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  4: `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream\nendobj\n`,
  5: '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
};
let pdf = '%PDF-1.4\n';
const offs = {};
for (const i of Object.keys(objs).map(Number).sort((a, b) => a - b)) {
  offs[i] = Buffer.byteLength(pdf, 'latin1');
  pdf += objs[i];
}
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += 'xref\n0 6\n0000000000 65535 f \n';
for (let i = 1; i <= 5; i++) pdf += `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(pdfPath, pdf, 'latin1');

const lib = koffi.load(join(process.cwd(), 'resources', 'pdfium', 'win-x64', 'bin', 'pdfium.dll'));
const FS_SIZEF = koffi.struct('FS_SIZEF', { width: 'float', height: 'float' });
const api = {
  init: lib.func('void FPDF_InitLibrary()'),
  loadDoc: lib.func('void *FPDF_LoadDocument(const char *path, const char *password)'),
  loadPage: lib.func('void *FPDF_LoadPage(void *doc, int index)'),
  closePage: lib.func('void FPDF_ClosePage(void *page)'),
  closeDoc: lib.func('void FPDF_CloseDocument(void *doc)'),
  destroyLib: lib.func('void FPDF_DestroyLibrary()'),
  pageSizeByIndex: lib.func('int FPDF_GetPageSizeByIndexF(void *doc, int index, FS_SIZEF *size)'),
  widthF: lib.func('float FPDF_GetPageWidthF(void *page)'),
  heightF: lib.func('float FPDF_GetPageHeightF(void *page)'),
  createBitmap: lib.func('void *FPDFBitmap_CreateEx(int w, int h, int format, void *first, int stride)'),
  destroyBitmap: lib.func('void FPDFBitmap_Destroy(void *bmp)'),
  fillRect: lib.func('int FPDFBitmap_FillRect(void *bmp, int left, int top, int w, int h, unsigned int color)'),
  getBuffer: lib.func('void *FPDFBitmap_GetBuffer(void *bmp)'),
  render: lib.func('void FPDF_RenderPageBitmap(void *bmp, void *page, int x, int y, int sx, int sy, int rotate, int flags)'),
};

api.init();
const doc = api.loadDoc(pdfPath, null);
const sizePtr = koffi.alloc(FS_SIZEF, 1);
api.pageSizeByIndex(doc, 0, sizePtr);
console.log('FPDF_GetPageSizeByIndexF (unrotated?):', koffi.decode(sizePtr, FS_SIZEF));

const page = api.loadPage(doc, 0);
console.log('FPDF_GetPageWidthF/HeightF:', api.widthF(page), api.heightF(page));
const scale = 2;
const w = Math.round(api.widthF(page) * scale);
const h = Math.round(api.heightF(page) * scale);
const stride = w * 4;
const bufPtr = koffi.alloc('uint8_t', stride * h);
const bmp = api.createBitmap(w, h, 4, bufPtr, stride);
api.fillRect(bmp, 0, 0, w, h, 0xffffffff);
api.render(bmp, page, 0, 0, w, h, 0, 0x13); // ANNOT | LCD_TEXT | REVERSE_BYTE_ORDER
const raw = koffi.decode(bufPtr, 'uint8_t', stride * h);
const canvas = createCanvas(w, h);
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(w, h);
img.data.set(raw);
ctx.putImageData(img, 0, 0);
writeFileSync(join(outDir, 'rotated-koffi.png'), canvas.toBuffer('image/png'));
console.log('rendered', w, 'x', h, '(expected 1584 x 1224 if rotation applied)');

api.closePage(page);
api.closeDoc(doc);
api.destroyLib();
koffi.free(sizePtr);
koffi.free(bufPtr);
