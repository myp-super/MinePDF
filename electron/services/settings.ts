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
  /** 用户是否主动选择 MinePDF 作为默认 PDF 应用（用于启动时清理旧版本强写的关联） */
  pdfDefaultApp: false,
  /** 阅读 PDF 时自动折叠左侧知识库（鼠标移到左边缘临时展开） */
  autoCollapseSidebar: false,
  /** 右键拖拽平移（默认开启）；关闭后恢复左键拖拽平移 */
  rightDragPan: true,
  /** 双击左右边栏空白处快速折叠/展开 */
  dblClickTogglePanels: true,
  /** 界面字号缩放 */
  uiFontScale: 1,
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
