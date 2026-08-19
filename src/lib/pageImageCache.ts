import type { PdfiumRenderResult } from '../shared/types';

/**
 * PDFium 页面位图缓存（渲染进程）
 *
 * 以 (pdfId, page, 缩放桶) 为键的 LRU 缓存。缩放桶按 0.5 级归并，
 * 连续缩放时相邻缩放级别直接复用已有位图，避免反复渲染。
 */
interface Entry {
  bitmap: ImageBitmap;
  lastUsed: number;
  bytes: number;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 96;
const MAX_BYTES = 768 * 1024 * 1024; // 768MB 上限（A4@2x 约 8MB/页）
/** 渲染倍率上限：允许 400% 缩放 × DPR 2（4K/200% Windows）仍保持 1:1 清晰 */
export const MAX_RENDER_SCALE = 8;
/** 单边最大像素：防止异常大页面撑爆内存（6000px × 4B = 144MB/页上限） */
export const MAX_PAGE_DIM = 6000;
let totalBytes = 0;

/**
 * 计算“真正需要的渲染倍率”（含 DPR），并与主进程的尺寸上限保持一致：
 * - 返回精确 deviceScale（不再向上取整到 0.25/0.5 桶），保证 Canvas 与屏幕 1:1，
 *   避免 PDFium 的 LCD 亚像素文字被浏览器二次缩小而发虚；
 * - 仅按绝对倍率上限（MAX_RENDER_SCALE）与页面单边像素上限（MAX_PAGE_DIM）回落；
 * - 返回结果同时用于缓存键与渲染请求，保证“缓存键 == 真实渲染尺寸”，
 *   不会出现低清位图被 CSS 放大显示。
 */
export function effectiveRenderBucket(deviceScale: number, pageW: number, pageH: number): number {
  const dimCap = MAX_PAGE_DIM / Math.max(1, Math.max(pageW, pageH));
  // 精确到 3 位小数，避免浮点噪声导致缓存键抖动
  return Math.max(0.5, Math.round(Math.min(deviceScale, MAX_RENDER_SCALE, dimCap) * 1000) / 1000);
}

export function pageCacheKey(pdfId: number, page: number, bucket: number): string {
  return `${pdfId}:${page}:${bucket}`;
}

export function getCachedPage(key: string): ImageBitmap | null {
  const e = cache.get(key);
  if (!e) return null;
  e.lastUsed = Date.now();
  return e.bitmap;
}

export function putCachedPage(key: string, bitmap: ImageBitmap, w: number, h: number): void {
  const bytes = w * h * 4;
  const existing = cache.get(key);
  if (existing) {
    totalBytes -= existing.bytes;
    existing.bitmap.close();
  }
  cache.set(key, { bitmap, lastUsed: Date.now(), bytes });
  totalBytes += bytes;
  evict();
}

function evict(): void {
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, e] of cache) {
      if (e.lastUsed < oldestTs) {
        oldestTs = e.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey == null) break;
    const e = cache.get(oldestKey)!;
    totalBytes -= e.bytes;
    e.bitmap.close();
    cache.delete(oldestKey);
  }
}

/** 切换文档时清空该 PDF 的所有页面缓存 */
export function clearPdfCache(pdfId: number): void {
  const prefix = `${pdfId}:`;
  for (const [k, e] of [...cache]) {
    if (k.startsWith(prefix)) {
      totalBytes -= e.bytes;
      e.bitmap.close();
      cache.delete(k);
    }
  }
}

/** 把 PDFium RGBA 结果转成可绘制的 ImageBitmap */
export async function toImageBitmap(res: PdfiumRenderResult): Promise<ImageBitmap> {
  const img = new ImageData(new Uint8ClampedArray(res.data), res.w, res.h);
  // createImageBitmap 走 Chromium 原生快路径（内部异步解码），
  // 比 OffscreenCanvas.putImageData + transferToImageBitmap 更省主线程时间。
  return createImageBitmap(img);
}
