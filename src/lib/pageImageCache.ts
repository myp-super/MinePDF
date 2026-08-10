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
let totalBytes = 0;

/** 把渲染倍率归并为 0.5 级桶 */
export function scaleBucket(scale: number): number {
  return Math.max(0.5, Math.round(scale * 2) / 2);
}

/**
 * 渲染倍率桶：向上取整到 0.25 级，保证“显示倍率 ≤ 渲染倍率”，
 * 位图永远只做缩小显示，任何缩放级别都不会把低清图放大（发虚）。
 */
export function renderBucket(scale: number): number {
  return Math.max(0.5, Math.ceil(scale * 4) / 4);
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
  const oc = new OffscreenCanvas(res.w, res.h);
  const octx = oc.getContext('2d');
  if (!octx) throw new Error('offscreen canvas unavailable');
  octx.putImageData(img, 0, 0);
  return oc.transferToImageBitmap();
}
