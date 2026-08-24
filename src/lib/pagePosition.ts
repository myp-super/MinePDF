export interface PagePositionLayout {
  rows: number[][];
  tops: number[];
  rowHs: number[];
}

/** 阅读位置的唯一表达：某一页（双页模式下为所在行）及该页内的纵向比例。 */
export interface ReadingAnchor {
  page: number;
  offsetRatio: number;
}

export function readingProbeOffset(clientHeight: number): number {
  return Math.min(140, Math.max(24, Math.max(0, clientHeight) * 0.18));
}

function rowAtDocumentPosition(layout: PagePositionLayout, position: number): number {
  let lo = 0;
  let hi = layout.tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((layout.tops[mid] ?? 0) <= position) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, Math.min(layout.rows.length - 1, lo - 1));
}

/** 从滚动位置提取稳定的阅读锚点；视口探针可避免页缝附近抖动。 */
export function readingAnchorAtScrollPosition(
  layout: PagePositionLayout,
  scrollTop: number,
  clientHeight: number,
): ReadingAnchor {
  if (!layout.rows.length) return { page: 1, offsetRatio: 0 };
  const probe = Math.max(0, scrollTop) + readingProbeOffset(clientHeight);
  const rowIndex = rowAtDocumentPosition(layout, probe);
  const top = layout.tops[rowIndex] ?? 0;
  const height = Math.max(1, layout.rowHs[rowIndex] ?? 1);
  return {
    page: layout.rows[rowIndex]?.[0] ?? 1,
    // 锚点必须保存探针本身的位置；页缝附近若改用 viewport 顶部会被截成 0，窗口变化后吸附到下一页页首。
    offsetRatio: Math.min(1, Math.max(0, (probe - top) / height)),
  };
}

/** 把阅读锚点转换回滚动位置，供跳页、缩放、全屏和会话恢复共用。 */
export function scrollPositionForReadingAnchor(
  layout: PagePositionLayout,
  anchor: ReadingAnchor,
  _clientHeight: number,
): number {
  if (!layout.rows.length) return 0;
  const rowIndex = layout.rows.findIndex((row) => row.includes(Math.max(1, anchor.page)));
  const safeRow = rowIndex >= 0 ? rowIndex : Math.max(0, layout.rows.length - 1);
  const top = layout.tops[safeRow] ?? 0;
  const height = Math.max(1, layout.rowHs[safeRow] ?? 1);
  const ratio = Math.min(1, Math.max(0, anchor.offsetRatio));
  return Math.max(0, top + ratio * height - readingProbeOffset(_clientHeight));
}

/** 根据完整虚拟布局判断阅读页，不依赖当前是否挂载了对应页面 DOM。 */
export function pageAtScrollPosition(
  layout: PagePositionLayout,
  scrollTop: number,
  clientHeight: number,
): number {
  return readingAnchorAtScrollPosition(layout, scrollTop, clientHeight).page;
}

/**
 * 布局高度变化（缩放、单双页、真实页尺寸落地）时，把旧滚动位置映射到同一页内比例。
 * 这样进入/退出沉浸模式不会因为像素高度变化而跳到别页。
 */
export function remapScrollPosition(
  previous: PagePositionLayout,
  next: PagePositionLayout,
  scrollTop: number,
): number {
  if (!previous.rows.length || !next.rows.length) return Math.max(0, scrollTop);
  let lo = 0;
  let hi = previous.tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((previous.tops[mid] ?? 0) <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const oldRow = Math.max(0, Math.min(previous.rows.length - 1, lo - 1));
  const anchorPage = previous.rows[oldRow]?.[0];
  if (!anchorPage) return Math.max(0, scrollTop);
  const nextRow = next.rows.findIndex((row) => row.includes(anchorPage));
  if (nextRow < 0) return Math.max(0, scrollTop);
  const oldTop = previous.tops[oldRow] ?? 0;
  const oldHeight = Math.max(1, previous.rowHs[oldRow] ?? 1);
  const ratio = Math.min(1, Math.max(0, (scrollTop - oldTop) / oldHeight));
  return Math.max(0, (next.tops[nextRow] ?? 0) + ratio * Math.max(1, next.rowHs[nextRow] ?? 1));
}

/** 缩放时保持视口内某个锚点（通常是鼠标位置）对应的 PDF 内容不动。 */
export function remapScrollPositionAtViewport(
  previous: PagePositionLayout,
  next: PagePositionLayout,
  scrollTop: number,
  viewportOffset: number,
): number {
  const documentAnchor = Math.max(0, scrollTop) + Math.max(0, viewportOffset);
  return Math.max(0, remapScrollPosition(previous, next, documentAnchor) - Math.max(0, viewportOffset));
}
