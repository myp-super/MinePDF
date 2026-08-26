/**
 * PDF 选词引擎几何回归测试（纯函数，无 DOM/无 Electron）。
 *
 * 覆盖：单行、同页跨多行（向下/向上）、参差行宽（短行/窄起点）、
 * 同栏锁定（禁止跨栏）、旋转文字/页眉/页脚排除、文本块边界锁定、
 * 跨页连续选择、跨页禁止跳栏。
 *
 * 运行：npm run test:sel
 */
import { buildPageIndex, type PageTextIndex, type TextItemQuad } from '../src/lib/textIndex';
import {
  computeRowSelection,
  itemsToText,
  makeSelectionContext,
  pointToRowChar,
  type RowSelection,
  type SelCtx,
  type SelPoint,
} from '../src/lib/selection';
import {
  pageAtScrollPosition,
  readingAnchorAtScrollPosition,
  remapScrollPosition,
  remapScrollPositionAtViewport,
  scrollPositionForReadingAnchor,
} from '../src/lib/pagePosition';

interface LineSpec {
  text: string;
  y0: number;
}

const BODY_A_1: LineSpec[] = [
  { text: 'Line zero body 0123', y0: 500 },
  { text: 'Line one body 4567', y0: 486 },
  { text: 'Line two body 89ab', y0: 472 },
  { text: 'short', y0: 458 },
  { text: 'Line four body cdef', y0: 444 },
  { text: 'Paragraph two 12345', y0: 400 },
  { text: 'Paragraph two 67890', y0: 386 },
];
const BODY_B_1: LineSpec[] = [
  { text: 'Right col alpha', y0: 500 },
  { text: 'Right col beta', y0: 486 },
  { text: 'Right col gamma', y0: 472 },
  { text: 'Rcol', y0: 458 },
  { text: 'Right col delta', y0: 444 },
  { text: 'Right col epsil', y0: 400 },
  { text: 'Right col zeta', y0: 386 },
];

function pageSpecs(bodyA: LineSpec[], bodyB: LineSpec[]) {
  return {
    bodyA,
    bodyB,
    header: 'Header Text',
    footer: 'Footer 1',
    rotated: { text: 'ARXIVLABEL', x: 12, yStart: 505 },
  };
}

const P2 = pageSpecs(
  BODY_A_1.map((l, i) => ({ text: `A2 line ${i} 0123456789`, y0: l.y0 })),
  BODY_B_1.map((l, i) => ({ text: `B2 col ${i} zyxwvuts`, y0: l.y0 })),
);
const P3 = pageSpecs(
  BODY_A_1.map((l, i) => ({ text: `A3 line ${i} 9876543210`, y0: l.y0 })),
  BODY_B_1.map((l, i) => ({ text: `B3 col ${i} qwertyuiop`, y0: l.y0 })),
);

function makeLine(spec: LineSpec & { x0: number; rot?: number }): TextItemQuad[] {
  const { text, x0, y0, rot = 0 } = spec;
  return [...text].map((ch, i) => ({
    x: x0 + i * 7,
    y: y0,
    w: 6,
    h: 7,
    baseline: y0 + 7,
    str: ch,
    rot,
  }));
}

function makeRotated(text: string, x0: number, yStart: number): TextItemQuad[] {
  return [...text].map((ch, i) => ({
    x: x0,
    y: yStart - i * 9,
    w: 6,
    h: 7,
    baseline: yStart - i * 9 + 7,
    str: ch,
    rot: 90,
  }));
}

function buildPage(specs: {
  header: string;
  footer: string;
  bodyA: LineSpec[];
  bodyB: LineSpec[];
  rotated: { text: string; x: number; yStart: number };
}): PageTextIndex {
  const items: TextItemQuad[] = [];
  items.push(...makeLine({ text: specs.header, x0: 160, y0: 560 }));
  for (const s of specs.bodyA) items.push(...makeLine({ ...s, x0: 50 }));
  for (const s of specs.bodyB) items.push(...makeLine({ ...s, x0: 300 }));
  items.push(...makeRotated(specs.rotated.text, specs.rotated.x, specs.rotated.yStart));
  items.push(...makeLine({ text: specs.footer, x0: 160, y0: 60 }));
  items.sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  return buildPageIndex(items);
}

const p1 = buildPage(pageSpecs(BODY_A_1, BODY_B_1));
const p2 = buildPage(P2);
const p3 = buildPage(P3);
const getIndex = (p: number) => (p === 1 ? p1 : p === 2 ? p2 : p === 3 ? p3 : undefined);

function lineText(index: PageTextIndex, lineIdx: number): string {
  if (lineIdx < 0) return '';
  return index.lines[lineIdx].indices.map((i) => index.items[i].str).join('');
}

function findLine(index: PageTextIndex, text: string): number {
  const li = index.lines.findIndex((_, i) => lineText(index, i) === text);
  if (li < 0) throw new Error(`test line not found: ${text}`);
  return li;
}

/** 行内字符中心点；edge=true 表示行尾之外 */
function ptAt(index: PageTextIndex, lineIdx: number, charIdx: number, edge = false) {
  const l = index.lines[lineIdx];
  if (edge) return { px: l.maxX + 2, py: (l.minY + l.maxY) / 2 };
  const gi = l.indices[Math.min(charIdx, l.indices.length - 1)];
  const it = index.items[gi];
  return { px: it.x + it.w / 2, py: (l.minY + l.maxY) / 2 };
}

function selText(sel: RowSelection[]): string {
  return sel.map((p) => p.items.map((i) => i.str).join('')).join('');
}

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const lA0 = findLine(p1, BODY_A_1[0].text);
const lA1 = findLine(p1, BODY_A_1[1].text);
const lA2 = findLine(p1, BODY_A_1[2].text);
const lA3 = findLine(p1, BODY_A_1[3].text);
const lA4 = findLine(p1, BODY_A_1[4].text);
const lA5 = findLine(p1, BODY_A_1[5].text);
const lB2 = findLine(p1, BODY_B_1[2].text);

// 起点：p1 左栏 L0 第 2 字符
const s0pt = ptAt(p1, lA0, 2);
const s0 = pointToRowChar(p1, 1, s0pt.px, s0pt.py)!;
const ctx0 = makeSelectionContext(p1, 1, s0.line)!;
if (!s0 || !ctx0) throw new Error('起点解析失败');

// 1) 单行：L0 2 → 8
{
  const c = pointToRowChar(p1, 1, ptAt(p1, lA0, 8).px, ptAt(p1, lA0, 8).py, ctx0)!;
  check('单行：终点仍在本行', c.line === s0.line && c.idx === 8);
  const sel = computeRowSelection({ ...s0, ctx: ctx0 }, c, getIndex);
  check('单行：文本区间', selText(sel) === BODY_A_1[0].text.slice(2, 9));
}

// 2) 同页向下跨 4 行，终点是段末短行（旧 bug：指针 X 在短行范围外时行号不前进）
{
  const c = pointToRowChar(p1, 1, ptAt(p1, lA3, 0, true).px, ptAt(p1, lA3, 0).py, ctx0)!;
  check('短行终点：行号前进到 L3', c.line === lA3 && c.row === p1.lines[lA3].row);
  check('短行终点：索引钳到行尾', c.idx === p1.lines[lA3].indices.length);
  const sel = computeRowSelection({ ...s0, ctx: ctx0 }, c, getIndex);
  const expected = BODY_A_1[0].text.slice(2) + BODY_A_1[1].text + BODY_A_1[2].text + BODY_A_1[3].text;
  check('向下多行：文本完整', selText(sel) === expected);
  check(
    '向下多行：只含左栏字符',
    sel.every((p) => p.items.every((i) => i.x < 200 && i.rot === 0)),
  );
}

// 3) 同页向上（从 L3 拖回 L0）
{
  const sup = pointToRowChar(p1, 1, ptAt(p1, lA3, 2).px, ptAt(p1, lA3, 2).py)!;
  const ctxUp = makeSelectionContext(p1, 1, sup.line)!;
  const c = pointToRowChar(p1, 1, ptAt(p1, lA0, 3).px, ptAt(p1, lA0, 3).py, ctxUp)!;
  const sel = computeRowSelection({ ...sup, ctx: ctxUp }, c, getIndex);
  const expected = BODY_A_1[0].text.slice(3) + BODY_A_1[1].text + BODY_A_1[2].text + BODY_A_1[3].text.slice(0, 3);
  check('向上多行：文本完整', selText(sel) === expected);
  check('向上多行：终点行只选到起点字符', c.line === lA0 && c.idx === 3);
}

// 4) 同一行反向拖选
{
  const s = pointToRowChar(p1, 1, ptAt(p1, lA1, 6).px, ptAt(p1, lA1, 6).py)!;
  const ctx = makeSelectionContext(p1, 1, s.line)!;
  const c = pointToRowChar(p1, 1, ptAt(p1, lA1, 2).px, ptAt(p1, lA1, 2).py, ctx)!;
  const sel = computeRowSelection({ ...s, ctx }, c, getIndex);
  check('同行反向：文本区间', selText(sel) === BODY_A_1[1].text.slice(2, 7));
}

// 5) 同页禁止跨栏：指针移到右栏
{
  const c = pointToRowChar(p1, 1, ptAt(p1, lB2, 0).px, ptAt(p1, lB2, 0).py, ctx0)!;
  check('跨栏指针：仍命中左栏行', p1.lines[c.line].col === ctx0.col);
  check('跨栏指针：索引钳到行尾', c.idx === p1.lines[c.line].indices.length);
  const sel = computeRowSelection({ ...s0, ctx: ctx0 }, c, getIndex);
  check('跨栏拖选：结果只含左栏', sel.every((p) => p.items.every((i) => i.x < 200)));
}

// 6) 旋转文字排除：指针放在左侧旋转字上
{
  const c = pointToRowChar(p1, 1, 12, p1.lines[lA1].minY - 1, ctx0)!;
  check('旋转文字：命中正文行而非旋转行', c.line === lA1 && p1.lines[c.line].rot === 0);
}

// 7) 页眉排除：指针放在页眉
{
  const c = pointToRowChar(p1, 1, 60, 563.5, ctx0)!;
  check('页眉：命中最近正文行', c.line === lA0);
  check('页眉：同文本块', p1.lines[c.line].block === ctx0.block);
}

// 8) 文本块边界：指针移到下一段（不同 block）不跳入
{
  const c = pointToRowChar(p1, 1, ptAt(p1, lA5, 0).px, ptAt(p1, lA5, 0).py, ctx0)!;
  check('块边界：不跳入下一块', c.line === lA4 && p1.lines[c.line].block === ctx0.block);
}

// 9) 窄起点 → 宽终点：终点行用原始指针 X 取字符
{
  const s = pointToRowChar(p1, 1, ptAt(p1, lA3, 1).px, ptAt(p1, lA3, 1).py)!;
  const ctx = makeSelectionContext(p1, 1, s.line)!;
  const c = pointToRowChar(p1, 1, ptAt(p1, lA4, 10).px, ptAt(p1, lA4, 10).py, ctx)!;
  check('窄起点→宽终点：行号前进', c.line === lA4);
  check('窄起点→宽终点：终点索引取原始 X', c.idx === 10);
  const sel = computeRowSelection({ ...s, ctx }, c, getIndex);
  check(
    '窄起点→宽终点：文本',
    selText(sel) === BODY_A_1[3].text.slice(1) + BODY_A_1[4].text.slice(0, 11),
  );
}

// 10) 相邻行普通向下拖（复现用户报告的场景）
{
  const c = pointToRowChar(p1, 1, ptAt(p1, lA1, 4).px, ptAt(p1, lA1, 4).py, ctx0)!;
  check('相邻行扩展：行号前进', c.line === lA1 && c.row === p1.lines[lA1].row);
  const sel = computeRowSelection({ ...s0, ctx: ctx0 }, c, getIndex);
  check(
    '相邻行扩展：文本',
    selText(sel) === BODY_A_1[0].text.slice(2) + BODY_A_1[1].text.slice(0, 5),
  );
}

// 11) 跨页（p1 → p2）：p1 只含起点块整段，p2 只选到终点字符
{
  const lA0b = findLine(p2, P2.bodyA[0].text);
  const c = pointToRowChar(p2, 2, ptAt(p2, lA0b, 3).px, ptAt(p2, lA0b, 3).py, ctx0)!;
  check('跨页：命中 p2 左栏', Math.abs(p2.lines[c.line].minX - 50) < 0.5 && c.idx === 3);
  const sel = computeRowSelection({ ...s0, ctx: ctx0 }, c, getIndex);
  const expectedP1 = BODY_A_1[0].text.slice(2) + BODY_A_1.slice(1, 5).map((l) => l.text).join('');
  const expectedP2 = P2.bodyA[0].text.slice(0, 4);
  check('跨页：起点页文本', sel[0]?.items.map((i) => i.str).join('') === expectedP1);
  check('跨页：终点页文本', sel[1]?.items.map((i) => i.str).join('') === expectedP2);
  check('跨页：不混入右栏/旋转/页脚', sel.every((p) => p.items.every((i) => i.rot === 0 && i.x < 200)));
}

// 12) 跨页禁止跳栏：指针在 p2 右栏
{
  const lB0b = findLine(p2, P2.bodyB[0].text);
  const c = pointToRowChar(p2, 2, ptAt(p2, lB0b, 0).px, ptAt(p2, lB0b, 0).py, ctx0)!;
  check('跨页跨栏指针：仍命中左栏', Math.abs(p2.lines[c.line].minX - 50) < 0.5);
}

// 13) 三页连续选择：中间页整段完整
{
  const lA0c = findLine(p3, P3.bodyA[0].text);
  const c = pointToRowChar(p3, 3, ptAt(p3, lA0c, 2).px, ptAt(p3, lA0c, 2).py, ctx0)!;
  const sel = computeRowSelection({ ...s0, ctx: ctx0 }, c, getIndex);
  // 中间页按设计整页同栏（跨页不做文本块限制，但右栏/旋转/页眉页脚仍被几何排除）
  const expectedP2 = P2.bodyA.map((l) => l.text).join('');
  check('三页：中间页整栏', sel[1]?.items.map((i) => i.str).join('') === expectedP2);
  check('三页：页数', sel.length === 3);
}

// 14) 拖到块内空白处：仍保持最近行（块锁定）
{
  const c = pointToRowChar(p1, 1, 100, 420, ctx0)!;
  check('块内空白：命中块内最近行', c.line === lA4);
}

// 15) 鼠标在块下方远处（下一块上方）不得跳块
{
  const c = pointToRowChar(p1, 1, 100, 404, ctx0)!;
  check('块下方远处：仍锁定起点块', p1.lines[c.line].block === ctx0.block);
}

// 16) 真实 PDF 回归：窄首行 + 宽公式行必须同栏（列聚类不得按行宽把同一栏拆开）
{
  const pg = buildPage(
    pageSpecs(
      [
        { text: 'Narrow', y0: 500 },
        { text: 'Wide formula line 0123456789', y0: 486 },
        { text: 'Wide second line abcdefghijkl', y0: 472 },
      ],
      [
        { text: 'Right col alpha', y0: 500 },
        { text: 'Right col beta', y0: 486 },
        { text: 'Right col gamma', y0: 472 },
      ],
    ),
  );
  const ln = findLine(pg, 'Narrow');
  const lw = findLine(pg, 'Wide formula line 0123456789');
  check('窄行与宽行同栏', pg.lines[ln].col === pg.lines[lw].col);
  check('宽行与后续宽行同栏', pg.lines[lw].col === pg.lines[findLine(pg, 'Wide second line abcdefghijkl')].col);
  const s = pointToRowChar(pg, 1, ptAt(pg, ln, 1).px, ptAt(pg, ln, 1).py)!;
  const ctx = makeSelectionContext(pg, 1, s.line)!;
  const c = pointToRowChar(pg, 1, ptAt(pg, lw, 5).px, ptAt(pg, lw, 5).py, ctx)!;
  check('窄起点拖到宽行：行号前进', c.line === lw && c.idx === 5);
  const sel = computeRowSelection({ ...s, ctx }, c, () => pg);
  check(
    '窄起点拖到宽行：文本',
    selText(sel) === 'Narrow'.slice(1) + 'Wide formula line 0123456789'.slice(0, 6),
  );
}

// 17) 真实双栏回归：紧邻正文的全宽标题会让左右栏共享同一列 id；
//     从右栏拖选时，中间行仍必须锁定右栏，不能取 rowLines 中排在前面的左栏。
{
  const items: TextItemQuad[] = [];
  items.push(...makeLine({ text: 'FULL WIDTH INTRODUCTION SPANS BOTH COLUMNS COMPLETELY', x0: 50, y0: 514 }));
  const left = [
    { text: 'Left bridge row zero', y0: 500 },
    { text: 'Left bridge row one', y0: 486 },
    { text: 'Left bridge row two', y0: 472 },
  ];
  const right = [
    { text: 'Right bridge row zero', y0: 500 },
    { text: 'Right bridge row one', y0: 486 },
    { text: 'Right bridge row two', y0: 472 },
  ];
  for (const line of left) items.push(...makeLine({ ...line, x0: 50 }));
  for (const line of right) items.push(...makeLine({ ...line, x0: 300 }));
  items.sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  const pg = buildPageIndex(items);
  const r0 = findLine(pg, right[0].text);
  const r2 = findLine(pg, right[2].text);
  const leftMiddle = findLine(pg, left[1].text);
  check('全宽行桥接：左右栏复现为同列 id', pg.lines[r0].col === pg.lines[leftMiddle].col);
  const startPt = ptAt(pg, r0, 2);
  const start = pointToRowChar(pg, 1, startPt.px, startPt.py)!;
  const ctx = makeSelectionContext(pg, 1, start.line)!;
  const endPt = ptAt(pg, r2, 6);
  const end = pointToRowChar(pg, 1, endPt.px, endPt.py, ctx)!;
  const sel = computeRowSelection({ ...start, ctx }, end, () => pg);
  check(
    '全宽行桥接：右栏拖选不混入左栏',
    sel.every((page) => page.items.every((item) => item.x >= 300)),
    selText(sel),
  );
  check(
    '全宽行桥接：右栏中间行被完整保留',
    selText(sel).includes(right[1].text),
    selText(sel),
  );
  const leftEndPt = ptAt(pg, leftMiddle, 4);
  const crossColumnEnd = pointToRowChar(pg, 1, leftEndPt.px, leftEndPt.py, ctx)!;
  check(
    '全宽行桥接：指针移入左栏仍锁定右栏',
    pg.lines[crossColumnEnd.line].minX >= 300,
    lineText(pg, crossColumnEnd.line),
  );
  const l0 = findLine(pg, left[0].text);
  const l2 = findLine(pg, left[2].text);
  const leftStartPt = ptAt(pg, l0, 2);
  const leftStart = pointToRowChar(pg, 1, leftStartPt.px, leftStartPt.py)!;
  const leftCtx = makeSelectionContext(pg, 1, leftStart.line)!;
  const leftSelectionEndPt = ptAt(pg, l2, 6);
  const leftEnd = pointToRowChar(pg, 1, leftSelectionEndPt.px, leftSelectionEndPt.py, leftCtx)!;
  const leftSel = computeRowSelection({ ...leftStart, ctx: leftCtx }, leftEnd, () => pg);
  check(
    '全宽行桥接：左栏拖选不混入右栏',
    leftSel.every((page) => page.items.every((item) => item.x < 300)),
    selText(leftSel),
  );
}

// 18) 复制文本：词间空格补全（PDF 里空格常是“字形间距”而非字符）
{
  const ch = (str: string, x: number, w = 6, baseline = 500, rot = 0, h = 7): TextItemQuad => ({
    x,
    y: baseline - h,
    w,
    h,
    baseline,
    str,
    rot,
  });
  const explicit = [
    ch('h', 0), ch('i', 6), ch(' ', 12, 3), ch('w', 15), ch('o', 21), ch('r', 27), ch('l', 33), ch('d', 39),
  ];
  check('显式空格保留', itemsToText(explicit) === 'hi world');
  const gapOnly = [
    ch('h', 0), ch('i', 6), ch('w', 16), ch('o', 22), ch('r', 28), ch('l', 34), ch('d', 40),
  ];
  check('字形间距补空格', itemsToText(gapOnly) === 'hi world');
  const narrowWordGap = [
    ch('h', 0), ch('i', 6), ch('w', 13.6), ch('o', 19.6), ch('r', 25.6), ch('l', 31.6), ch('d', 37.6),
  ];
  check('较窄词间距仍补空格', itemsToText(narrowWordGap) === 'hi world');
  const tightLetterGap = [ch('a', 0), ch('b', 6.7), ch('c', 13.4)];
  check('紧密字距不误加空格', itemsToText(tightLetterGap) === 'abc');
  const cjk = [ch('中', 0), ch('文', 11)];
  check('中文不误加空格', itemsToText(cjk) === '中文');
  const mixed = [ch('请', 0), ch('e', 10), ch('x', 16), ch('a', 22)];
  check('中英混合补空格', itemsToText(mixed) === '请 exa');
  const punct = [ch('s', 0), ch('t', 6), ch('.', 12), ch('T', 22)];
  check('标点后补空格', itemsToText(punct) === 'st. T');
  const rot = [ch('a', 0, 6, 500, 90), ch('b', 14, 6, 500, 90)];
  check('旋转文本不补空格', itemsToText(rot) === 'ab');
  const cross = [ch('a', 0), ch('b', 30, 6, 480)];
  check('跨行补空格', itemsToText(cross) === 'a b');
  const wrapped = [ch('a', 0), ch('p', 6), ch('p', 12), ch('r', 18), ch('o', 24), ch('a', 30), ch('c', 36), ch('h', 42), ch('e', 48), ch('s', 54), ch('i', 0, 6, 480), ch('n', 6, 6, 480)];
  check('视觉换行不粘词', itemsToText(wrapped) === 'approaches in');
  const control = [ch('G', 0), ch('\u0002', 6), ch('a', 12), ch('n', 18), ch('d', 24)];
  check('PDF 控制连字符正规化', itemsToText(control) === 'G-and');
}

// 19) 虚拟滚动页码与缩放锚点：不依赖页面 DOM，缩放后仍停留在同一页内位置
{
  const oldLayout = {
    rows: [[1], [2], [3], [4]],
    tops: [12, 820, 1628, 2436],
    rowHs: [800, 800, 800, 800],
  };
  check('虚拟页码：未挂载 DOM 也能识别第 3 页', pageAtScrollPosition(oldLayout, 1700, 700) === 3);
  const newLayout = {
    rows: [[1], [2], [3], [4]],
    tops: [12, 1220, 2428, 3636],
    rowHs: [1200, 1200, 1200, 1200],
  };
  const mapped = remapScrollPosition(oldLayout, newLayout, 1828);
  check('缩放锚点：仍在第 3 页', pageAtScrollPosition(newLayout, mapped, 700) === 3);
  check('缩放锚点：保持页内 25% 位置', Math.abs(mapped - (2428 + 300)) < 0.01);
  const cursorAnchored = remapScrollPositionAtViewport(oldLayout, newLayout, 1600, 428);
  check('滚轮缩放：鼠标下内容位置不动', Math.abs(cursorAnchored - 2600) < 0.01);

  // 非等高/旋转页面：页码跳转、滚动页码跟踪、布局变化与重启恢复共用同一锚点。
  const mixedLayout = {
    rows: [[1], [2], [3], [4], [5]],
    tops: [12, 620, 1836, 2474, 4090],
    rowHs: [600, 1208, 630, 1608, 720],
  };
  const page4Middle = { page: 4, offsetRatio: 0.43 };
  const page4Scroll = scrollPositionForReadingAnchor(mixedLayout, page4Middle, 780);
  const recovered = readingAnchorAtScrollPosition(mixedLayout, page4Scroll, 780);
  check('非等高页面：页码跳转准确落到目标页', recovered.page === 4);
  check('非等高页面：重启后恢复相同页内位置', Math.abs(recovered.offsetRatio - 0.43) < 0.001);
  const resizedLayout = {
    rows: [[1], [2], [3], [4], [5]],
    tops: [12, 772, 2284, 3079, 5089],
    rowHs: [752, 1504, 787, 2002, 900],
  };
  const resizedScroll = scrollPositionForReadingAnchor(resizedLayout, recovered, 1040);
  const resizedAnchor = readingAnchorAtScrollPosition(resizedLayout, resizedScroll, 1040);
  check('非等高页面：全屏/缩放后仍是同一页', resizedAnchor.page === 4);
  check('非等高页面：全屏/缩放后页内比例不变', Math.abs(resizedAnchor.offsetRatio - 0.43) < 0.001);
  const afterUserScroll = readingAnchorAtScrollPosition(resizedLayout, resizedScroll + 1550, 1040);
  check('跳页后继续滚动：页码不冻结', afterUserScroll.page === 5);
}

console.log(failed ? `\n${failed} 个断言失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
