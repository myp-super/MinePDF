/**
 * PDF 渲染运行时诊断（默认关闭，Ctrl+Shift+D 切换显示）。
 * 记录每个可见页面的真实渲染链路数据，用于定位“打包后模糊”的根因：
 * bitmap 实际像素 / canvas 背板 / CSS 显示尺寸 / devicePixelRatio / 主进程缩放。
 */
export interface PageRenderDiag {
  pageNumber: number;
  /** 渲染引擎：pdfium / pdfjs */
  engine: 'pdfium' | 'pdfjs';
  /** PDF 物理尺寸（pt） */
  baseW: number;
  baseH: number;
  /** 用户缩放（CSS px / pt） */
  zoom: number;
  dpr: number;
  deviceScale: number;
  bucket: number;
  cacheHit: boolean;
  renderMs: number;
  bitmapW: number;
  bitmapH: number;
  canvasBackingW: number;
  canvasBackingH: number;
  canvasClientW: number;
  canvasClientH: number;
  rectW: number;
  rectH: number;
  /** bitmap 像素 / CSS 显示像素（> dpr 说明超采样，= dpr 是 1:1，< dpr 就是分辨率不足） */
  densityX: number;
  densityY: number;
  ts: number;
}

export interface RenderDiagState {
  enabled: boolean;
  latest: PageRenderDiag | null;
}

type Listener = (s: RenderDiagState) => void;

const listeners = new Set<Listener>();
let enabled = false;
let latest: PageRenderDiag | null = null;

function emit(): void {
  const s: RenderDiagState = { enabled, latest };
  for (const l of listeners) l(s);
}

export const renderDiag = {
  getState(): RenderDiagState {
    return { enabled, latest };
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setEnabled(v: boolean): void {
    enabled = v;
    emit();
  },
  toggle(): void {
    enabled = !enabled;
    emit();
  },
  record(d: PageRenderDiag): void {
    latest = d;
    emit();
  },
};
