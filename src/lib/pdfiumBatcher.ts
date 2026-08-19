import type { PdfiumRenderResult } from '../shared/types';

/**
 * PDFium 渲染请求合并器（渲染进程）
 *
 * 视图滚动/缩放时，同一帧内多页会同时请求渲染。这里把 ~12ms 窗口内的
 * 请求按 (paneId, pdfId, 缩放桶) 合并为一次 IPC 批量渲染，显著降低往返开销。
 *
 * paneId 是阅读屏/阅读器实例的唯一标识：分屏时同一 PDF 可能在多个屏同时打开，
 * 若只按 (pdfId, page) 去重，后到的请求会覆盖前一个屏的请求，导致该屏永远
 * 等不到渲染结果（表现为“渲染失败/无法缩放”）。
 */
interface Request {
  paneId: string;
  pdfId: number;
  page: number;
  scale: number;
  resolve: (r: PdfiumRenderResult) => void;
  reject: (e: unknown) => void;
}

const pending = new Map<string, Request>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function pdfiumRenderQueued(
  paneId: string,
  pdfId: number,
  page: number,
  scale: number,
): Promise<PdfiumRenderResult> {
  const key = `${paneId}:${pdfId}:${page}`;
  return new Promise<PdfiumRenderResult>((resolve, reject) => {
    const prev = pending.get(key);
    // 同一阅读屏同一页已有更早请求：旧请求已过期，显式拒绝使其回退渲染，
    // 避免 Promise 永不落定导致页面一直停留在加载态。
    if (prev) pending.delete(key);
    pending.set(key, { paneId, pdfId, page, scale, resolve, reject });
    if (prev) prev.reject(new Error('ERR_PDF_RENDER_SUPERSEDED'));
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), 12);
  });
}

async function flush(): Promise<void> {
  flushTimer = null;
  const items = [...pending.values()];
  pending.clear();
  if (!items.length) return;

  // 按 (pdfId, 精确倍率) 分组：同组共享一次批量 IPC；
  // 倍率不再归并到 0.5 桶，避免“组内取最大值”导致部分页面位图被二次缩小
  const groups = new Map<string, Request[]>();
  for (const it of items) {
    const bucket = Math.max(0.5, Math.round(it.scale * 1000) / 1000);
    const gk = `${it.pdfId}:${bucket}`;
    const list = groups.get(gk) ?? [];
    list.push(it);
    groups.set(gk, list);
  }

  // 串行渲染各组，避免多组大位图并发转换造成主线程峰值卡顿
  for (const list of groups.values()) {
    // 组内所有请求倍率一致（精确分组），直接取组内值即可
    const scale = list[0].scale;
    // 不同屏可能同时请求同一页，按页去重后批量渲染一次即可
    const byPage = new Map<number, Request[]>();
    for (const it of list) {
      const arr = byPage.get(it.page) ?? [];
      arr.push(it);
      byPage.set(it.page, arr);
    }
    const pages = [...byPage.keys()];
    try {
      const results = await window.pkm.pdfiumRenderBatch(list[0].pdfId, pages, scale);
      pages.forEach((page, idx) => {
        const res = results[idx];
        const reqs = byPage.get(page) ?? [];
        if (!res) {
          for (const req of reqs) req.reject(new Error('ERR_PDF_RENDER_FAILED:批量渲染结果缺失'));
          return;
        }
        for (const req of reqs) req.resolve({ ...res, ms: res.ms });
      });
    } catch (err) {
      for (const req of list) req.reject(err);
    }
  }
}
