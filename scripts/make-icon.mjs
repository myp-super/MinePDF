// 纯 Node 图标生成器：绘制 512/256 PNG 并封装为 ICO（PNG-in-ICO）。
// 无需 GDI / ImageMagick，保证在任何环境可复现。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });

// ---------- 极简光栅化 ----------
function createCanvas(size) {
  return { size, data: new Uint8Array(size * size * 4) };
}

function blend(canvas, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  const da = a / 255;
  const sa = canvas.data[i + 3] / 255;
  const oa = da + sa * (1 - da);
  if (oa === 0) return;
  canvas.data[i] = Math.round((r * da + canvas.data[i] * sa * (1 - da)) / oa);
  canvas.data[i + 1] = Math.round((g * da + canvas.data[i + 1] * sa * (1 - da)) / oa);
  canvas.data[i + 2] = Math.round((b * da + canvas.data[i + 2] * sa * (1 - da)) / oa);
  canvas.data[i + 3] = Math.round(oa * 255);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- 绘制图标 ----------
function drawIcon(size) {
  const canvas = createCanvas(size);
  const ss = 4; // 4x4 超采样抗锯齿
  const SS = size * ss;
  const [c1r, c1g, c1b] = hexRgb('#3d5fc0');
  const [c2r, c2g, c2b] = hexRgb('#6d95ee');

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;

          // 圆角矩形背景（圆角半径 18%）
          const rr = size * 0.18;
          const m = size * 0.045;
          let inside = false;
          if (X >= m && X <= size - m && Y >= m && Y <= size - m) {
            const cx = Math.min(Math.max(X, m + rr), size - m - rr);
            const cy = Math.min(Math.max(Y, m + rr), size - m - rr);
            inside = Math.hypot(X - cx, Y - cy) <= rr;
          }
          if (!inside) continue;

          // 对角渐变
          const t = Math.min(1, Math.max(0, (X + Y) / (2 * size)));
          const r = lerp(c1r, c2r, t);
          const g = lerp(c1g, c2g, t);
          const b = lerp(c1b, c2b, t);
          blend(canvas, px, py, r, g, b, 255);
        }
      }
    }
  }

  // 书页（左右两个多边形）
  const cx = size / 2;
  const top = size * 0.205;
  const bot = size * 0.72;
  const spineTop = size * 0.26;
  const spineBot = size * 0.71;
  const leftPoly = [
    [size * 0.29, top],
    [cx, spineTop],
    [cx, spineBot],
    [size * 0.3, bot],
  ];
  const rightPoly = [
    [size * 0.71, top],
    [cx, spineTop],
    [cx, spineBot],
    [size * 0.7, bot],
  ];
  const pageR = 11;
  const pageG = 18;
  const pageB = 26;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;
          if (pointInPoly(X, Y, leftPoly) || pointInPoly(X, Y, rightPoly)) {
            blend(canvas, px, py, pageR, pageG, pageB, 214);
          }
        }
      }
    }
  }

  // 书脊与文字线（线段 + 宽度）
  const lines = [
    { x1: cx, y1: spineTop, x2: cx, y2: spineBot, w: size * 0.024, color: [207, 224, 255], alpha: 235 },
    { x1: size * 0.36, y1: size * 0.368, x2: cx - size * 0.09, y2: size * 0.343, w: size * 0.02, color: [226, 240, 255], alpha: 235 },
    { x1: size * 0.36, y1: size * 0.428, x2: cx - size * 0.09, y2: size * 0.403, w: size * 0.02, color: [226, 240, 255], alpha: 235 },
    { x1: size * 0.36, y1: size * 0.488, x2: cx - size * 0.09, y2: size * 0.463, w: size * 0.02, color: [226, 240, 255], alpha: 235 },
    { x1: cx + size * 0.09, y1: size * 0.343, x2: size * 0.64, y2: size * 0.368, w: size * 0.02, color: [226, 240, 255], alpha: 150 },
    { x1: cx + size * 0.09, y1: size * 0.403, x2: size * 0.64, y2: size * 0.428, w: size * 0.02, color: [226, 240, 255], alpha: 150 },
    { x1: cx + size * 0.09, y1: size * 0.463, x2: size * 0.64, y2: size * 0.488, w: size * 0.02, color: [226, 240, 255], alpha: 150 },
  ];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;
          for (const ln of lines) {
            if (distToSegment(X, Y, ln.x1, ln.y1, ln.x2, ln.y2) <= ln.w / 2) {
              blend(canvas, px, py, ln.color[0], ln.color[1], ln.color[2], ln.alpha);
            }
          }
        }
      }
    }
  }
  return canvas;
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    src.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  const iend = Buffer.alloc(0);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', iend)]);
}

function downsample(src, targetSize) {
  const out = createCanvas(targetSize);
  const f = src.size / targetSize;
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const sx0 = Math.min(src.size - 1, Math.floor(x * f + sx * f / 2));
          const sy0 = Math.min(src.size - 1, Math.floor(y * f + sy * f / 2));
          const i = (sy0 * src.size + sx0) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const i = (y * targetSize + x) * 4;
      out.data[i] = Math.round(r / n);
      out.data[i + 1] = Math.round(g / n);
      out.data[i + 2] = Math.round(b / n);
      out.data[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------- ICO ----------
function icoFromPng(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

// ---------- 输出 ----------
const canvas512 = drawIcon(512);
const png512 = encodePng(canvas512);
const canvas256 = downsample(canvas512, 256);
const png256 = encodePng(canvas256);

writeFileSync(join(outDir, 'icon.png'), png512);
writeFileSync(join(outDir, 'icon.ico'), icoFromPng(png256, 256));
console.log(`[make-icon] 生成 build/icon.png (${png512.length}B) 与 build/icon.ico (${png256.length}B)`);
