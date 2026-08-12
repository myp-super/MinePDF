import * as pdfjsLib from 'pdfjs-dist';
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Quad } from '../shared/types';

export { pdfjsLib };
export type { PDFDocumentProxy };

let configured = false;

/** 配置 PDF.js worker（Vite 打包为 Blob Worker，兼容 Electron file:// 环境） */
export function setupPdfjs(): void {
  if (configured) return;
  configured = true;
  try {
    pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker();
  } catch {
    // 创建 worker 失败时回退到主线程执行
  }
}

/** 页面视口最小接口（PDF 坐标 <-> 视口像素） */
export interface ViewportLike {
  width: number;
  height: number;
  /** 当前缩放系数（PDF pt -> 视口像素） */
  scale: number;
  convertToViewportPoint(x: number, y: number): number[];
  convertToPdfPoint(x: number, y: number): number[];
}

export interface SearchMatch {
  page: number;
  quads: Quad[];
  text: string;
}

/** PDF 书签（目录）节点 */
export interface OutlineNode {
  title: string;
  /** 目标页（1 起），解析失败为 null */
  page: number | null;
  /** 页内 y 坐标（PDF 用户空间，y-up；无坐标时为 null），用于同页书签精确跳转 */
  top: number | null;
  children: OutlineNode[];
}

/** 将 PDF 内置书签（/Outlines）解析为树结构，并换算为 1 起页码 */
export async function getOutlineTree(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  let outline;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!outline || !outline.length) return [];

  const resolveDest = async (
    dest: unknown,
  ): Promise<{ page: number | null; top: number | null }> => {
    if (!dest) return { page: null, top: null };
    let ref: unknown = null;
    let arr: unknown[] = [];
    if (typeof dest === 'string') {
      try {
        const d = await doc.getDestination(dest);
        if (Array.isArray(d) && d.length) {
          arr = d;
          ref = d[0];
        }
      } catch {
        return { page: null, top: null };
      }
    } else if (Array.isArray(dest) && dest.length) {
      arr = dest;
      ref = dest[0];
    }
    if (!ref || typeof ref !== 'object') return { page: null, top: null };
    // dest 形如 [pageRef, {name:'XYZ'} | 'XYZ', left, top, zoom]；仅 XYZ 提供页内坐标
    let top: number | null = null;
    const destName =
      arr[1] && typeof arr[1] === 'object' && 'name' in (arr[1] as object)
        ? (arr[1] as { name?: unknown }).name
        : arr[1];
    if (destName === 'XYZ' && typeof arr[3] === 'number') top = arr[3] as number;
    try {
      const index = await doc.getPageIndex(ref as never);
      return { page: typeof index === 'number' ? index + 1 : null, top };
    } catch {
      return { page: null, top };
    }
  };

  const walk = async (items: Array<{ title?: string; dest?: unknown; items?: unknown[] }>): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const item of items) {
      const { page, top } = await resolveDest(item.dest);
      const children = Array.isArray(item.items) && item.items.length ? await walk(item.items as never[]) : [];
      out.push({ title: item.title ?? '', page, top, children });
    }
    return out;
  };

  return walk(outline as never[]);
}

/**
 * 全文搜索：逐页提取文本并定位命中词所在的文本项，
 * 将 PDF 坐标作为高亮矩形返回。
 */
export async function searchInDocument(doc: PDFDocumentProxy, query: string): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const lq = query.toLowerCase();
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = (tc.items as Array<Record<string, unknown>>)
      .filter((it) => typeof it.str === 'string')
      .map((it) => ({
        str: it.str as string,
        transform: (it.transform as number[]) ?? [1, 0, 0, 1, 0, 0],
        width: Number(it.width ?? 0),
        height: Number(it.height ?? 12),
      }));

    let full = '';
    const starts: number[] = [];
    for (const it of items) {
      starts.push(full.length);
      full += it.str + ' ';
    }

    const lfull = full.toLowerCase();
    let idx = lfull.indexOf(lq);
    while (idx !== -1) {
      const end = idx + query.length;
      const quads: Quad[] = [];
      for (let i = 0; i < starts.length; i++) {
        const s = starts[i];
        const e = s + items[i].str.length;
        if (s <= end && e >= idx) {
          const t = items[i].transform;
          quads.push({ x: t[4], y: t[5], w: items[i].width, h: items[i].height || 12 });
        }
      }
      matches.push({ page: p, quads, text: full.slice(idx, end).trim() });
      idx = lfull.indexOf(lq, idx + query.length);
    }
  }
  return matches;
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(253, 224, 71, ${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
