// 下载并解压 PDFium Windows x64 运行时（bblanchon/pdfium-binaries）
// - 已存在 resources/pdfium/win-x64/bin/pdfium.dll 时跳过
// - 网络失败仅告警，不阻断构建（应用会回退到 PDF.js 渲染）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'chromium/7988';
const ASSET = 'pdfium-win-x64.tgz';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEST = join(ROOT, 'resources', 'pdfium', 'win-x64');
const DLL = join(DEST, 'bin', 'pdfium.dll');

const MIRRORS = [
  (u) => u, // 直连 GitHub
  (u) => `https://ghproxy.net/${u}`,
  (u) => `https://mirror.ghproxy.com/${u}`,
];

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return buf.length;
}

async function main() {
  if (existsSync(DLL)) {
    console.log('[pdfium] dll already exists, skip download:', DLL);
    return;
  }
  mkdirSync(DEST, { recursive: true });
  const base = `https://github.com/bblanchon/pdfium-binaries/releases/download/${VERSION}/${ASSET}`;
  const tmp = join(DEST, ASSET);
  let lastErr = null;
  for (const mirror of MIRRORS) {
    try {
      const size = await download(mirror(base), tmp);
      console.log(`[pdfium] downloaded ${ASSET} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      execFileSync('tar', ['-xzf', tmp, '-C', DEST], { stdio: 'inherit' });
      writeFileSync(join(DEST, 'version.json'), JSON.stringify({ version: VERSION }, null, 2));
      console.log('[pdfium] extracted to', DEST);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[pdfium] mirror failed: ${err.message}`);
    }
  }
  console.warn('[pdfium] download failed, fallback to PDF.js rendering:', lastErr?.message);
}

await main();
