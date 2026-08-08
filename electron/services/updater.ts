import { app, net } from 'electron';
import fs from 'fs';
import path from 'path';
import type { UpdateInfo, UpdateResult } from '../../src/shared/types';
import { getSettings } from './settings';

function parseVersion(v: string): number[] {
  return String(v)
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Check for updates by reading a small manifest (update.json) from the URL the
 * user configured in Settings. The manifest looks like:
 * { "version": "1.1.0", "notes": ["...", "..."], "url": "https://.../Setup.exe", "publishDate": "2026-08-08" }
 */
export async function checkForUpdates(): Promise<UpdateResult> {
  const currentVersion = process.env.npm_package_version ?? app.getVersion();
  let url = getSettings().updateUrl.trim();
  if (!url) return { status: 'disabled', currentVersion };
  try {
    // GitHub Pages 对 update.json 有 10 分钟 CDN 缓存，追加时间戳绕过
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}_=${Date.now()}`;
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      version?: unknown;
      notes?: unknown;
      url?: unknown;
      publishDate?: unknown;
    };
    const version = String(data.version ?? '').trim();
    const downloadUrl = String(data.url ?? '').trim();
    if (!version || !downloadUrl) {
      throw new Error('update.json 格式不正确（缺少 version 或 url）');
    }
    const latest: UpdateInfo = {
      version,
      notes: Array.isArray(data.notes)
        ? data.notes.map(String)
        : data.notes
          ? [String(data.notes)]
          : [],
      url: downloadUrl,
      publishDate: data.publishDate ? String(data.publishDate) : undefined,
    };
    return {
      status: isNewer(version, currentVersion) ? 'available' : 'up-to-date',
      currentVersion,
      latest,
    };
  } catch (err) {
    return {
      status: 'error',
      currentVersion,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 软件内下载更新包：自动选择直连 / 国内镜像里最快的源，流式写入并回报进度；
 * 连接中断时自动断点续传重试一次。返回本地文件路径。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 国内可用的 GitHub Release 加速镜像前缀（直链前面直接拼接即可） */
const MIRROR_PREFIXES = ['https://ghproxy.net/', 'https://ghfast.top/', 'https://gh-proxy.com/'];

/** 直连 + 各镜像的候选下载地址 */
function mirrorCandidates(url: string): string[] {
  const list = [url];
  if (url.startsWith('https://github.com/')) {
    for (const p of MIRROR_PREFIXES) list.push(`${p}${url}`);
  }
  return [...new Set(list)];
}

/** 探测一个候选源的响应耗时（只取 1 字节），失败返回 null */
async function probeUrl(url: string, timeoutMs = 5000): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      signal: ctrl.signal,
    });
    if (res.ok) {
      await res.body?.cancel();
      return Date.now() - t0;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 并行探测直连和镜像，选响应最快的源；全部失败则回退直连 */
async function pickFastestSource(url: string): Promise<string> {
  const candidates = mirrorCandidates(url);
  const results = await Promise.all(candidates.map((u) => probeUrl(u)));
  let best: string | null = null;
  let bestMs = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const ms = results[i];
    if (ms != null && ms < bestMs) {
      bestMs = ms;
      best = candidates[i];
    }
  }
  return best ?? url;
}

export async function downloadUpdate(
  url: string,
  onProgress: (percent: number) => void,
): Promise<{ filePath: string; size: number }> {
  const source = await pickFastestSource(url);
  const parsed = new URL(source);
  const filename =
    decodeURIComponent(path.basename(parsed.pathname)).replace(/[<>:"/\\|?*]/g, '_') ||
    'MinePDF Setup.exe';
  const dir = path.join(app.getPath('temp'), 'minepdf-update');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);

  // 上次中断留下的半成品可用于续传
  let received = 0;
  try {
    if (fs.existsSync(filePath)) received = fs.statSync(filePath).size;
  } catch {
    received = 0;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const headers: Record<string, string> = { 'User-Agent': UA };
      if (received > 0) headers.Range = `bytes=${received}-`;
      const res = await net.fetch(source, { headers });
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
      // 服务器支持续传时 content-range 形如 bytes 0-xxx/total
      const rangeOk = received > 0 && /^bytes /.test(String(res.headers.get('content-range') ?? ''));
      if (!rangeOk && received > 0) {
        // 镜像不支持 Range，则完整重下，避免拼出损坏文件
        received = 0;
      }
      const remaining = Number(res.headers.get('content-length') ?? 0);
      const total = received + remaining;
      const reader = res.body?.getReader();
      if (!reader) throw new Error('无法读取下载内容');
      const file = fs.createWriteStream(filePath, { flags: received > 0 ? 'a' : 'w' });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await new Promise<void>((resolve, reject) => {
              file.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
            });
            received += value.length;
            if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)));
          }
        }
      } finally {
        await new Promise<void>((resolve) => file.end(() => resolve()));
      }
      onProgress(100);
      return { filePath, size: received };
    } catch (err) {
      if (attempt >= 2) throw err instanceof Error ? err : new Error(String(err));
      // 中断后带着已下载字节数重试（续传）
    }
  }
  throw new Error('下载失败');
}
