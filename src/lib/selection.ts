import type { LineBand, PageTextIndex, TextItemQuad } from './textIndex';

/**
 * 选区上下文：按下鼠标时锁定“页 + 旋转 + 视觉列 + 文本块”，拖拽只在其中取候选文本。
 * 同一页用精确列 id + 文本块 id 匹配；跨页（列 id 是页内编号，无全局意义）退回几何匹配：
 * 列中心亲和 + 横向范围实际重叠，禁止跳到相邻栏/全宽页眉页脚。
 */
export interface SelCtx {
  page: number;
  rot: number;
  col: number;
  block: number;
  /** 起始列横向中心（跨行/跨页按此对齐，禁止跨栏） */
  cx: number;
  /** 列亲和容差：候选行中心与 cx 的距离上限 */
  affinity: number;
  /** 起始列的横向范围（跨页候选要求与它实际重叠） */
  colMinX: number;
  colMaxX: number;
}

/** 选中点：页 + 视觉行 + 行内 line 下标 + 行内字符索引 */
export interface SelPoint {
  page: number;
  row: number;
  line: number;
  idx: number;
}

/** 一页的选中结果：字符项 + 该页行带（供合并成连续色块） */
export interface RowSelection {
  page: number;
  items: TextItemQuad[];
  lines: LineBand[];
}

/**
 * 判断 line 是否属于锁定的选区上下文：
 * - 同一页：旋转一致 + 精确列 id 一致 + 文本块一致（正文不会滑进页眉/页脚/图注/旋转文字/相邻栏）；
 * - 跨页：旋转一致 + 列中心在容差内 + 横向范围与起始列有实际重叠（防止窄栏/双栏跳到相邻栏）。
 */
export function lineInSelectionContext(l: LineBand, ctx: SelCtx, page: number): boolean {
  if (l.rot !== ctx.rot) return false;
  if (page === ctx.page) return l.col === ctx.col && l.block === ctx.block;
  const lineCx = (l.minX + l.maxX) / 2;
  if (Math.abs(lineCx - ctx.cx) > ctx.affinity) return false;
  const overlap = Math.min(l.maxX, ctx.colMaxX) - Math.max(l.minX, ctx.colMinX);
  if (overlap < Math.max(2, (l.maxX - l.minX) * 0.4)) return false;
  return true;
}

/**
 * 由按下时的行构建锁定选区上下文：
 * 列几何取整列范围（而不是起点行）——起点是窄标题/段末短行时，
 * 同一列的其它行（更宽/更窄）不会被中心亲和过滤掉。
 */
export function makeSelectionContext(
  index: PageTextIndex,
  page: number,
  lineIdx: number,
): SelCtx | null {
  const startLine = index.lines[lineIdx];
  if (!startLine) return null;
  const col = index.columns.find((c) => c.id === startLine.col);
  const colMinX = col?.minX ?? startLine.minX;
  const colMaxX = col?.maxX ?? startLine.maxX;
  const colW = colMaxX - colMinX;
  return {
    page,
    rot: startLine.rot,
    col: startLine.col,
    block: startLine.block,
    cx: (colMinX + colMaxX) / 2,
    affinity: Math.max(colW * 0.5, 24),
    colMinX,
    colMaxX,
  };
}

/** 光标在行内的字符索引：落在某字符内（或其后间隙）→ 该字符；行尾之后 → 行长度 */
export function charIndexAt(items: TextItemQuad[], rowChars: number[], px: number): number {
  if (!rowChars.length) return 0;
  const last = items[rowChars[rowChars.length - 1]];
  if (px >= last.x + last.w) return rowChars.length;
  for (let i = 0; i < rowChars.length; i++) {
    const it = items[rowChars[i]];
    if (px < it.x + it.w) return i;
  }
  return rowChars.length;
}

/** 西文字符（拉丁字母/数字）：仅这些边界会按间距补空格，避免给中文/标点误加 */
const WESTERN_RE = /[A-Za-z0-9]/;

/**
 * 把选中的字符项组装成可复制文本。
 * PDF 里很多空格不是字符而是“字形间距”（字符流中没有空格），直接拼接会丢词间空格；
 * 这里在同一个视觉行内、横向间距超过词间隔阈值、且两侧至少一侧是西文字符时补一个空格。
 * 显式空格原样保留；中文/旋转文本不受影响；跨行/跨页不补。
 */
export function itemsToText(items: TextItemQuad[]): string {
  if (!items.length) return '';
  const widths = items.map((i) => i.w).filter((w) => w >= 0.01).sort((a, b) => a - b);
  const heights = items.map((i) => i.h).filter((h) => h >= 0.01).sort((a, b) => a - b);
  const medianW = widths.length ? widths[Math.floor(widths.length / 2)] : 6;
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const baselineTol = Math.max(2.5, medianH * 0.45);
  // PDFium often reports glyph bounds rather than the full character advance.
  // A real word space can therefore be only ~20%-30% of the median glyph width;
  // the old 50% threshold silently joined words in notes and translation input.
  const wordGap = Math.max(0.9, medianW * 0.22);
  let out = '';
  let prev: TextItemQuad | null = null;
  for (const it of items) {
    const value = it.str
      .replace(/\u0002/g, '-')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad]/g, '');
    if (!value) continue;
    if (prev) {
      const sameLine = it.rot === prev.rot && Math.abs(it.baseline - prev.baseline) <= baselineTol;
      const gap = it.x - (prev.x + prev.w);
      const prevSpace = prev.str === ' ' || prev.str === '\u00a0';
      const curSpace = value === ' ' || value === '\u00a0';
      if (!sameLine && it.rot === 0 && prev.rot === 0 && !/\s$/.test(out)) {
        // PDF character streams normally omit visual line breaks. Joining them
        // without a separator produces words such as "approachesin" and ruins MT.
        // A line-ending hyphen remains attached to the next fragment.
        if (!/-$/.test(out)) out += ' ';
      }
      if (
        sameLine &&
        it.rot === 0 &&
        gap > wordGap &&
        !prevSpace &&
        !curSpace &&
        (WESTERN_RE.test(prev.str) || WESTERN_RE.test(value))
      ) {
        out += ' ';
      }
    }
    out += value;
    prev = { ...it, str: value };
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/**
 * 指针（PDF 用户空间坐标）→ (行, line 下标, 行内字符索引)。
 * 候选行先按“选区上下文”过滤，再按纵向距离取最近行（行距内判定），
 * 横向距离只作同距离行之间的平局裁决——保证鼠标向下/向上拖过不同宽度的
 * 行时行号能正常前进。字符索引用原始指针 X 计算，终点行可以选到鼠标实际位置。
 */
export function pointToRowChar(
  index: PageTextIndex,
  page: number,
  px: number,
  py: number,
  ctx?: SelCtx | null,
): SelPoint | null {
  const lines = index.lines;
  if (!lines.length) return null;
  let best = -1;
  let bestDy = Infinity;
  let bestDx = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (ctx && !lineInSelectionContext(l, ctx, page)) continue;
    const dy = Math.abs(py - (l.minY + l.maxY) / 2);
    const dx = px < l.minX ? l.minX - px : px > l.maxX ? px - l.maxX : 0;
    // 纵向优先：距离更近的行走前面；纵向几乎相同（±0.5）时用横向命中裁决。
    const better = dy < bestDy - 0.5 || (Math.abs(dy - bestDy) <= 0.5 && dx < bestDx - 0.5);
    if (better) {
      best = i;
      bestDy = dy;
      bestDx = dx;
    }
  }
  if (best < 0) return null;
  const line = lines[best];
  return { page, row: line.row, line: best, idx: charIndexAt(index.items, line.indices, px) };
}

/** 在指定视觉行里，找到属于“锁定选区上下文”的 line（旋转 + 列/块/几何匹配） */
export function lineInContext(index: PageTextIndex, row: number, ctx: SelCtx, page: number): number {
  const cands = index.rowLines[row];
  if (!cands || !cands.length) return -1;
  for (const li of cands) {
    if (lineInSelectionContext(index.lines[li], ctx, page)) return li;
  }
  return -1;
}

/**
 * 按“起点行/终点行”精确计算选中字符（半开区间），并强制约束在起点所属视觉列内：
 * - 同页：起点行只选起点之后，终点行只选到鼠标位置，中间行整行（仅该列）；
 * - 跨页：起点页/终点页同理，中间页整页（仅该列）。
 * 支持从上往下与从下往上（对称）；允许跨行，禁止跨栏。
 */
export function computeRowSelection(
  start: SelPoint & { ctx: SelCtx },
  cur: SelPoint,
  getIndex: (page: number) => PageTextIndex | undefined,
): RowSelection[] {
  const out: RowSelection[] = [];
  const startIndex = getIndex(start.page);
  const startLine = startIndex?.lines[start.line];
  const ctx = start.ctx;
  if (!startLine || !ctx) return out;
  // 按文档顺序（上 → 下、页 → 页）决定遍历方向：
  // - downward：起点在上，遍历 start..cur；
  // - upward：起点在下，遍历 cur..start（对称反转）。
  const downward = start.page < cur.page || (start.page === cur.page && start.row <= cur.row);
  const lo = downward ? start.page : cur.page;
  const hi = downward ? cur.page : start.page;
  for (let p = lo; p <= hi; p++) {
    const index = getIndex(p);
    if (!index || !index.lines.length) continue;
    const rowCount = index.rowLines.length;
    const items: TextItemQuad[] = [];
    // 本页的行区间：
    // - downward：起点页从 start.row 起，终点页到 cur.row 止，中间页全页；
    // - upward：终点页（上方）从 cur.row 起，起点页（下方）到 start.row 止，中间页全页。
    const rStart = p === (downward ? start.page : cur.page) ? (downward ? start.row : cur.row) : 0;
    const rEnd = p === (downward ? cur.page : start.page) ? (downward ? cur.row : start.row) : rowCount - 1;
    for (let r = rStart; r <= rEnd; r++) {
      let li: number;
      if (p === start.page && r === start.row) li = start.line;
      else if (p === cur.page && r === cur.row) li = cur.line;
      else li = lineInContext(index, r, ctx, p);
      if (li < 0) continue;
      const line = index.lines[li];
      const rowLen = line.indices.length;
      let from = 0;
      let to = rowLen;
      // 同一行（含反向拖选）：取两点之间的区间
      if (p === start.page && p === cur.page && r === start.row && r === cur.row) {
        from = Math.min(start.idx, cur.idx);
        to = Math.max(start.idx, cur.idx) + 1;
      } else if (downward) {
        if (p === start.page && r === start.row) from = start.idx;
        if (p === cur.page && r === cur.row) to = cur.idx + 1;
      } else {
        if (p === cur.page && r === cur.row) from = cur.idx;
        if (p === start.page && r === start.row) to = start.idx + 1;
      }
      for (let i = from; i < to && i < rowLen; i++) items.push(index.items[line.indices[i]]);
    }
    if (items.length) out.push({ page: p, items, lines: index.lines });
  }
  return out;
}
