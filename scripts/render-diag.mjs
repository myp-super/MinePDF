/**
 * PDFium 原始渲染诊断脚本（不经过 Electron/Canvas，直接验证 PDFium 位图质量）。
 *
 * 用法：
 *   node scripts/render-diag.mjs [pdf路径] [输出目录]
 *
 * 对第 1 页按 1x/2x/4x/8x 渲染并保存 PNG，输出每档位图尺寸与耗时，
 * 用于判断“模糊”发生在 PDFium 本身还是后面的 UI 链路。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import koffi from 'koffi';

const DLL =
  process.env.MINEPDF_PDFIUM_DLL ||
  path.resolve('resources/pdfium/win-x64/bin/pdfium.dll');

const FS_SIZEF = koffi.struct('FS_SIZEF', { width: 'float', height: 'float' });

function buildTestPdf() {
  // 小字号英文正文 + 细线 + 公式样式文本，用于检查文字/细线清晰度
  const objs = {};
  objs[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objs[2] = '2 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj\n';
  const body = [
    'BT /F2 9 Tf 54 720 Td (The quick brown fox jumps over the lazy dog 0123456789) Tj ET',
    'BT /F2 8 Tf 54 700 Td (Small text: Physics-Guided Metro Forecasting with Attention) Tj ET',
    'BT /F1 10 Tf 54 676 Td (Math: alpha beta theta integral sum x2 A-1) Tj ET',
    'BT /F2 9 Tf 54 652 Td (Tables | Lines | Vector | 4K | DPI | 125% | 150% | 200%) Tj ET',
    '54 640 m 560 640 l S',
    '54 636 m 560 636 l S',
    'BT /F2 7 Tf 54 620 Td (Tiny 7pt footnote text to stress subpixel rendering quality.) Tj ET',
  ].join('\n');
  const content = `${body}\n`;
  objs[5] =
    '5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    `/Contents 4 0 R /Resources << /Font << /F1 6 0 R /F2 7 0 R >> >> >>\nendobj\n`;
  objs[4] = `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream\nendobj\n`;
  objs[6] = '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>\nendobj\n';
  objs[7] = '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';

  let pdf = '%PDF-1.4\n';
  const offsets = {};
  const ids = Object.keys(objs)
    .map(Number)
    .sort((a, b) => a - b);
  for (const i of ids) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += objs[i];
  }
  const maxId = Math.max(...ids);
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) {
    pdf += offsets[i] != null ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ---------- 最小 PNG 编码器（RGBA -> PNG） ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function rgbaToPng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 量化文字带内的锐度：横向相邻像素梯度能量（越大越锐利） */
function edgeEnergy(w, h, rgba, y0, y1) {
  const lum = (i) => (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) / 255;
  let sum = 0;
  let n = 0;
  const yStart = Math.max(0, Math.min(h, Math.floor(y0)));
  const yEnd = Math.max(0, Math.min(h, Math.floor(y1)));
  for (let y = yStart; y < yEnd; y++) {
    const row = y * w * 4;
    for (let x = 1; x < w; x++) {
      const d = lum(row + x * 4) - lum(row + (x - 1) * 4);
      sum += d * d;
      n++;
    }
  }
  return n ? Math.sqrt(sum / n) * 1000 : 0;
}

/** 亚像素彩色边缘强度：LCD 文本边缘有明显 RGB 分色，灰度抗锯齿几乎为 0 */
function chromaEnergy(w, h, rgba, y0, y1) {
  const yStart = Math.max(0, Math.min(h, Math.floor(y0)));
  const yEnd = Math.max(0, Math.min(h, Math.floor(y1)));
  let sum = 0;
  let n = 0;
  for (let y = yStart; y < yEnd; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      sum += (mx - mn) * (mx - mn);
      n++;
    }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

// ---------- PDFium 加载（与 electron/services/pdfium.ts 同一套调用） ----------
// 3 = FPDFBitmap_BGRA（B,G,R,A）；4 = FPDFBitmap_BGRa（预乘 alpha，会关闭 LCD 文字）
const FPDFBitmap_BGRA = 3;
const FPDF_ANNOT = 0x01;
const FPDF_LCD_TEXT = 0x02;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const FPDF_RENDER_LIMITEDIMAGECACHE = 0x200;
const RENDER_FLAGS = FPDF_ANNOT | FPDF_LCD_TEXT | FPDF_REVERSE_BYTE_ORDER | FPDF_RENDER_LIMITEDIMAGECACHE;
const FLAG_SETS = {
  current: RENDER_FLAGS,
  noLCD: FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER | FPDF_RENDER_LIMITEDIMAGECACHE,
  noReverse: FPDF_ANNOT | FPDF_LCD_TEXT | FPDF_RENDER_LIMITEDIMAGECACHE,
  minimal: FPDF_ANNOT,
};

function renderPage(api, doc, pageIndex, scale, flags = RENDER_FLAGS, format = FPDFBitmap_BGRA) {
  const sizePtr = koffi.alloc(FS_SIZEF, 1);
  let pageW = 612;
  let pageH = 792;
  try {
    if (api.pageSize(doc, pageIndex, sizePtr)) {
      const s = koffi.decode(sizePtr, 'FS_SIZEF');
      pageW = s.width;
      pageH = s.height;
    }
  } finally {
    koffi.free(sizePtr);
  }
  const w = Math.max(1, Math.round(pageW * scale));
  const h = Math.max(1, Math.round(pageH * scale));
  const page = api.loadPage(doc, pageIndex);
  if (!page) throw new Error(`loadPage failed err=${api.getLastError()}`);
  const stride = w * 4;
  const bufPtr = koffi.alloc('uint8_t', stride * h);
  const bmp = api.createBitmap(w, h, format, bufPtr, stride);
  if (!bmp) throw new Error('createBitmap failed');
  const t0 = performance.now();
  try {
    api.fillRect(bmp, 0, 0, w, h, 0xffffffff);
    api.render(bmp, page, 0, 0, w, h, 0, flags);
    const ms = performance.now() - t0;
    const raw = koffi.decode(bufPtr, 'uint8_t', stride * h);
    const data = Buffer.from(raw);
    return { w, h, data, ms };
  } finally {
    api.destroyBitmap(bmp);
    api.closePage(page);
    koffi.free(bufPtr);
  }
}

async function main() {
  const pdfPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const outDir = path.resolve(process.argv[3] || 'pdfium-diag');
  fs.mkdirSync(outDir, { recursive: true });

  const tmpPdf = path.join(outDir, '_diag-input.pdf');
  if (pdfPath && fs.existsSync(pdfPath)) fs.copyFileSync(pdfPath, tmpPdf);
  else fs.writeFileSync(tmpPdf, buildTestPdf());

  const k = koffi.load(DLL);
  const api = {
    init: k.func('void FPDF_InitLibrary()'),
    destroyLib: k.func('void FPDF_DestroyLibrary()'),
    getLastError: k.func('unsigned int FPDF_GetLastError()'),
    loadDoc: k.func('void *FPDF_LoadDocument(const char *path, const char *password)'),
    pageCount: k.func('int FPDF_GetPageCount(void *doc)'),
    loadPage: k.func('void *FPDF_LoadPage(void *doc, int index)'),
    closePage: k.func('void FPDF_ClosePage(void *page)'),
    closeDoc: k.func('void FPDF_CloseDocument(void *doc)'),
    pageSize: k.func('int FPDF_GetPageSizeByIndexF(void *doc, int index, FS_SIZEF *size)'),
    createBitmap: k.func('void *FPDFBitmap_CreateEx(int w, int h, int format, void *first, int stride)'),
    destroyBitmap: k.func('void FPDFBitmap_Destroy(void *bmp)'),
    fillRect: k.func('int FPDFBitmap_FillRect(void *bmp, int left, int top, int w, int h, unsigned int color)'),
    render: k.func('void FPDF_RenderPageBitmap(void *bmp, void *page, int x, int y, int sx, int sy, int rotate, int flags)'),
  };
  api.init();
  const doc = api.loadDoc(tmpPdf, null);
  if (!doc) throw new Error('loadDoc failed');
  const pages = api.pageCount(doc);
  console.log(`pdfium dll: ${DLL}`);
  console.log(`input pdf : ${tmpPdf}`);
  console.log(`pageCount : ${pages}`);
  for (const scale of [1, 2, 4, 8]) {
    const r = renderPage(api, doc, 0, scale);
    // 文字带（PDF y 620~740 → 位图行 792*scale-740*scale ~ 792*scale-620*scale）
    const y0 = (792 - 740) * scale;
    const y1 = (792 - 620) * scale;
    const sharp = edgeEnergy(r.w, r.h, r.data, y0, y1);
    const png = rgbaToPng(r.w, r.h, r.data);
    const out = path.join(outDir, `page1_${scale}x_${r.w}x${r.h}.png`);
    fs.writeFileSync(out, png);
    console.log(
      `scale=${scale}x bitmap=${r.w}x${r.h} render=${r.ms.toFixed(1)}ms edgeEnergy=${sharp.toFixed(1)} -> ${out}`,
    );
  }
  // 光栅化参数 A/B：LCD / REVERSE_BYTE_ORDER 是否真的影响文字（量化亚像素彩色边缘）
  for (const [name, flags] of Object.entries(FLAG_SETS)) {
    const r = renderPage(api, doc, 0, 4, flags);
    const y0 = (792 - 740) * 4;
    const y1 = (792 - 620) * 4;
    const sharp = edgeEnergy(r.w, r.h, r.data, y0, y1);
    const chroma = chromaEnergy(r.w, r.h, r.data, y0, y1);
    const png = rgbaToPng(r.w, r.h, r.data);
    const out = path.join(outDir, `flags_${name}_4x.png`);
    fs.writeFileSync(out, png);
    console.log(`flags=${name} edge=${sharp.toFixed(1)} chroma=${chroma.toFixed(1)} -> ${out}`);
  }
  // 位图格式矩阵：找出能激活 LCD 亚像素文字的 format
  for (const format of [2, 3, 4, 5, 6, 7, 8]) {
    let r;
    try {
      r = renderPage(api, doc, 0, 4, RENDER_FLAGS, format);
    } catch {
      console.log(`format=${format} (unsupported)`);
      continue;
    }
    const y0 = (792 - 740) * 4;
    const y1 = (792 - 620) * 4;
    const chroma = chromaEnergy(r.w, r.h, r.data, y0, y1);
    // 检查输出是否仍然“看起来像文字”（边缘能量不能为 0）
    const sharp = edgeEnergy(r.w, r.h, r.data, y0, y1);
    console.log(`format=${format} edge=${sharp.toFixed(1)} chroma=${chroma.toFixed(1)}`);
  }
  api.closeDoc(doc);
  api.destroyLib();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
