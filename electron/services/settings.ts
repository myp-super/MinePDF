import fs from 'fs';
import path from 'path';
import type { AppSettings } from '../../src/shared/types';
import { getDataDir, getLibraryPdfDir, getLibraryRoot } from '../db/database';

const DEFAULTS: AppSettings = {
  theme: 'dark',
  language: 'zh-CN',
  autoSave: true,
  defaultImportDir: '',
  // 内置默认更新源：用户安装后即可自动检查更新（可在设置中修改或留空关闭）
  updateUrl: 'https://myp-super.github.io/MinePDF/update.json',
  updateAutoCheck: true,
  libraryPath: '',
  libraryPdfDir: '',
};

let cache: AppSettings | null = null;

function configPath(): string {
  return path.join(getDataDir(), 'config', 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    cache = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    cache = { ...DEFAULTS };
  }
  // 旧配置里可能保存了空的 updateUrl（早期默认值），回退到内置默认更新源
  if (!cache.updateUrl?.trim()) {
    cache.updateUrl = DEFAULTS.updateUrl;
  }
  cache.libraryPath = getLibraryRoot();
  cache.libraryPdfDir = getLibraryPdfDir();
  return cache;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}
