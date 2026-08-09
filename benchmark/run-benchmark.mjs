// 基准总控：对同一批 PDF、同一缩放比例分别跑 PDF.js 与 PDFium，汇总成表格
// 用法: node benchmark/run-benchmark.mjs
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
const PY = 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const LIBRARY = 'C:/Users/Lenovo/Documents/MinePDF/Library';

const CASES = [
  { name: 'PID-Tuning-Methods (9页)', rel: 'en/PID-Tuning-Methods.pdf', start: 0, count: 9 },
  { name: 'sn-article (16页)', rel: 'en/sn-article.pdf', start: 0, count: 16 },
  { name: '感受野 (2页)', rel: 'en/感受野完整通俗重讲.pdf', start: 0, count: 2 },
  { name: '英语复习资料 (前20页/103页)', rel: 'en/英语复习资料.pdf', start: 0, count: 20 },
];

const SCALES = [1.5, 2.0];
const OUT = join(ROOT, 'benchmark', 'out');
mkdirSync(OUT, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    throw new Error(`CMD FAILED: ${cmd} ${args.join(' ')}\n${r.stderr?.slice(0, 2000)}`);
  }
  const lastLine = r.stdout.trim().split('\n').pop();
  try {
    return JSON.parse(lastLine);
  } catch {
    throw new Error(`Bad JSON: ${lastLine}\n${r.stdout.slice(-1000)}`);
  }
}

// PDFium 运行期间用 PowerShell 读取进程峰值内存
function runPdfium(py, args, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(py, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let ready = false;
    child.stdout.on('data', async (chunk) => {
      stdout += chunk;
      if (!ready && stdout.includes('READY')) {
        ready = true;
        const pid = child.pid;
        const ps = spawnSync('powershell', [
          '-NoProfile', '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PeakWorkingSet64`,
        ], { encoding: 'utf8', timeout: 10000 });
        const memMB = ps.stdout?.trim() ? Math.round(parseFloat(ps.stdout.trim()) / 1024 / 1024) : 0;
        child.stdin.write('\n');
        globalThis.__pdfiumPeak = memMB;
      }
    });
    child.stderr.on('data', (d) => { process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', () => {
      const lines = stdout.trim().split('\n').filter((l) => l.startsWith('{'));
      try {
        const obj = JSON.parse(lines[lines.length - 1]);
        obj.peakRssMB = globalThis.__pdfiumPeak || 0;
        resolve(obj);
      } catch (e) {
        reject(new Error(`Bad pdfium JSON: ${stdout.slice(-800)}`));
      }
    });
  });
}

const results = [];
for (const scale of SCALES) {
  for (const c of CASES) {
    const pdf = join(LIBRARY, c.rel);
    if (!existsSync(pdf)) continue;
    const tag = `${c.name.replace(/\s+/g, '_')}_s${scale}`;
    const dir = join(OUT, tag);
    mkdirSync(dir, { recursive: true });
    const pdfjs = run(NODE, [join(ROOT, 'benchmark', 'pdfjs-bench.mjs'), pdf, String(c.start), String(c.count), String(scale), dir]);
    const pdfium = await runPdfium(PY, [join(ROOT, 'benchmark', 'pdfium-bench.py'), pdf, String(c.start), String(c.count), String(scale), dir]);
    results.push({ case: c.name, scale, pdfjs, pdfium });
    console.log(`done: ${c.name} @${scale}x`);
  }
}

// 汇总 Markdown 表格
let md = `# PDF.js vs PDFium 渲染基准\n\n测试环境：PDF.js ${results[0]?.pdfjs ? '4.10.38' : ''} (Node, @napi-rs/canvas) vs PDFium (pypdfium2)\n\n| 文件 | 缩放 | 引擎 | 平均/页 | 中位/页 | 最慢页 | 打开文档 | 峰值内存 |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of results) {
  for (const eng of ['pdfjs', 'pdfium']) {
    const d = r[eng];
    md += `| ${r.case} | ${r.scale}x | ${eng === 'pdfjs' ? 'PDF.js' : 'PDFium'} | ${d.meanMs.toFixed(1)}ms | ${d.medianMs.toFixed(1)}ms | ${d.maxMs.toFixed(1)}ms | ${d.coldOpenMs.toFixed(0)}ms | ${d.peakRssMB}MB |\n`;
  }
}
writeFileSync(join(OUT, 'summary.md'), md);
console.log(md);
