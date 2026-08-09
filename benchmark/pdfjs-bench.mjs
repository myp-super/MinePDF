// PDF.js 渲染基准：在 Node 中使用 @napi-rs/canvas 渲染真实 PDF
// 用法: node benchmark/pdfjs-bench.mjs <pdf路径> <起始页> <页数> <scale> <输出目录>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const [, , pdfPath, startPageArg, pageCountArg, scaleArg, outDir] = process.argv;
const startPage = parseInt(startPageArg, 10) || 0;
const pageCount = parseInt(pageCountArg, 10) || 5;
const scale = parseFloat(scaleArg || '1.5');

const cmapDir = pathToFileURL(
  join(dirname(new URL(import.meta.url).pathname), '..', 'node_modules', 'pdfjs-dist', 'cmaps')
).href;
const fontDir = pathToFileURL(
  join(dirname(new URL(import.meta.url).pathname), '..', 'node_modules', 'pdfjs-dist', 'standard_fonts')
).href;

class NapiCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cv, width, height) {
    cv.canvas.width = width;
    cv.canvas.height = height;
  }
  destroy() {}
}

const data = new Uint8Array(readFileSync(pdfPath));

// 冷启动：打开文档 + 渲染第一页（包含字体/资源初始化）
let coldMs = 0;
let pdf = null;
try {
  const t0 = performance.now();
  pdf = await getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    canvasFactory: new NapiCanvasFactory(),
    cMapUrl: cmapDir,
    cMapPacked: true,
    standardFontDataUrl: fontDir,
  }).promise;
  coldMs = performance.now() - t0;
} catch (e) {
  console.error(JSON.stringify({ error: String(e) }));
  process.exit(1);
}

const total = Math.min(pageCount, pdf.numPages - startPage);
const times = [];
const pngs = [];
let peakRss = process.memoryUsage().rss;

for (let i = 0; i < total; i++) {
  const page = await pdf.getPage(startPage + i + 1);
  const viewport = page.getViewport({ scale });
  // 预热渲染，排除首帧字体/着色器初始化
  const warm = { canvasContext: createCanvas(1, 1).getContext('2d'), viewport: page.getViewport({ scale: 0.05 }) };
  if (i === 0) {
    await page.render({ canvasContext: createCanvas(Math.ceil(viewport.width / 8), Math.ceil(viewport.height / 8)).getContext('2d'), viewport: page.getViewport({ scale: scale / 8 }) }).promise;
  }
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  const t0 = performance.now();
  await page.render({ canvasContext: ctx, viewport }).promise;
  times.push(performance.now() - t0);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const pngPath = join(outDir, `pdfjs_p${startPage + i + 1}.png`);
  writeFileSync(pngPath, canvas.toBuffer('image/png'));
  pngs.push(pngPath);
  page.cleanup();
}

times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
const mean = times.reduce((s, v) => s + v, 0) / times.length;
const max = times[times.length - 1];

console.log(JSON.stringify({
  engine: 'pdfjs',
  file: pdfPath,
  scale,
  pagesRendered: total,
  coldOpenMs: coldMs,
  perPageMs: times,
  medianMs: median,
  meanMs: mean,
  maxMs: max,
  peakRssMB: Math.round(peakRss / 1024 / 1024),
  pngs,
}));
