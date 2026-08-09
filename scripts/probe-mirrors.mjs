// 模拟 updater 的新测速选源逻辑：并行下载各候选源前 512KB，选出最快源
// 用法: node scripts/probe-mirrors.mjs <release下载直链>
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://gh.ddlc.top/'];
const PROBE = 512 * 1024;

async function probe(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  let received = 0;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Range: `bytes=0-${PROBE - 1}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        if (received >= PROBE) break;
      }
    }
    return received / ((Date.now() - t0) / 1000);
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
    try {
      ctrl.abort();
    } catch {
      /* ignore */
    }
  }
}

const base = process.argv[2];
const candidates = [base, ...PREFIXES.map((p) => `${p}${base}`)];
const speeds = await Promise.all(candidates.map((u) => probe(u)));
let best = base;
let bestSpeed = 0;
for (let i = 0; i < candidates.length; i++) {
  const kb = speeds[i] / 1024;
  console.log(`${(kb / 1024).toFixed(2)} MB/s\t${candidates[i]}`);
  if (speeds[i] > bestSpeed) {
    bestSpeed = speeds[i];
    best = candidates[i];
  }
}
console.log(`\n选中: ${best}`);
