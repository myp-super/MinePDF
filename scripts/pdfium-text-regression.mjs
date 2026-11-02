// Exercise the bundled native engine and renderer index together, without Electron/DOM.
// Run after npm run test:sel: node scripts/pdfium-text-regression.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import koffi from 'koffi';

const require = createRequire(import.meta.url);
const { getPageTextIndex } = require('../work/selregression-out/src/lib/textIndex.js');
const { pointToRowChar, makeSelectionContext, computeRowSelection } = require('../work/selregression-out/src/lib/selection.js');
const lib = koffi.load(path.resolve('resources/pdfium/win-x64/bin/pdfium.dll'));
const Rect = koffi.struct('TextRegressionRect', { left: 'float', top: 'float', right: 'float', bottom: 'float' });
const api = {
  init: lib.func('void FPDF_InitLibrary()'),
  destroy: lib.func('void FPDF_DestroyLibrary()'),
  load: lib.func('void *FPDF_LoadMemDocument64(const void *data, size_t size, const char *password)'),
  close: lib.func('void FPDF_CloseDocument(void *doc)'),
  page: lib.func('void *FPDF_LoadPage(void *doc, int index)'),
  closePage: lib.func('void FPDF_ClosePage(void *page)'),
  text: lib.func('void *FPDFText_LoadPage(void *page)'),
  closeText: lib.func('void FPDFText_ClosePage(void *text)'),
  count: lib.func('int FPDFText_CountChars(void *text)'),
  box: lib.func('int FPDFText_GetLooseCharBox(void *text, int index, TextRegressionRect *rect)'),
  origin: lib.func('int FPDFText_GetCharOrigin(void *text, int index, double *x, double *y)'),
  unicode: lib.func('unsigned int FPDFText_GetUnicode(void *text, int index)'),
};
const content = [
  'BT /F1 10 Tf 1 0 0 1 50 500 Tm (before) Tj ET',
  'BT /F2 28 Tf 1 0 0 1 95 500 Tm (\\345) Tj ET',
  'BT /F1 5 Tf 1 0 0 1 117 500 Tm 6 Ts (2) Tj -4 Ts (i) Tj 0 Ts ET',
  'BT /F1 10 Tf 1 0 0 1 140 500 Tm (after text) Tj ET',
  'BT /F1 10 Tf 1 0 0 1 50 486 Tm (ordinary line spans the formula) Tj ET',
  'BT /F1 10 Tf 1 0 0 1 300 500 Tm (RIGHT COLUMN) Tj ET',
  'BT /F1 10 Tf 1 0 0 1 300 486 Tm (RIGHT NEXT) Tj ET',
].join('\n');
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [i, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const bytes = Buffer.from(pdf);
api.init();
const doc = api.load(bytes, bytes.length, null);
assert.ok(doc, 'Native engine opens the inline-formula fixture');
const page = api.page(doc, 0);
const text = api.text(page);
const boxPtr = koffi.alloc(Rect, 1);
const originXPtr = koffi.alloc('double', 1);
const originYPtr = koffi.alloc('double', 1);
try {
  const chars = [];
  for (let i = 0; i < api.count(text); i++) {
    if (!api.box(text, i, boxPtr)) continue;
    const b = koffi.decode(boxPtr, Rect);
    if (b.right - b.left < 0.01 || b.top - b.bottom < 0.01) continue;
    assert.equal(api.origin(text, i, originXPtr, originYPtr), 1);
    const baseline = koffi.decode(originYPtr, 'double');
    chars.push({ x: b.left, y: b.bottom, w: b.right - b.left, h: b.top - b.bottom,
      baseline, str: String.fromCodePoint(api.unicode(text, i)), rot: 0 });
  }
  const formula = chars.find((c) => c.h > 20);
  assert.ok(formula, 'Fixture contains a tall formula glyph');
  assert.equal(formula.baseline, 500, 'Formula shares the body baseline despite a different box top');
  const suffix = chars.filter((c) => c.x >= 140 && c.x < 220 && c.baseline === 500);
  assert.ok(suffix.length >= 9);
  globalThis.window = { pkm: { pdfiumTextChars: async () => chars } };
  const index = await getPageTextIndex(1, 1);
  const at = (c, ctx) => pointToRowChar(index, 1, c.x + c.w / 2, c.y + c.h / 2, ctx);
  const prefix = chars.find((c) => c.str === 'b' && c.baseline === 500);
  const start = at(prefix);
  const ctx = makeSelectionContext(index, 1, start.line);
  const end = at(suffix.at(-1), ctx);
  const selected = computeRowSelection({ ...start, ctx }, end, () => index).flatMap((r) => r.items);
  const value = selected.map((c) => c.str).join('');
  assert.ok(value.startsWith('before') && value.includes('after text'), value);
  assert.ok(value.includes('2') && value.includes('i'), `Scripts included: ${value}`);
  assert.ok(selected.every((c) => c.x < 300), 'Selection stays in the left column');
  const reverseCtx = makeSelectionContext(index, 1, end.line);
  const reverse = computeRowSelection({ ...end, ctx: reverseCtx }, at(prefix, reverseCtx), () => index);
  assert.equal(reverse.flatMap((r) => r.items).map((c) => c.str).join(''), value);
  console.log('PASS native PDFium: baseline, inline formula, scripts, suffix selection, reverse drag, column isolation');
} finally {
  delete globalThis.window;
  koffi.free(boxPtr);
  koffi.free(originXPtr);
  koffi.free(originYPtr);
  api.closeText(text);
  api.closePage(page);
  api.close(doc);
  api.destroy();
}
