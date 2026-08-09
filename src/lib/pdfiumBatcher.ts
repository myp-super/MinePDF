import type { PdfiumRenderResult } from '../shared/types';

/**
 * PDFium 渲染请求合并器（渲染进程）
 *
 * 视图滚动/缩放时，同一帧内多页会同时请求渲染。这里把 ~12ms 窗口内的
 * 请求按 (pdfId, 缩放桶) 合并为一次 IPC 批量渲染，显著降低往返开销。
 */
interface Request {
  pdfId: number;
  page: number;
  scale: number;
  resolve: (r: PdfiumRenderResult) => void;
  reject: (e: unknown) => void;
}

const pending = new Map<string, Request>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function pdfiumRenderQueued(
  pdfId: number,
  page: number,
  scale: number,
): Promise<PdfiumRenderResult> {
  const key = `${pdfId}:${page}`;
  return new Promise<PdfiumRenderResult>((resolve, reject) => {
    const prev = pending.get(key);
    // 同页已有更早请求：让其随下一批一起返回（seq 会丢弃过期结果），
    // 只保留最新请求，避免并发重复渲染同一页。
    if (prev) pending.delete(key);
    pending.set(key, { pdfId, page, scale, resolve, reject });
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), 12);
  });
}

async function flush(): Promise<void> {
  flushTimer = null;
  const items = [...pending.values()];
  pending.clear();
  if (!items.length) return;

  // 按 (pdfId, 缩放桶) 分组：同组共享一次批量 IPC
  const groups = new Map<string, Request[]>();
  for (const it of items) {
    const bucket = Math.max(0.5, Math.round(it.scale * 2) / 2);
    const gk = `${it.pdfId}:${bucket}`;
    const list = groups.get(gk) ?? [];
    list.push(it);
    groups.set(gk, list);
  }

  await Promise.all(
    [...groups.values()].map(async (list) => {
      const scale = Math.max(...list.map((i) => i.scale));
      const pages = list.map((i) => i.page);
      try {
        const results = await window.pkm.pdfiumRenderBatch(list[0].pdfId, pages, scale);
        list.forEach((req, idx) => {
          const res = results[idx];
          if (res) req.resolve({ ...res, ms: res.ms });
          else req.reject(new Error('ERR_PDF_RENDER_FAILED:批量渲染结果缺失'));
        });
      } catch (err) {
        for (const req of list) req.reject(err);
      }
    }),
  );
}
