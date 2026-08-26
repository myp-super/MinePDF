import { app, nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import * as ort from 'onnxruntime-node';
import type { FormulaModelStatus } from '../../src/shared/types';
import { getSettings } from './settings';

const MODEL_NAME = 'RapidLaTeXOCR (ONNX)';
const MODEL_PATH = '/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0';
const MODEL_SOURCES = [
  'https://ghfast.top/https://github.com',
  'https://ghfile.geekertao.top/https://github.com',
  'https://github.com',
];
const FILES = [
  { name: 'image_resizer.onnx', bytes: 38_967_751, sha256: 'E0B075C39700F64D50400F39C8FC186BBB3B5D84D31864008313F376603ACA9D' },
  { name: 'encoder.onnx', bytes: 89_008_136, sha256: '01BF5DC25539CA0CD5B1BD29296EA495977A6BA5F629DC4178277809D26E5E7D' },
  { name: 'decoder.onnx', bytes: 50_952_726, sha256: 'BD695497BF1B22279B7626F5916C79226E1E244C84355F8DA7EDFD2D921D0072' },
  { name: 'tokenizer.json', bytes: 24_174, sha256: '1DC27B18D6A518D0D5FF3F4BB7BD98521FE80AD39E5B2A246D4109F1BB9D5019' },
] as const;
const TOTAL_BYTES = FILES.reduce((sum, item) => sum + item.bytes, 0);

type Listener = (status: FormulaModelStatus) => void;
let status: FormulaModelStatus = {
  state: 'not-downloaded', progress: 0, bytesDownloaded: 0, totalBytes: TOTAL_BYTES,
  modelName: MODEL_NAME, installedBytes: 0,
};
let downloadPromise: Promise<FormulaModelStatus> | null = null;
let sessions: { resizer: ort.InferenceSession; encoder: ort.InferenceSession; decoder: ort.InferenceSession } | null = null;
let tokenizer: Map<number, string> | null = null;
const listeners = new Set<Listener>();

function modelDir(): string { return path.join(app.getPath('userData'), 'models', 'formula', 'rapid-latex-ocr'); }
function filePath(name: string): string { return path.join(modelDir(), name); }
function cloneStatus(): FormulaModelStatus { return { ...status }; }
function emit(next: Partial<FormulaModelStatus>): void {
  status = { ...status, ...next };
  const value = cloneStatus();
  for (const listener of listeners) listener(value);
}
export function onFormulaModelProgress(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }

function installed(): boolean {
  return FILES.every((item) => {
    try { return fs.statSync(filePath(item.name)).size === item.bytes; } catch { return false; }
  });
}
function installedBytes(): number {
  return FILES.reduce((sum, item) => {
    try { return sum + fs.statSync(filePath(item.name)).size; } catch { return sum; }
  }, 0);
}
export function getFormulaModelStatus(): FormulaModelStatus {
  if (status.state !== 'downloading') {
    const ready = installed();
    status = { ...status, state: ready ? 'ready' : 'not-downloaded', progress: ready ? 1 : 0, bytesDownloaded: ready ? TOTAL_BYTES : 0, installedBytes: installedBytes(), error: undefined };
  }
  return cloneStatus();
}

function sourceUrls(): string[] {
  const custom = getSettings().translation.formulaModelSources ?? [];
  return [...custom, ...MODEL_SOURCES].map((value) => value.trim().replace(/\/+$/, '')).filter((value, index, list) => /^https:\/\//i.test(value) && list.indexOf(value) === index);
}

async function verifyFile(file: typeof FILES[number]): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath(file.name));
    if (stat.size !== file.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath(file.name))) hash.update(chunk);
    return hash.digest('hex').toUpperCase() === file.sha256;
  } catch { return false; }
}

async function probeSource(source: string): Promise<{ source: string; latency: number }> {
  const controller = new AbortController();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(source + MODEL_PATH + '/tokenizer.json', {
      redirect: 'follow',
      headers: { Range: 'bytes=0-1023' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error('unavailable');
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    if (first.done || !first.value?.length) throw new Error('empty');
    return { source, latency: Date.now() - started };
  } finally { clearTimeout(timeout); }
}

async function rankedSources(): Promise<string[]> {
  const sources = sourceUrls();
  const probed = await Promise.all(sources.map((source) => probeSource(source).catch(() => null)));
  const available = probed.filter((item): item is { source: string; latency: number } => Boolean(item)).sort((a, b) => a.latency - b.latency).map((item) => item.source);
  return [...available, ...sources.filter((source) => !available.includes(source))];
}

async function downloadFile(name: string, sources: string[], onBytes: (absoluteBytes: number) => void): Promise<void> {
  const item = FILES.find((entry) => entry.name === name)!;
  const part = path.join(modelDir(), name + '.part');
  await fs.promises.mkdir(modelDir(), { recursive: true });
  let lastError = 'Model download failed';
  for (const source of sources) {
    let partial = 0;
    try { partial = (await fs.promises.stat(part)).size; } catch { /* no partial */ }
    if (partial > item.bytes) { await fs.promises.rm(part, { force: true }); partial = 0; }
    let output: fs.WriteStream | null = null;
    try {
      const headers: Record<string, string> = {};
      if (partial > 0) headers.Range = 'bytes=' + partial + '-';
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout>;
      const refreshTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), 15_000);
      };
      refreshTimeout();
      try {
        const response = await fetch(source + MODEL_PATH + '/' + name, { redirect: 'follow', headers, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
        const append = partial > 0 && response.status === 206;
        if (!append) { partial = 0; await fs.promises.rm(part, { force: true }); }
        let current = partial;
        onBytes(current);
        const stream = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
        output = stream;
        for await (const chunk of response.body as any) {
          refreshTimeout();
          const buffer = Buffer.from(chunk);
          if (!stream.write(buffer)) await new Promise<void>((resolve) => stream.once('drain', resolve));
          current += buffer.length;
          onBytes(current);
        }
        await new Promise<void>((resolve, reject) => { stream.end(() => resolve()); stream.on('error', reject); });
      } finally {
        clearTimeout(timeout!);
      }
      const stat = await fs.promises.stat(part);
      if (stat.size !== item.bytes) throw new Error('incomplete (' + stat.size + '/' + item.bytes + ')');
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(part)) hash.update(chunk);
      if (hash.digest('hex').toUpperCase() !== item.sha256) throw new Error('checksum mismatch');
      await fs.promises.rename(part, filePath(name));
      return;
    } catch (error) {
      output?.destroy();
      lastError = source + ': ' + (error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(lastError);
}

export function downloadFormulaModel(): Promise<FormulaModelStatus> {
  if (downloadPromise) return downloadPromise;
  const existing = getFormulaModelStatus();
  if (existing.state === 'ready') return Promise.resolve(existing);
  downloadPromise = (async () => {
    emit({ state: 'downloading', progress: 0, bytesDownloaded: 0, totalBytes: TOTAL_BYTES, installedBytes: installedBytes(), error: undefined });
    let downloaded = 0;
    try {
      const valid = await Promise.all(FILES.map(verifyFile));
      const completedBytes = valid.reduce((sum, ok, index) => sum + (ok ? FILES[index].bytes : 0), 0);
      const activeBytes = new Map<string, number>();
      const updateProgress = () => {
        downloaded = completedBytes + [...activeBytes.values()].reduce((sum, value) => sum + value, 0);
        emit({ bytesDownloaded: Math.min(downloaded, TOTAL_BYTES), progress: Math.min(downloaded / TOTAL_BYTES, 1), installedBytes: installedBytes() });
      };
      downloaded = completedBytes;
      emit({ bytesDownloaded: downloaded, progress: downloaded / TOTAL_BYTES, installedBytes: installedBytes() });
      const sources = await rankedSources();
      await Promise.all(FILES.map(async (item, index) => {
        if (valid[index]) return;
        await downloadFile(item.name, sources, (absoluteBytes) => { activeBytes.set(item.name, absoluteBytes); updateProgress(); });
      }));
      sessions = null; tokenizer = null;
      emit({ state: 'ready', progress: 1, bytesDownloaded: TOTAL_BYTES, installedBytes: TOTAL_BYTES });
      return cloneStatus();
    } catch (error) {
      emit({ state: 'error', error: error instanceof Error ? error.message : String(error), installedBytes: installedBytes() });
      throw error;
    } finally { downloadPromise = null; }
  })();
  return downloadPromise;
}

export async function deleteFormulaModel(): Promise<void> {
  sessions = null; tokenizer = null;
  await fs.promises.rm(modelDir(), { recursive: true, force: true });
  emit({ state: 'not-downloaded', progress: 0, bytesDownloaded: 0, installedBytes: 0, error: undefined });
}

function byteToUnicode(): Map<number, string> {
  const bs: number[] = []; for (let i = 33; i <= 126; i++) bs.push(i); for (let i = 161; i <= 172; i++) bs.push(i); for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs]; let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  return new Map(bs.map((b, i) => [cs[i], String.fromCharCode(cs[i])]));
}
const unicodeToByte = (() => { const forward = byteToUnicode(); return new Map([...forward.entries()].map(([byte, char]) => [char.charCodeAt(0), byte])); })();

async function loadEngine(): Promise<void> {
  if (sessions && tokenizer) return;
  if (!installed()) throw new Error('本地公式识别模型尚未下载');
  sessions = {
    resizer: await ort.InferenceSession.create(filePath('image_resizer.onnx')),
    encoder: await ort.InferenceSession.create(filePath('encoder.onnx')),
    decoder: await ort.InferenceSession.create(filePath('decoder.onnx')),
  };
  const parsed = JSON.parse(await fs.promises.readFile(filePath('tokenizer.json'), 'utf8')) as { model?: { vocab?: Record<string, number> } };
  tokenizer = new Map(Object.entries(parsed.model?.vocab ?? {}).map(([token, id]) => [id, token]));
}

interface GrayImage { data: Uint8Array; width: number; height: number; }
function fromDataUrl(dataUrl: string): GrayImage {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('无法读取公式截图');
  const size = image.getSize(); const bitmap = image.toBitmap(); const gray = new Uint8Array(size.width * size.height);
  for (let i = 0; i < gray.length; i++) { const b = bitmap[i * 4]; const g = bitmap[i * 4 + 1]; const r = bitmap[i * 4 + 2]; gray[i] = Math.round(r * 0.299 + g * 0.587 + b * 0.114); }
  let minX = size.width, minY = size.height, maxX = -1, maxY = -1;
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) if (gray[y * size.width + x] < 245) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (maxX < 0) return { data: gray, width: size.width, height: size.height };
  const pad = 8; minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(size.width - 1, maxX + pad); maxY = Math.min(size.height - 1, maxY + pad);
  const width = maxX - minX + 1, height = maxY - minY + 1, data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(gray.subarray((minY + y) * size.width + minX, (minY + y) * size.width + minX + width), y * width);
  return { data, width, height };
}
function resizeGray(image: GrayImage, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height); const sx = image.width / width; const sy = image.height / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const srcX = Math.min(image.width - 1, Math.floor((x + 0.5) * sx)); const srcY = Math.min(image.height - 1, Math.floor((y + 0.5) * sy)); data[y * width + x] = image.data[srcY * image.width + srcX];
  }
  return { data, width, height };
}
function padGray(image: GrayImage): GrayImage {
  const width = Math.ceil(image.width / 32) * 32, height = Math.ceil(image.height / 32) * 32, data = new Uint8Array(width * height); data.fill(255);
  for (let y = 0; y < image.height; y++) data.set(image.data.subarray(y * image.width, (y + 1) * image.width), y * width);
  return { data, width, height };
}
function tensorFor(image: GrayImage): ort.Tensor {
  const data = new Float32Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) data[i] = (image.data[i] - 0.7931 * 255) / (0.1738 * 255);
  return new ort.Tensor('float32', data, [1, 1, image.height, image.width]);
}

function decodeTokens(ids: number[]): string {
  if (!tokenizer) return '';
  const bytes: number[] = [];
  for (const id of ids) {
    const token = tokenizer.get(id); if (!token || token.startsWith('[')) continue;
    for (const char of token) { const byte = unicodeToByte.get(char.charCodeAt(0)); if (byte === undefined) { bytes.push(...Buffer.from(char)); } else bytes.push(byte); }
  }
  return Buffer.from(bytes).toString('utf8').replace(/Ġ/g, ' ').trim();
}

export async function recognizeFormulaLocal(dataUrl: string): Promise<string> {
  await loadEngine(); if (!sessions) throw new Error('本地公式识别引擎初始化失败');
  let image = padGray(fromDataUrl(dataUrl));
  const maxRatio = Math.max(image.width / 672, image.height / 192, 1);
  if (maxRatio > 1) image = padGray(resizeGray(image, Math.max(32, Math.round(image.width / maxRatio)), Math.max(32, Math.round(image.height / maxRatio))));
  const resized = await sessions.resizer.run({ [sessions.resizer.inputNames[0]]: tensorFor(image) });
  const result = resized[sessions.resizer.outputNames[0]] as ort.Tensor;
  let best = 0; for (let i = 1; i < result.data.length; i++) if ((result.data as Float32Array)[i] > (result.data as Float32Array)[best]) best = i;
  const targetWidth = Math.min(672, Math.max(32, (best + 1) * 32));
  if (targetWidth !== image.width) {
    const scale = Math.min(targetWidth / image.width, 192 / image.height);
    image = padGray(resizeGray(image, Math.max(32, Math.round(image.width * scale)), Math.max(32, Math.round(image.height * scale))));
  }
  const context = (await sessions.encoder.run({ [sessions.encoder.inputNames[0]]: tensorFor(image) }))[sessions.encoder.outputNames[0]] as ort.Tensor;
  let ids = [1];
  // Keep below the exported decoder's 505-position context boundary.
  for (let step = 0; step < 128; step++) {
    const x = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const mask = new ort.Tensor('bool', new Uint8Array(ids.length).fill(1), [1, ids.length]);
    const out = (await sessions.decoder.run({ x, mask, context }))[sessions.decoder.outputNames[0]] as ort.Tensor;
    const dims = out.dims; const vocab = dims[dims.length - 1] as number; const offset = (ids.length - 1) * vocab; const logits = out.data as Float32Array;
    let next = 0; for (let i = 1; i < vocab; i++) if (logits[offset + i] > logits[offset + next]) next = i;
    if (next === 2) break; ids.push(next);
  }
  const rawLatex = decodeTokens(ids.slice(1));
  const textReg = /(\\(operatorname|mathrm|text|mathbf)\s?\*? {.*?})/g;
  const protectedText: string[] = [];
  let latex = rawLatex.replace(textReg, (match) => { protectedText.push(match.replace(/ /g, '')); return `__MINEPDF_TEXT_${protectedText.length - 1}__`; });
  latex = latex.replace(/([^\\\w])\s+?([^\\\w])/g, '$1$2').replace(/([^\\\w])\s+?([a-zA-Z])/g, '$1$2').replace(/([a-zA-Z])\s+?([^\\\w])/g, '$1$2');
  latex = latex.replace(/__MINEPDF_TEXT_(\d+)__/g, (_, index) => protectedText[Number(index)] ?? '');
  if (!latex) throw new Error('本地模型没有识别出公式');
  return latex;
}
