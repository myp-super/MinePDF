import { dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../db/database';

/** 将整个数据目录复制到用户选择的备份位置 */
export async function backupData(win: BrowserWindow | null): Promise<{ path: string }> {
  const options = {
    title: '选择备份保存位置',
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
  };
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (res.canceled || !res.filePaths[0]) throw new Error('已取消备份');
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .slice(0, 19);
  const target = path.join(res.filePaths[0], `MinePDF-backup-${stamp}`);
  await fs.promises.cp(getDataDir(), target, { recursive: true });
  return { path: target };
}
