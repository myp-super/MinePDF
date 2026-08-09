// PDFium + koffi 冒烟测试：验证 DLL 加载、页面尺寸、渲染字节序与速度
// 用法: node scripts/pdfium-smoke.mjs <pdf路径> <scale>
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

const [pdfPath, scaleArg] = process.argv.slice(2);
const scale = parseFloat(scaleArg || '2');
const dllPath = join(process.cwd(), 'resources', 'pdfium', 'win-x64', 'bin', 'pdfium.dll');

const lib = koffi.load(dllPath);
const FS_SIZEF = koffi.struct('FS_SIZEF', { width: 'float', height: 'float' });

const api = {
  init: lib.func('void FPDF_InitLibrary()'),
  destroyLib: lib.func('void FPDF_DestroyLibrary()'),
  loadDoc: lib.func('void *FPDF_LoadDocument(const char *path, const char *password)'),
  pageCount: lib.func('int FPDF_GetPageCount(void *doc)'),
  loadPage: lib.func('void *FPDF_LoadPage(void *doc, int index)'),
  closePage: lib.func('void FPDF_ClosePage(void *page)'),
  closeDoc: lib.func('void FPDF_CloseDocument(void *doc)'),
  pageSize: lib.func('int FPDF_GetPageSizeByIndexF(void *doc, int index, FS_SIZEF *size)'),
  createBitmap: lib.func('void *FPDFBitmap_CreateEx(int w, int h, int format, void *first, int stride)'),
  destroyBitmap: lib.func('void FPDFBitmap_Destroy(void *bmp)'),
  getBuffer: lib.func('void *FPDFBitmap_GetBuffer(void *bmp)'),
  getWidth: lib.func('int FPDFBitmap_GetWidth(void *bmp)'),
  getHeight: lib.func('int FPDFBitmap_GetHeight(void *bmp)'),
  fillRect: lib.func('int FPDFBitmap_FillRect(void *bmp, int left, int top, int w, int h, unsigned int color)'),
  render: lib.func('void FPDF_RenderPageBitmap(void *bmp, void *page, int x, int y, int sx, int sy, int rotate, int flags)'),
};

api.init();
const doc = api.loadDoc(pdfPath, null);
if (!doc) {
  console.error('FPDF_LoadDocument failed');
  process.exit(1);
}

const count = api.pageCount(doc);
console.log('pageCount', count);

const sizePtr = koffi.alloc(FS_SIZEF, 1);
const okSize = api.pageSize(doc, 0, sizePtr);
const size = koffi.decode(sizePtr, FS_SIZEF);
console.log('pageSize (pts)', size.width, size.height, 'ok', okSize);

const page = api.loadPage(doc, 0);
if (!page) {
  console.error('FPDF_LoadPage failed');
  process.exit(1);
}

const w = Math.max(1, Math.round(size.width * scale));
const h = Math.max(1, Math.round(size.height * scale));

// 先填充纯红，验证内存字节序：ARGB 0xFFFF0000
let bmp = api.createBitmap(64, 64, 4, null, 0); // format 4 = BGRA
api.fillRect(bmp, 0, 0, 64, 64, 0xffff0000);
const redPtr = api.getBuffer(bmp);
const redBytes = koffi.decode(redPtr, 'uint8_t', 8);
console.log('fill-red first bytes (B,G,R,A expected if native BGRA):', Array.from(redBytes));
api.destroyBitmap(bmp);

// 正式渲染：外部缓冲 + BGRA + REVERSE_BYTE_ORDER => RGBA
const stride = w * 4;
const bufPtr = koffi.alloc('uint8_t', stride * h);
bmp = api.createBitmap(w, h, 4, bufPtr, stride);
api.fillRect(bmp, 0, 0, w, h, 0xffffffff);

const t0 = performance.now();
// 与主进程服务完全一致的标志位
const flags = 0x01 | 0x02 | 0x10 | 0x200;
api.render(bmp, page, 0, 0, w, h, 0, flags);
const dt = performance.now() - t0;
const raw = koffi.decode(bufPtr, 'uint8_t', stride * h);

// 通道均值：验证字节序（RGBA 时 R/G/B 均值应接近且白底为主）
let r = 0, g = 0, b = 0;
const n = w * h;
for (let i = 0; i < n; i++) {
  r += raw[i * 4];
  g += raw[i * 4 + 1];
  b += raw[i * 4 + 2];
}
console.log('render', w, 'x', h, 'ms', dt.toFixed(1), 'channel means R/G/B', (r / n).toFixed(1), (g / n).toFixed(1), (b / n).toFixed(1));

const canvas = createCanvas(w, h);
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(w, h);
img.data.set(raw);
ctx.putImageData(img, 0, 0);
const out = join(process.cwd(), 'benchmark', 'out', 'pdfium-smoke.png');
writeFileSync(out, canvas.toBuffer('image/png'));
console.log('saved', out);

api.closePage(page);
api.closeDoc(doc);
api.destroyLib();
koffi.free(sizePtr);
koffi.free(bufPtr);
