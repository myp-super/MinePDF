import fs from 'fs';
import path from 'path';
import {
  DEFAULT_LITERATURE_REVIEW_FIELD_CONFIGS,
  LITERATURE_REVIEW_FIELD_ORDER,
  type AppSettings,
  type LiteratureReviewField,
  type LiteratureReviewFieldConfig,
} from '../../src/shared/types';
import { sanitizeShortcutKeys } from '../../src/lib/shortcut';
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
  /** 被用户隐藏的默认标签（不再出现在推荐列表，可通过“恢复默认标签”还原） */
  disabledTagPresets: [],
  literatureReviewFields: [...LITERATURE_REVIEW_FIELD_ORDER],
  literatureReviewFieldConfigs: DEFAULT_LITERATURE_REVIEW_FIELD_CONFIGS.map((item) => ({ ...item })),
  translation: {
    enabled: true,
    shortcutEnabled: false,
    shortcutKeys: ['Alt', 'KeyT'],
    provider: 'transmart',
    defaultProviderRevision: 5,
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    contextMode: 'auto',
    cacheEnabled: true,
    timeoutMs: 20_000,
    maxSelectedCharacters: 500_000,
    longSelectionCharacters: 3_000,
    openAICompatible: {
      name: 'OpenAI Compatible',
      endpoint: '',
      model: '',
    },
    formulaEngine: 'local',
    formulaModelSources: [],
  },
  libraryPath: '',
  libraryPdfDir: '',
};

let cache: AppSettings | null = null;

const reviewFieldSet = new Set<LiteratureReviewField>(LITERATURE_REVIEW_FIELD_ORDER);

function configsFromLegacy(fields: unknown): LiteratureReviewFieldConfig[] {
  const enabled = Array.isArray(fields)
    ? fields
        .filter((field): field is LiteratureReviewField => reviewFieldSet.has(field as LiteratureReviewField))
        .filter((field, index, list) => list.indexOf(field) === index)
    : [];
  const ordered = enabled.length ? enabled : [...LITERATURE_REVIEW_FIELD_ORDER];
  return [
    ...ordered.map((field) => ({ id: field, kind: 'preset' as const, field, label: '', enabled: true })),
    ...LITERATURE_REVIEW_FIELD_ORDER.filter((field) => !ordered.includes(field)).map((field) => ({
      id: field,
      kind: 'preset' as const,
      field,
      label: '',
      enabled: false,
    })),
  ];
}

function sanitizeReviewFieldConfigs(
  value: unknown,
  legacyFields?: unknown,
): LiteratureReviewFieldConfig[] {
  if (!Array.isArray(value)) return configsFromLegacy(legacyFields);
  const result: LiteratureReviewFieldConfig[] = [];
  const ids = new Set<string>();
  const presetFields = new Set<LiteratureReviewField>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<LiteratureReviewFieldConfig>;
    if (item.kind === 'preset') {
      const field = (item.field ?? item.id) as LiteratureReviewField;
      if (!reviewFieldSet.has(field) || presetFields.has(field)) continue;
      presetFields.add(field);
      ids.add(field);
      result.push({
        id: field,
        kind: 'preset',
        field,
        label: typeof item.label === 'string' ? item.label.trim().slice(0, 80) : '',
        enabled: item.enabled !== false,
      });
      continue;
    }
    if (item.kind !== 'custom') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, 80) : '';
    if (!/^custom-[a-z0-9_-]{6,80}$/i.test(id) || ids.has(id) || !label) continue;
    ids.add(id);
    result.push({ id, kind: 'custom', label, enabled: item.enabled !== false });
  }
  for (const field of LITERATURE_REVIEW_FIELD_ORDER) {
    if (!presetFields.has(field)) {
      result.push({ id: field, kind: 'preset', field, label: '', enabled: false });
    }
  }
  return result.length ? result : configsFromLegacy(legacyFields);
}

function syncLegacyReviewFields(settings: AppSettings): AppSettings {
  settings.literatureReviewFields = settings.literatureReviewFieldConfigs
    .filter((item) => item.kind === 'preset' && item.enabled && item.field)
    .map((item) => item.field as LiteratureReviewField);
  return settings;
}

function configPath(): string {
  return path.join(getDataDir(), 'config', 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    const savedTranslation = saved.translation;
    cache = {
      ...DEFAULTS,
      ...saved,
      translation: {
        ...DEFAULTS.translation,
        ...savedTranslation,
        provider: (savedTranslation?.defaultProviderRevision ?? 0) < 5
          && (!savedTranslation?.provider || ['edge', 'bing', 'google', 'mymemory'].includes(savedTranslation.provider))
            ? 'transmart'
            : savedTranslation?.provider ?? DEFAULTS.translation.provider,
        defaultProviderRevision: 5,
        openAICompatible: {
          ...DEFAULTS.translation.openAICompatible,
          ...savedTranslation?.openAICompatible,
        },
      },
    };
    // 3.10: selection translation is chunked end-to-end, so migrate the old
    // 12k ceiling instead of leaving existing users with a partial-text limit.
    cache.translation.maxSelectedCharacters = Math.max(
      cache.translation.maxSelectedCharacters,
      DEFAULTS.translation.maxSelectedCharacters,
    );
    cache.translation.shortcutKeys = sanitizeShortcutKeys(cache.translation.shortcutKeys);
    if (!cache.translation.shortcutKeys.length) {
      cache.translation.shortcutKeys = [...DEFAULTS.translation.shortcutKeys];
    }
    cache.literatureReviewFieldConfigs = sanitizeReviewFieldConfigs(
      saved.literatureReviewFieldConfigs,
      saved.literatureReviewFields,
    );
    syncLegacyReviewFields(cache);
  } catch {
    cache = {
      ...DEFAULTS,
      literatureReviewFields: [...DEFAULTS.literatureReviewFields],
      literatureReviewFieldConfigs: DEFAULTS.literatureReviewFieldConfigs.map((item) => ({ ...item })),
    };
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
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    translation: patch.translation
      ? {
          ...current.translation,
          ...patch.translation,
          openAICompatible: {
            ...current.translation.openAICompatible,
            ...patch.translation.openAICompatible,
          },
        }
      : current.translation,
  };
  next.translation.shortcutKeys = sanitizeShortcutKeys(next.translation.shortcutKeys);
  if (!next.translation.shortcutKeys.length) {
    next.translation.shortcutKeys = [...DEFAULTS.translation.shortcutKeys];
  }
  next.literatureReviewFieldConfigs = sanitizeReviewFieldConfigs(
    patch.literatureReviewFieldConfigs === undefined && patch.literatureReviewFields !== undefined
      ? undefined
      : next.literatureReviewFieldConfigs,
    patch.literatureReviewFields ?? next.literatureReviewFields,
  );
  syncLegacyReviewFields(next);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}
