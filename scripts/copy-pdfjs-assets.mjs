// 将 pdfjs-dist 的压缩字形表（cmap）复制到 public/cmaps，
// 供 PDF.js 渲染非内嵌字体（如部分中文 PDF）时使用。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'node_modules', 'pdfjs-dist', 'cmaps');
const dest = join(root, 'public', 'cmaps');

if (!existsSync(source)) {
  console.warn('[copy-pdfjs-assets] 未找到 pdfjs-dist/cmaps，跳过。');
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(source, dest, {
  recursive: true,
  filter: (src) => src.endsWith('.bcmap'),
});
console.log('[copy-pdfjs-assets] cmaps 已复制到 public/cmaps');
