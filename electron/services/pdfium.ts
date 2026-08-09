/**
 * PDFium 原生渲染服务（主进程）
 *
 * 2.0.0 渲染架构：PDFium 负责出像素（原生 C++，速度快、无尖峰），
 * PDF.js 只保留文本层/书签/链接等交互能力。本模块通过 koffi (N-API FFI)
 * 直接调用随包分发的 pdfium.dll。
 *
 * PDFium 打开文档仅需 ~1ms，因此每次渲染即时打开/关闭、不保留文档缓存：
 * - 文件句柄不会长期占用（Windows 删除/移动 PDF 不会被锁）；
 * - 内存占用最小化，切换文档仍接近零成本。
 * 渲染结果以 RGBA ArrayBuffer 通过 IPC 回传渲染进程，
 * 由渲染端绘制到 canvas 并叠加 PDF.js 文本层。
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import koffi from 'koffi';
import { repository } from '../db/repository';

export interface PdfiumOpenResult {
  /** PDF 页数（1 起） */
  pageCount: number;
  /** 第 1 页尺寸（pt，已含页面旋转） */
  width: number;
  height: number;
  /** pdfium 版本号 */
  version: string;
}

export interface PdfiumRenderResult {
  w: number;
  h: number;
  /** RGBA 像素，w*h*4 字节 */
  data: ArrayBuffer;
  /** 渲染耗时 ms（调试用） */
  ms: number;
}

interface PdfiumApi {
  init: () => void;
  destroyLib: () => void;
  loadDoc: (path: string | null, password: string | null) => unknown;
  pageCount: (doc: unknown) => number;
  loadPage: (doc: unknown, index: number) => unknown;
  closePage: (page: unknown) => void;
  closeDoc: (doc: unknown) => void;
  pageSize: (doc: unknown, index: number, size: unknown) => number;
  createBitmap: (w: number, h: number, format: number, first: unknown, stride: number) => unknown;
  destroyBitmap: (bmp: unknown) => void;
  fillRect: (bmp: unknown, left: number, top: number, w: number, h: number, color: number) => number;
  getBuffer: (bmp: unknown) => unknown;
  render: (
    bmp: unknown,
    page: unknown,
    x: number,
    y: number,
    sx: number,
    sy: number,
    rotate: number,
    flags: number,
  ) => void;
}

// ---------- PDFium 位图格式 / 渲染标志（fpdfview.h） ----------
const FPDFBitmap_BGRA = 4;
const FPDF_ANNOT = 0x01;
const FPDF_LCD_TEXT = 0x02;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const FPDF_RENDER_LIMITEDIMAGECACHE = 0x200;
const RENDER_FLAGS =
  FPDF_ANNOT | FPDF_LCD_TEXT | FPDF_REVERSE_BYTE_ORDER | FPDF_RENDER_LIMITEDIMAGECACHE;

/** 单页最大渲染尺寸，防止异常 PDF 撑爆内存（6000px x 4B = 144MB 上限） */
const MAX_PAGE_DIM = 6000;
const MAX_SCALE = 4;

const FS_SIZEF = koffi.struct('FS_SIZEF', { width: 'float', height: 'float' });

let lib: PdfiumApi | null = null;
let libTried = false;
let dllVersion = '';

function resolveDllPath(): string | null {
  // 打包后位于 resources/pdfium（extraResources），开发时位于项目 resources/
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'pdfium')
    : path.join(app.getAppPath(), 'resources', 'pdfium');
  const dll = path.join(base, 'win-x64', 'bin', 'pdfium.dll');
  return fs.existsSync(dll) ? dll : null;
}

function readVersion(): string {
  try {
    const base = app.isPackaged
      ? path.join(process.resourcesPath, 'pdfium')
      : path.join(app.getAppPath(), 'resources', 'pdfium');
    const v = fs
      .readFileSync(path.join(base, 'win-x64', 'VERSION'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (l.split('=')[1] ?? '').trim())
      .join('.')
      .replace(/\.+$/, '');
    return v || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 惰性加载 pdfium.dll；不可用时返回 null（渲染端回退 PDF.js） */
function ensureLib(): PdfiumApi | null {
  if (libTried) return lib;
  libTried = true;
  try {
    const dll = resolveDllPath();
    if (!dll) {
      console.warn('[pdfium] dll not found, using PDF.js fallback');
      return null;
    }
    const k = koffi.load(dll);
    lib = {
      init: k.func('void FPDF_InitLibrary()'),
      destroyLib: k.func('void FPDF_DestroyLibrary()'),
      loadDoc: k.func('void *FPDF_LoadDocument(const char *path, const char *password)'),
      pageCount: k.func('int FPDF_GetPageCount(void *doc)'),
      loadPage: k.func('void *FPDF_LoadPage(void *doc, int index)'),
      closePage: k.func('void FPDF_ClosePage(void *page)'),
      closeDoc: k.func('void FPDF_CloseDocument(void *doc)'),
      pageSize: k.func('int FPDF_GetPageSizeByIndexF(void *doc, int index, FS_SIZEF *size)'),
      createBitmap: k.func(
        'void *FPDFBitmap_CreateEx(int w, int h, int format, void *first, int stride)',
      ),
      destroyBitmap: k.func('void FPDFBitmap_Destroy(void *bmp)'),
      fillRect: k.func(
        'int FPDFBitmap_FillRect(void *bmp, int left, int top, int w, int h, unsigned int color)',
      ),
      getBuffer: k.func('void *FPDFBitmap_GetBuffer(void *bmp)'),
      render: k.func(
        'void FPDF_RenderPageBitmap(void *bmp, void *page, int x, int y, int sx, int sy, int rotate, int flags)',
      ),
    };
    lib.init();
    dllVersion = readVersion();
    console.log(`[pdfium] loaded v${dllVersion} from ${dll}`);
  } catch (err) {
    console.warn('[pdfium] load failed, using PDF.js fallback:', err);
    lib = null;
  }
  return lib;
}

function getPdfPath(pdfId: number): string {
  const pdf = repository.getPdf(pdfId);
  if (!pdf) throw new Error('ERR_PDF_MISSING:知识库中不存在该记录');
  if (!fs.existsSync(pdf.filepath)) {
    repository.setPdfStatus(pdfId, 'missing');
    throw new Error('ERR_PDF_MISSING:文件不存在或已被移动');
  }
  if (pdf.status === 'missing') repository.setPdfStatus(pdfId, 'ok');
  return pdf.filepath;
}

/** PDFium 是否可用（首次调用会触发 DLL 加载） */
export function isPdfiumAvailable(): boolean {
  return ensureLib() != null;
}

/** 打开文档读取基本信息后立即关闭；PDFium 不可用时返回 null */
export function pdfiumOpen(pdfId: number): PdfiumOpenResult | null {
  const api = ensureLib();
  if (!api) return null;
  const filepath = getPdfPath(pdfId);
  const doc = api.loadDoc(filepath, null);
  if (!doc) throw new Error('ERR_PDF_OPEN_FAILED:PDFium 无法打开该文件');
  const size = koffi.alloc(FS_SIZEF, 1);
  try {
    const pageCount = api.pageCount(doc);
    let width = 0;
    let height = 0;
    if (pageCount > 0 && api.pageSize(doc, 0, size)) {
      const s = koffi.decode(size, 'FS_SIZEF') as { width: number; height: number };
      width = s.width;
      height = s.height;
    }
    return { pageCount, width, height, version: dllVersion };
  } finally {
    koffi.free(size);
    try {
      api.closeDoc(doc);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 渲染指定页为 RGBA 位图。
 * page 从 1 开始；scale 为 100% 对应的倍数（CSS 像素/PDF pt），
 * 主进程按设备像素渲染（渲染端已传入 dpr），并做尺寸上限保护。
 */
export function pdfiumRender(pdfId: number, page: number, scale: number): PdfiumRenderResult {
  const api = ensureLib();
  if (!api) throw new Error('PDFIUM_UNAVAILABLE');
  const tLog = process.env.PKM_SMOKE_TEST === '1' ? performance.now() : 0;
  const filepath = getPdfPath(pdfId);
  const tPath = performance.now();
  const doc = api.loadDoc(filepath, null);
  const tLoad = performance.now();
  if (!doc) throw new Error('ERR_PDF_OPEN_FAILED:PDFium 无法打开该文件');
  const pageIndex = Math.max(0, Math.min(api.pageCount(doc) - 1, Math.floor(page) - 1));

  const sizePtr = koffi.alloc(FS_SIZEF, 1);
  let pageW = 0;
  let pageH = 0;
  let tSize0 = 0;
  let tSize = 0;
  try {
    tSize0 = performance.now();
    if (!api.pageSize(doc, pageIndex, sizePtr)) {
      throw new Error('ERR_PDF_RENDER_FAILED:无法获取页面尺寸');
    }
    tSize = performance.now();
    const s = koffi.decode(sizePtr, 'FS_SIZEF') as { width: number; height: number };
    pageW = s.width;
    pageH = s.height;
  } finally {
    koffi.free(sizePtr);
  }

  // 尺寸保护：限制缩放倍数与最大像素尺寸
  const safeScale = Math.min(MAX_SCALE, scale);
  const wRaw = Math.max(1, Math.round(pageW * safeScale));
  const hRaw = Math.max(1, Math.round(pageH * safeScale));
  const fit = Math.min(1, MAX_PAGE_DIM / wRaw, MAX_PAGE_DIM / hRaw);
  const w = Math.max(1, Math.round(wRaw * fit));
  const h = Math.max(1, Math.round(hRaw * fit));

  const pageHandle = api.loadPage(doc, pageIndex);
  const tPage = performance.now();
  if (!pageHandle) throw new Error('ERR_PDF_RENDER_FAILED:无法加载页面');
  const stride = w * 4;
  const bufPtr = koffi.alloc('uint8_t', stride * h);
  const bmp = api.createBitmap(w, h, FPDFBitmap_BGRA, bufPtr, stride);
  if (!bmp) {
    koffi.free(bufPtr);
    api.closePage(pageHandle);
    api.closeDoc(doc);
    throw new Error('ERR_PDF_RENDER_FAILED:无法创建位图');
  }

  try {
    const tFill = performance.now();
    api.fillRect(bmp, 0, 0, w, h, 0xffffffff);
    const t0 = performance.now();
    api.render(bmp, pageHandle, 0, 0, w, h, 0, RENDER_FLAGS);
    const ms = performance.now() - t0;
    const raw = koffi.decode(bufPtr, 'uint8_t', stride * h) as Uint8Array;
    const tDecode = performance.now();
    // koffi.decode 返回独立缓冲；若带偏移则截取一次，否则直接复用避免多余拷贝
    const data =
      raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? (raw.buffer as ArrayBuffer)
        : (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
    const tReturn = performance.now();
    if (process.env.PKM_SMOKE_TEST === '1') {
      console.log(
        `[pdfium:timing] page=${page} total=${(tReturn - tLog).toFixed(1)}ms ` +
          `path=${(tPath - tLog).toFixed(1)} load=${(tLoad - tPath).toFixed(1)} ` +
          `size=${(tSize - tSize0).toFixed(1)} page=${(tPage - tSize).toFixed(1)} ` +
          `fill=${(tFill - tPage).toFixed(1)} render=${ms.toFixed(1)} decode=${(tDecode - t0).toFixed(1)} ` +
          `buffer=${(tReturn - tDecode).toFixed(1)}`,
      );
    }
    return { w, h, data, ms };
  } finally {
    api.destroyBitmap(bmp);
    api.closePage(pageHandle);
    koffi.free(bufPtr);
    try {
      api.closeDoc(doc);
    } catch {
      /* ignore */
    }
  }
}

/** 批量渲染：一次 IPC 往返渲染多页（同缩放），避免逐页往返开销 */
export function pdfiumRenderBatch(
  pdfId: number,
  pages: number[],
  scale: number,
): PdfiumRenderResult[] {
  return pages.map((p) => pdfiumRender(pdfId, p, scale));
}

/** 兼容接口：文档即时开关，无需主动关闭 */
export function pdfiumClose(_pdfId: number): void {
  /* no-op */
}

/** 应用退出时释放 pdfium 资源 */
export function pdfiumShutdown(): void {
  try {
    lib?.destroyLib();
  } catch {
    /* ignore */
  }
}
