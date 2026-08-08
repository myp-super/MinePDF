import { app, net } from 'electron';
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
  const url = getSettings().updateUrl.trim();
  if (!url) return { status: 'disabled', currentVersion };
  try {
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
