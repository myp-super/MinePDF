import fs from 'fs';

/**
 * 轻量解析 PDF 页数：优先读取 /Type /Pages 对象的 /Count，
 * 失败时回退统计 /Type /Page 对象数量。
 * 打开文档后渲染进程会用 PDF.js 的精确页数覆盖该值。
 */
export function guessPageCount(filePath: string): number | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size <= 0) {
      fs.closeSync(fd);
      return null;
    }
    const headSize = Math.min(stat.size, 512 * 1024);
    const tailSize = Math.min(stat.size, 2 * 1024 * 1024);
    const head = Buffer.alloc(headSize);
    fs.readSync(fd, head, 0, headSize, 0);
    let buf = head;
    if (tailSize < stat.size) {
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
      buf = Buffer.concat([head, tail]);
    }
    fs.closeSync(fd);

    const str = buf.toString('latin1');
    const pagesMatch = str.match(/\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/i);
    if (pagesMatch) {
      const n = parseInt(pagesMatch[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const pageRe = /\/Type\s*\/Page[^s]/gi;
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = pageRe.exec(str)) !== null) count++;
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * 轻量判断 PDF 是否带有书签（目录）：Catalog 里出现 /Outlines 引用即视为有。
 * 仅用于打开文档前决定信息面板默认页，打开后由 PDF.js 精确校准。
 */
export function guessHasOutline(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size <= 0) {
      fs.closeSync(fd);
      return false;
    }
    const headSize = Math.min(stat.size, 512 * 1024);
    const head = Buffer.alloc(headSize);
    fs.readSync(fd, head, 0, headSize, 0);
    fs.closeSync(fd);
    return /\/Outlines\s+\d+\s+\d+\s+R/i.test(head.toString('latin1'));
  } catch {
    return false;
  }
}
