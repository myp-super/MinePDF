/** 文献管理面板的「未保存」状态与保存编排。
 *
 * 编辑内容存在于 Inspector 的 React 局部 state 中，而关闭标签 / 关闭软件时需要
 * 跨组件判断是否还有未保存修改，因此用模块级登记表统一管理，不塞进全局 store。
 */

type FlushFn = () => Promise<void> | void;

let metadataDirty = false;
const fieldDirtyGetters = new Set<() => boolean>();
const fieldFlushes = new Set<FlushFn>();
const fieldCleaners = new Set<() => void>();
let saveFn: FlushFn | null = null;

/** 元数据（文献档案字段）有未保存修改 */
export function markMetadataDirty(): void {
  metadataDirty = true;
}

/** 元数据已保存（某次提交成功） */
export function markMetadataSaved(): void {
  metadataDirty = false;
}

/** 登记某个字段的「是否有未保存内容」查询（用于关闭前提示） */
export function registerFieldDirty(getter: () => boolean): () => void {
  fieldDirtyGetters.add(getter);
  return () => {
    fieldDirtyGetters.delete(getter);
  };
}

/** 登记字段级强制保存（Ctrl+S / 保存按钮 / 关闭前保存时触发） */
export function registerFieldFlush(fn: FlushFn): () => void {
  fieldFlushes.add(fn);
  return () => {
    fieldFlushes.delete(fn);
  };
}

/** 登记字段级「放弃修改」清理（不保存并关闭时清掉脏标记，避免再次弹窗） */
export function registerFieldCleaner(fn: () => void): () => void {
  fieldCleaners.add(fn);
  return () => {
    fieldCleaners.delete(fn);
  };
}

/** 登记整个文献管理面板的保存入口（由 LiteraturePanel 注册） */
export function registerLiteratureSave(fn: FlushFn | null): void {
  saveFn = fn;
}

/** 是否还有未保存的文献修改 */
export function isLiteratureDirty(): boolean {
  if (metadataDirty) return true;
  for (const getter of fieldDirtyGetters) {
    if (getter()) return true;
  }
  return false;
}

/** 执行面板级保存（元数据整批提交 + 所有字段 flush + 清理脏标记） */
export async function flushLiteratureSave(): Promise<void> {
  if (saveFn) await saveFn();
}

/** flush 全部结构化字段（各自保存自己的 pending 内容） */
export async function flushAllLiteratureFields(): Promise<void> {
  await Promise.allSettled(Array.from(fieldFlushes).map((fn) => fn()));
}

/** 放弃全部未保存修改（不保存并关闭时使用，确保后续不再弹窗） */
export function forceLiteratureClean(): void {
  metadataDirty = false;
  fieldCleaners.forEach((fn) => fn());
}
