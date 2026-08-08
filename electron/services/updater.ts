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
 * 软件内下载更新包：流式写入临时目录并回报进度，返回本地文件路径。
 * 下载地址是 GitHub Release 附件直链（跟随重定向）。
 */
export async function downloadUpdate(
  url: string,
  onProgress: (percent: number) => void,
): Promise<{ filePath: string; size: number }> {
  const parsed = new URL(url);
  const filename =
    decodeURIComponent(path.basename(parsed.pathname)).replace(/[<>:"/\\|?*]/g, '_') ||
    'MinePDF Setup.exe';
  const dir = path.join(app.getPath('temp'), 'minepdf-update');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const res = await net.fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('无法读取下载内容');
  const file = fs.createWriteStream(filePath);
  let received = 0;
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
}
