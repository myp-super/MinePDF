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
  /** 字符旋转角（度，量化 0/90/180/270）；非 0 一律视为独立文本区域 */
  rot: number;
}

/** 一行文本的垂直带（同一视觉行内基线抖动由容差吸收，中文/英文/上下标不再拆块） */
export interface LineBand {
  baseline: number;
  minY: number;
  maxY: number;
  /** 该行（视觉列单元格）的横向范围，用于按列命中与列内选词 */
  minX: number;
  maxX: number;
  /** 所属视觉行序号（0 为页顶第一行），用于跨行选词时按列对齐 */
  row: number;
  /** 在“读序数组”中的下标（读序：从上到下、从左到右） */
  indices: number[];
  /** 字符旋转角（该行内所有字符一致） */
  rot: number;
  /** 视觉列 id（同旋转、横向同列的文本行聚合为一列） */
  col: number;
  /** 文本块 id（同一列内按纵向间隙切块：页眉/页脚/图注/段落大间距独立成块） */
  block: number;
}

export interface PageTextIndex {
  /** 读序文本项 */
  items: TextItemQuad[];
  /** 整页行带（已按“视觉列”拆开：双栏页一行会拆成左右两段） */
  lines: LineBand[];
  /** 视觉行序号 -> 该行内所有 line 的下标（供按列匹配） */
  rowLines: number[][];
  /** 视觉列汇总（调试覆盖层用） */
  columns: { id: number; rot: number; minX: number; maxX: number; minY: number; maxY: number }[];
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
    items.push({ x: c.x, y: c.y, w, h, baseline: c.baseline ?? c.y + h, str: c.str, rot: c.rot ?? 0 });
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

/** 整页行带聚类：用整页中位字号定容差，先按基线聚成“行带”，再按横向间隙切成视觉列，避免双栏跨栏选词 */
export function buildPageLines(items: TextItemQuad[]): LineBand[] {
  const widths = items.map((i) => i.w).filter((w) => w >= 0.01).sort((a, b) => a - b);
  const medianW = widths.length ? widths[Math.floor(widths.length / 2)] : 8;
  const heights = items.map((i) => i.h).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const tol = Math.max(2.5, medianH * 0.45);
  // 列间距通常远大于字符/单词间距：以中位字宽为基准设自适应阈值，避免硬编码像素
  const colGap = Math.max(medianW * 2.2, 6);

  type RawBand = {
    baseline: number;
    minY: number;
    maxY: number;
    rot: number;
    indices: number[];
  };
  const bands: RawBand[] = [];
  // 先用正文字号建立稳定基线，再归入大符号/上下标，避免上标先建一行、
  // 大公式的行框中心把后续字符吸到相邻正文行。
  const unusualSize = (it: TextItemQuad): boolean => it.h > medianH * 1.6 || it.h < medianH * 0.7;
  const order = items.map((_, i) => i).sort((a, b) => Number(unusualSize(items[a])) - Number(unusualSize(items[b])));
  for (const i of order) {
    const it = items[i];
    let target = -1;
    let distance = Infinity;
    const limit = unusualSize(it) ? Math.max(tol, it.h < medianH ? medianH * 0.95 : it.h * 0.35) : tol;
    for (let bi = bands.length - 1; bi >= 0; bi--) {
      // 旋转不同的字符绝不并入同一行带（旋转文本 = 独立文本区域）
      const delta = Math.abs(bands[bi].baseline - it.baseline);
      if (bands[bi].rot === it.rot && delta <= limit && delta < distance) {
        target = bi;
        distance = delta;
      }
    }
    if (target >= 0) {
      const b = bands[target];
      b.indices.push(i);
      b.minY = Math.min(b.minY, it.y);
      b.maxY = Math.max(b.maxY, it.y + it.h);
    } else {
      bands.push({ baseline: it.baseline, minY: it.y, maxY: it.y + it.h, rot: it.rot, indices: [i] });
    }
  }
  // 按基线从高到低（视觉从上到下）排序，保证 row 序号稳定
  bands.sort((a, b) => b.baseline - a.baseline);

  const lines: LineBand[] = [];
  for (let r = 0; r < bands.length; r++) {
    const band = bands[r];
    band.indices.sort((a, c) => items[a].x - items[c].x || a - c);
    // 行内按横向间隙切列：列间留白远大于字符/单词间隙
    const segs: number[][] = [];
    let cur: number[] = [];
    let prevRight: number | null = null;
    for (let k = 0; k < band.indices.length; k++) {
      const gi = band.indices[k];
      const it = items[gi];
      if (prevRight !== null && cur.length && it.x - prevRight > colGap) {
        segs.push(cur);
        cur = [];
      }
      cur.push(gi);
      prevRight = Math.max(prevRight ?? -Infinity, it.x + it.w);
    }
    if (cur.length) segs.push(cur);

    for (const seg of segs) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const gi of seg) {
        minX = Math.min(minX, items[gi].x);
        maxX = Math.max(maxX, items[gi].x + items[gi].w);
        minY = Math.min(minY, items[gi].y);
        maxY = Math.max(maxY, items[gi].y + items[gi].h);
      }
      lines.push({
        baseline: band.baseline,
        // 每栏独立取字形范围：另一栏的大公式不得改变本栏的行中心。
        minY,
        maxY,
        minX,
        maxX,
        row: r,
        indices: seg,
        rot: band.rot,
        col: -1,
        block: -1,
      });
    }
  }

  // ---------- 视觉列聚类 ----------
  // 按行顺序（上→下）处理：同一视觉列的相邻行（纵向间隙 ≤ blockGap）且横向重叠
  // ≥ 较小宽度一半的并入同一列；页眉/页脚/大段留白因纵向间隙过大而独立成列。
  // 一条行同时对行宽有实质覆盖（≥ 行宽 1/4）的列不止一个（全宽跨栏标题/公式），
  // 则独立成列，避免把左右两栏桥接成同一栏。旋转文本天然独立成列。
  const blockGap = Math.max(medianH * 2.5, 20);
  // 公式空白可能把同栏的一行切成几段，段首/段尾只需一侧正文行支持。
  // 同时用相邻行持续出现的栏间留白排除真实双栏；依据原始行判断，
  // 避免全宽标题或先前合并的结果桥接左右栏。
  const originalLines = lines.slice();
  const rowLineMap = new Map<number, LineBand[]>();
  for (const line of originalLines) {
    const rowLines = rowLineMap.get(line.row) ?? [];
    rowLines.push(line);
    rowLineMap.set(line.row, rowLines);
  }
  const coversPair = (candidate: LineBand, left: LineBand, right: LineBand): boolean => {
    const pad = Math.max(2, medianW * 0.8);
    return candidate.minX <= left.maxX + pad && candidate.maxX >= right.minX - pad;
  };
  const shouldJoinInline = (left: LineBand, right: LineBand): boolean => {
    if (left.row !== right.row || left.rot !== right.rot) return false;
    const gap = right.minX - left.maxX;
    if (gap < 0 || gap > Math.max(48, medianW * 10)) return false;
    const neighborRows = [rowLineMap.get(left.row - 1) ?? [], rowLineMap.get(left.row + 1) ?? []];
    const gutterX = (left.maxX + right.minX) / 2;
    // 相邻行在同一位置也分为左右两栏时，保留栏间界限，即使旁边有全宽标题。
    if (neighborRows.some((row) =>
      row.some((candidate) => candidate.rot === left.rot && candidate.maxX < gutterX && candidate.maxX >= left.minX) &&
      row.some((candidate) => candidate.rot === left.rot && candidate.minX > gutterX && candidate.minX <= right.maxX))) return false;
    const neighbors = neighborRows.flat();
    // 相邻正文行有一条线同时覆盖公式前后两段，说明它们属于同一栏。
    if (neighbors.some((candidate) => candidate.rot === left.rot && coversPair(candidate, left, right) &&
      // 候选行还跨过本行另一栏时，它是全宽标题，不能支持这次合并。
      !originalLines.some((other) => other.row === left.row && other.rot === left.rot &&
        (other.maxX < left.minX || other.minX > right.maxX) &&
        Math.min(candidate.maxX, other.maxX) - Math.max(candidate.minX, other.minX) > 0))) return true;
    // 没有相邻行可参考时，只合并很短的公式留白；双栏间距通常明显更大。
    return gap <= Math.max(18, medianW * 4.5) &&
      (left.indices.some((index) => items[index].h > medianH * 1.35) ||
        right.indices.some((index) => items[index].h > medianH * 1.35));
  };
  const joinedLines: LineBand[] = [];
  for (const line of originalLines) {
    const prev = joinedLines[joinedLines.length - 1];
    const supported = prev && shouldJoinInline(prev, line);
    if (supported) {
      joinedLines[joinedLines.length - 1] = {
        ...prev,
        maxX: Math.max(prev.maxX, line.maxX),
        minY: Math.min(prev.minY, line.minY),
        maxY: Math.max(prev.maxY, line.maxY),
        indices: [...prev.indices, ...line.indices],
      };
    } else {
      joinedLines.push(line);
    }
  }
  lines.splice(0, lines.length, ...joinedLines);
  const columns: { id: number; rot: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (const line of lines) {
    const lineW = line.maxX - line.minX;
    let best = -1;
    let bestOverlap = -1;
    let matched = 0;
    for (let ci = 0; ci < columns.length; ci++) {
      const c = columns[ci];
      if (c.rot !== line.rot) continue;
      const overlap = Math.min(line.maxX, c.maxX) - Math.max(line.minX, c.minX);
      const colW = Math.max(c.maxX - c.minX, 1);
      if (overlap < Math.max(2, 0.5 * Math.min(lineW, colW))) continue;
      // 纵向相邻：行与列之间的空白不超过文本块阈值（垂直重叠视为 0）
      const gap = line.maxY < c.minY ? c.minY - line.maxY : line.minY > c.maxY ? line.minY - c.maxY : 0;
      if (gap > blockGap) continue;
      if (overlap >= 0.25 * lineW) matched++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = ci;
      }
    }
    // 同时实质覆盖多个列 → 独立成列；否则并入重叠最多的列
    if (best >= 0 && matched <= 1) {
      const c = columns[best];
      c.minX = Math.min(c.minX, line.minX);
      c.maxX = Math.max(c.maxX, line.maxX);
      c.minY = Math.min(c.minY, line.minY);
      c.maxY = Math.max(c.maxY, line.maxY);
      line.col = c.id;
    } else {
      const id = columns.length;
      columns.push({ id, rot: line.rot, minX: line.minX, maxX: line.maxX, minY: line.minY, maxY: line.maxY });
      line.col = id;
    }
  }

  // ---------- 文本块切分 ----------
  // 同一列内，相邻行的纵向空隙超过阈值（约 2.5 倍行高）即切为独立文本块：
  // 正文段落保持同块可连续选择；页眉/页脚/页码/图注/大幅留白前后独立成块。
  const byCol = new Map<number, LineBand[]>();
  for (const line of lines) {
    const arr = byCol.get(line.col) ?? [];
    arr.push(line);
    byCol.set(line.col, arr);
  }
  for (const colLines of byCol.values()) {
    colLines.sort((a, b) => a.row - b.row);
    let block = 0;
    for (let i = 0; i < colLines.length; i++) {
      const l = colLines[i];
      l.block = block;
      const next = colLines[i + 1];
      if (next) {
        // y-up：上一行底边与下一行顶边的距离
        const gap = l.minY - next.maxY;
        if (gap > blockGap) block++;
      }
    }
  }
  return lines;
}

/** 由文本项构建整页文本索引（读序项 + 行带 + 视觉行 + 列汇总）；可传入缓存行带跳过聚类 */
export function buildPageIndex(items: TextItemQuad[], cachedLines?: LineBand[]): PageTextIndex {
  const lines = cachedLines ?? buildPageLines(items);
  const rowLines: number[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = lines[i].row;
    (rowLines[r] ||= []).push(i);
  }
  const columns: { id: number; rot: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (const line of lines) {
    let c = columns.find((cc) => cc.id === line.col);
    if (!c) {
      c = { id: line.col, rot: line.rot, minX: line.minX, maxX: line.maxX, minY: line.minY, maxY: line.maxY };
      columns.push(c);
    } else {
      c.minX = Math.min(c.minX, line.minX);
      c.maxX = Math.max(c.maxX, line.maxX);
      c.minY = Math.min(c.minY, line.minY);
      c.maxY = Math.max(c.maxY, line.maxY);
    }
  }
  return { items, lines, rowLines, columns };
}

/** 取整页文本索引（读序项 + 行带），缓存 */
export async function getPageTextIndex(
  pdfId: number,
  pageNumber: number,
): Promise<PageTextIndex> {
  const items = await getPageTextQuads(pdfId, pageNumber);
  const key = `${pdfId}:${pageNumber}`;
  const cached = lineCache.get(key);
  const index = buildPageIndex(items, cached);
  if (!cached) lineCache.set(key, index.lines);
  return index;
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
  return { x: it.x, y: it.y + it.h - h, w: it.w, h };
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
  return { ...u, baseline: a.baseline, str: a.str + b.str, rot: a.rot };
}
