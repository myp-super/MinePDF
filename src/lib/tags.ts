/** 内置常用预设标签：仅作为推荐，不是强制分类，用户可隐藏/恢复 */
export const DEFAULT_TAG_PRESETS = [
  '论文',
  '教材',
  '课程',
  '项目',
  '文献',
  '笔记',
  '报告',
  '考试',
  '资料',
] as const;

/** 标签规范化：去掉前导 # 与空白（#论文 / # 论文 / ##论文 统一为 论文），内部一律不带 # */
export function normalizeTagName(raw: string): string {
  return (raw ?? '').trim().replace(/^[#\s]+/, '');
}

/** 是否为内置预设标签（用于区分“预设推荐”与“自定义标签”） */
export function isPresetTag(name: string): boolean {
  const n = normalizeTagName(name);
  return (DEFAULT_TAG_PRESETS as readonly string[]).includes(n);
}
