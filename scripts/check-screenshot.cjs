/* Pixel-sample docs/app-screenshot.png to verify highlight + ink stroke rendered. */
const { app, nativeImage } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const file = path.join(process.cwd(), 'docs', 'app-screenshot.png');
  const img = nativeImage.createFromPath(file);
  const { width: w, height: h } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const buckets = {};
  for (let i = 0; i < bmp.length; i += 4 * 40) {
    const r = bmp[i + 2], g = bmp[i + 1], b = bmp[i];
    const key = `${Math.floor(r / 32) * 32},${Math.floor(g / 32) * 32},${Math.floor(b / 32) * 32}`;
    buckets[key] = (buckets[key] || 0) + 1;
  }
  const top = Object.entries(buckets).sort((a, b2) => b2[1] - a[1]).slice(0, 8);
  console.log('histogram', JSON.stringify(top));
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i] };
  };

  const near = (c, r, g, b, tol) => Math.abs(c.r - r) <= tol && Math.abs(c.g - g) <= tol && Math.abs(c.b - b) <= tol;

  // Locate the white PDF page (large near-white rectangle on dark canvas).
  const isWhite = (x, y) => {
    const c = at(x, y);
    return c.r > 205 && c.g > 205 && c.b > 205;
  };
  const whiteRows = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x += 4) if (isWhite(x, y)) n++;
    if (n > w / 16) whiteRows.push(y);
  }
  console.log('debug whiteRows', whiteRows.length, whiteRows[0], whiteRows[whiteRows.length - 1]);
  console.log('debug mid-row samples', [0, 100, 400, 800, 1000, 1200, 1500, 1800, 2100].map((x) => [x, at(x, Math.floor(h / 2))]));
  const page = (() => {
    if (!whiteRows.length) return null;
    const y0 = whiteRows[0];
    const y1 = whiteRows[whiteRows.length - 1];
    const xs = [];
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let y = y0; y <= y1; y += 4) if (isWhite(x, y)) n++;
      if (n > (y1 - y0) / 16) xs.push(x);
    }
    if (!xs.length) return null;
    return { x0: xs[0], x1: xs[xs.length - 1], y0, y1 };
  })();

  const collect = (r, g, b, tol) => {
    const pts = [];
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (near(at(x, y), r, g, b, tol)) pts.push({ x, y });
      }
    }
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { count: pts.length, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const collectIn = (x0, y0, x1, y1, r, g, b, tol) => {
    const pts = [];
    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        if (near(at(x, y), r, g, b, tol)) pts.push({ x, y });
      }
    }
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { count: pts.length, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };

  // Yellow highlight over white page: rgba(253,224,71,0.35) blended -> ~(254,244,191)
  const hl = page ? collect(254, 244, 191, 12) : null;
  // Blue ink stroke #5b8def (tighter tolerance to avoid UI accents)
  const pageH = page ? page.y1 - page.y0 : 0;
  const hlOk = page && hl && hl.count > 60 && hl.y0 - page.y0 < pageH * 0.2;
  const hlNearTop = hlOk && hl.y0 - page.y0 < page.y1 - page.y0 * 0.25;
  console.log(JSON.stringify({ size: { w, h }, page, highlight: hl, hlOk, hlNearTop }, null, 2));
  const ok = hlOk && hlNearTop;
  app.exit(ok ? 0 : 1);
});
