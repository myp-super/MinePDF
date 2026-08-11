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

/**
 * 取一页引擎级字符四边形（PDFium FPDFText_GetLooseCharBox，y-up 精确字形框），
 * 按读序排序（从上到下、从左到右）；结果缓存。不依赖 pdf.js，首帧即可用。
 */
export async function getPageTextQuads(
  pdfId: number,
  pageNumber: number,
): Promise<TextItemQuad[]> {
  const key = `${pdfId}:${pageNumber}`;
  const hit = textCache.get(key);
  if (hit) return hit;
  const items: TextItemQuad[] = [];
  const chars = await window.pkm.pdfiumTextChars(pdfId, pageNumber);
  for (const c of chars) {
    const w = c.w;
    if (w < 0.01) continue;
    // 跳过 pdfium 的占位符（\u0001/空串）：它们没有可见字形，会让行内索引与可见文字错位
    if (c.str === '\u0001' || c.str === '') continue;
    const h = c.h > 0 ? c.h : 1;
    items.push({ x: c.x, y: c.y, w, h, baseline: c.y + h, str: c.str });
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
  // 行内按 x 排序为视觉阅读顺序：同一行内基线略异的字符（中文/英文/上下标）
  // 在 items 中的顺序可能与视觉顺序不一致，选词索引与内容拼接都必须按 x 顺序。
  for (const b of bands) {
    b.indices.sort((a, c) => items[a].x - items[c].x || a - c);
  }
  return bands;
}

/** 取整页文本索引（读序项 + 行带），缓存 */
export async function getPageTextIndex(
  pdfId: number,
  pageNumber: number,
): Promise<PageTextIndex> {
  const items = await getPageTextQuads(pdfId, pageNumber);
  const key = `${pdfId}:${pageNumber}`;
  let lines = lineCache.get(key);
  if (!lines) {
    lines = buildPageLines(items);
    lineCache.set(key, lines);
  }
  return { items, lines };
}

/**
 * 命中测试（移植 SumatraPDF FindClosestGlyph）：
 * - 优先返回指针“实际落在”的字符；
 * - 否则取中心距离最近的字符（无垂直加权，行距内判定准确）；
 * - 指针落在字符右半时返回下一个字符（保证行尾字符能被选中）。
 */
export function nearestTextIndex(
  items: TextItemQuad[],
  _lines: LineBand[],
  px: number,
  py: number,
): number {
  const n = items.length;
  if (!n) return -1;
  let result = -1;
  let maxDist = Infinity;
  let overGlyph = false;
  for (let i = 0; i < n; i++) {
    const c = items[i];
    if (c.w < 0.01) continue;
    const contains = px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h;
    if (overGlyph && !contains) continue;
    const dx = px - (c.x + c.w / 2);
    const dy = py - (c.y + c.h / 2);
    const d = dx * dx + dy * dy;
    if (d < maxDist) {
      maxDist = d;
      result = i;
    }
    if (!overGlyph && contains) {
      overGlyph = true;
      maxDist = d;
      result = i;
    }
  }
  if (result < 0) return 0;
  const bbox = items[result];
  // 点在字符右半 -> 选中从下一个字符开始（保证拖到行尾能包含最后一个字符）
  if (px > bbox.x + 0.5 * bbox.w) result++;
  return Math.min(result, n);
}

/**
 * 视觉行判定（移植 SumatraPDF IsGlyphOnVisualLine）：
 * 新字符与当前行框的垂直重叠 >= 新字符高度的一半，则并入同一行。
 * 用“字形高度”（em 的 0.6 倍）做判定，避免行距较密时把相邻行误并。
 */
function detectQuad(it: TextItemQuad): { x: number; y: number; w: number; h: number } {
  const h = it.h * 0.6;
  return { x: it.x, y: it.baseline - h, w: it.w, h };
}

function isGlyphOnVisualLine(
  lineBox: { y: number; h: number },
  glyphBox: { y: number; h: number },
): boolean {
  const top = Math.max(lineBox.y, glyphBox.y);
  const bottom = Math.min(lineBox.y + lineBox.h, glyphBox.y + glyphBox.h);
  return (bottom - top) * 2 >= glyphBox.h;
}

/**
 * 把选中的文本项按视觉行合并成连续色块（移植 SumatraPDF FillSelectionRects）：
 * 逐字符 Union，垂直重叠不足半高的字符另起一行；每行输出一个矩形，
 * 行内无视空格/标点/中英文/字号差异，整行一条连续色块。
 * 最终色块底部下扩 20% 以覆盖西文下行字母与标点。
 */
export function mergeSelectionItems(selected: TextItemQuad[], _lines: LineBand[]): Quad[] {
  const n = selected.length;
  if (!n) return [];
  const out: Quad[] = [];
  let i = 0;
  while (i < n) {
    while (i < n && selected[i].w < 0.01) i++;
    if (i >= n) break;
    let detect: { x: number; y: number; w: number; h: number } | null = null;
    let full: TextItemQuad | null = null;
    while (i < n && selected[i].w >= 0.01) {
      const d = detectQuad(selected[i]);
      if (detect && !isGlyphOnVisualLine(detect, d)) break;
      detect = detect ? unionRect(detect, d) : d;
      full = full ? unionItem(full, selected[i]) : selected[i];
      i++;
    }
    if (!full) continue;
    // 轻微下扩，覆盖标点/下行字母边缘
    out.push({ x: full.x, y: full.y, w: full.w, h: full.h * 1.15 });
  }
  return out;
}

function unionRect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const top = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: top - y };
}

function unionItem(a: TextItemQuad, b: TextItemQuad): TextItemQuad {
  const u = unionRect(a, b);
  return { ...u, baseline: a.baseline, str: a.str + b.str };
}
