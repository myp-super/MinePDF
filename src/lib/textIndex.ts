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

const textCache = new Map<string, TextItemQuad[]>();
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

/** 把选中的文本项按行合并成连续色块（一行一块，空格/标点不再断开） */
export function mergeSelectionItems(items: TextItemQuad[]): Quad[] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  const groups: TextItemQuad[][] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    const lineBase = g ? g[0].baseline : it.baseline;
    if (g && Math.abs(lineBase - it.baseline) <= Math.max(2, g[0].h * 0.6)) {
      g.push(it);
    } else {
      groups.push([it]);
    }
  }
  return groups.map((grp) => {
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

/** 命中测试：返回与 (px,py) 最近的文本项下标（垂直方向权重更高，避免跨行误选） */
export function nearestTextIndex(items: TextItemQuad[], px: number, py: number): number {
  if (!items.length) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const dx = px - cx;
    const dy = (py - cy) * 2.4;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
