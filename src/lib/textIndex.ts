import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Quad } from '../shared/types';

/**
 * 基于 pdf.js 文本项的选词索引（Edge 式“字符块”选词）。
 *
 * 不再依赖浏览器原生 selection 的 DOM 矩形：文本项（含空格/标点）各自有
 * 独立四边形，拖拽时按“读序下标”整体入选，再按行合并成连续色块，
 * 空格、标点、混排字号都不会断开。
 */
export interface TextItemQuad {
  /** PDF 用户空间（y 轴向上），左下角 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 基线 y（PDF 用户空间），用于按行分组 */
  baseline: number;
  str: string;
}

/** 一行文本的垂直带（同一视觉行内基线抖动由容差吸收，中文/英文/上下标不再拆块） */
export interface LineBand {
  baseline: number;
  minY: number;
  maxY: number;
  /** 在“读序数组”中的下标（读序：从上到下、从左到右） */
  indices: number[];
}

export interface PageTextIndex {
  /** 读序文本项 */
  items: TextItemQuad[];
  /** 整页行带 */
  lines: LineBand[];
}

const textCache = new Map<string, TextItemQuad[]>();
const lineCache = new Map<string, LineBand[]>();
const TEXT_CACHE_MAX = 512;

/** 取一页文本项四边形，按读序排序（从上到下、从左到右）；结果缓存 */
export async function getPageTextQuads(
  doc: PDFDocumentProxy,
  pdfId: number,
  pageNumber: number,
): Promise<TextItemQuad[]> {
  const key = `${pdfId}:${pageNumber}`;
  const hit = textCache.get(key);
  if (hit) return hit;
  const page = await doc.getPage(pageNumber);
  const tc = await page.getTextContent();
  const items: TextItemQuad[] = [];
  for (const it of tc.items) {
    if (!('str' in it) || !Array.isArray(it.transform) || it.transform.length < 6) continue;
    const w = typeof it.width === 'number' && it.width > 0 ? it.width : 0;
    if (w < 0.01) continue;
    const h = typeof it.height === 'number' && it.height > 0 ? it.height : 1;
    const tx = it.transform[4];
    const ty = it.transform[5];
    items.push({ x: tx, y: ty - h, w, h, baseline: ty, str: it.str });
  }
  items.sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  textCache.set(key, items);
  while (textCache.size > TEXT_CACHE_MAX) {
    const k = textCache.keys().next().value as string | undefined;
    if (k == null) break;
    textCache.delete(k);
  }
  return items;
}

/** 整页行带聚类：用整页中位字号定容差，避免“首项锚定”导致的同行拆块 */
export function buildPageLines(items: TextItemQuad[]): LineBand[] {
  const heights = items.map((i) => i.h).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const tol = Math.max(2.5, medianH * 0.45);
  const bands: LineBand[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let target = -1;
    for (let bi = bands.length - 1; bi >= 0; bi--) {
      if (Math.abs(bands[bi].baseline - it.baseline) <= tol) {
        target = bi;
        break;
      }
    }
    if (target >= 0) {
      const b = bands[target];
      b.indices.push(i);
      b.minY = Math.min(b.minY, it.y);
      b.maxY = Math.max(b.maxY, it.y + it.h);
    } else {
      bands.push({ baseline: it.baseline, minY: it.y, maxY: it.y + it.h, indices: [i] });
    }
  }
  return bands;
}

/** 取整页文本索引（读序项 + 行带），缓存 */
export async function getPageTextIndex(
  doc: PDFDocumentProxy,
  pdfId: number,
  pageNumber: number,
): Promise<PageTextIndex> {
  const items = await getPageTextQuads(doc, pdfId, pageNumber);
  const key = `${pdfId}:${pageNumber}`;
  let lines = lineCache.get(key);
  if (!lines) {
    lines = buildPageLines(items);
    lineCache.set(key, lines);
  }
  return { items, lines };
}

/** 把选中的文本项按“行带”合并成连续色块：一行一块，无视字体/大小写/标点差异 */
export function mergeSelectionItems(selected: TextItemQuad[], lines: LineBand[]): Quad[] {
  if (!selected.length) return [];
  const byBand = new Map<number, TextItemQuad[]>();
  for (const it of selected) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const d = Math.abs(lines[i].baseline - it.baseline);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const arr = byBand.get(bi) ?? [];
    arr.push(it);
    byBand.set(bi, arr);
  }
  return [...byBand.values()].map((grp) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const q of grp) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x + q.w);
      maxY = Math.max(maxY, q.y + q.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  });
}

/**
 * 命中测试：先锁定指针所在“行带”（按垂直位置），再在行内取最近项，
 * 跨行拖动不会因标点/中英文等相邻项而跳到错误的行。
 */
export function nearestTextIndex(
  items: TextItemQuad[],
  lines: LineBand[],
  px: number,
  py: number,
): number {
  if (!items.length || !lines.length) return -1;
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const cy = (lines[i].minY + lines[i].maxY) / 2;
    const d = Math.abs(py - cy);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  const band = lines[bi];
  let best = band.indices[0];
  let bestD = Infinity;
  for (const idx of band.indices) {
    const it = items[idx];
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const dx = px - cx;
    const dy = (py - cy) * 1.2;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = idx;
    }
  }
  return best;
}
