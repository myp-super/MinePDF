// PDF 文件关联图标生成器：白色纸张 + 折角 + 蓝色 PDF 徽章（与应用 Logo 区分）。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });

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

// 5x7 像素字体：P D F
const FONT = {
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
};

function drawFileIcon(size) {
  const canvas = createCanvas(size);
  const ss = 4;
  const [c1r, c1g, c1b] = hexRgb('#2f54b0');
  const [c2r, c2g, c2b] = hexRgb('#5b8def');

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;

          // 纸张（白色圆角矩形）
          const m = size * 0.06;
          const rr = size * 0.05;
          let inPaper = false;
          if (X >= m && X <= size - m && Y >= m && Y <= size - m) {
            const cx = Math.min(Math.max(X, m + rr), size - m - rr);
            const cy = Math.min(Math.max(Y, m + rr), size - m - rr);
            inPaper = Math.hypot(X - cx, Y - cy) <= rr;
          }
          if (inPaper) {
            blend(canvas, px, py, 250, 251, 253, 255);
            continue;
          }
          // 右上折角（深灰三角）
          if (pointInPoly(X, Y, [
            [size * 0.66, size * 0.06],
            [size * 0.94, size * 0.06],
            [size * 0.66, size * 0.34],
          ])) {
            blend(canvas, px, py, 138, 144, 156, 255);
          } else if (pointInPoly(X, Y, [
            [size * 0.66, size * 0.06],
            [size * 0.94, size * 0.06],
            [size * 0.94, size * 0.34],
            [size * 0.66, size * 0.34],
          ])) {
            // 折角阴影（纸张缺角处）
            blend(canvas, px, py, 190, 195, 205, 255);
          }
        }
      }
    }
  }

  // 蓝色徽章（圆角矩形）
  const bx0 = size * 0.28;
  const bx1 = size * 0.72;
  const by0 = size * 0.22;
  const by1 = size * 0.52;
  const br = size * 0.045;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;
          if (X >= bx0 && X <= bx1 && Y >= by0 && Y <= by1) {
            const cx = Math.min(Math.max(X, bx0 + br), bx1 - br);
            const cy = Math.min(Math.max(Y, by0 + br), by1 - br);
            if (Math.hypot(X - cx, Y - cy) <= br) {
              const t = Math.min(1, Math.max(0, (X - bx0) / (bx1 - bx0)));
              blend(canvas, px, py, lerp(c1r, c2r, t), lerp(c1g, c2g, t), lerp(c1b, c2b, t), 255);
            }
          }
        }
      }
    }
  }

  // 白色 "PDF" 像素字
  const cell = size * 0.026;
  const glyphW = 5 * cell;
  const glyphH = 7 * cell;
  const totalW = glyphW * 3 + cell * 2;
  const tx = (size - totalW) / 2;
  const ty = by0 + (by1 - by0 - glyphH) / 2;
  for (let gi = 0; gi < 3; gi++) {
    const ch = ['P', 'D', 'F'][gi];
    const glyph = FONT[ch];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        const px0 = tx + gi * (glyphW + cell) + gx * cell;
        const py0 = ty + gy * cell;
        for (let y = 0; y < cell; y++) {
          for (let x = 0; x < cell; x++) {
            blend(canvas, Math.round(px0 + x), Math.round(py0 + y), 255, 255, 255, 255);
          }
        }
      }
    }
  }

  // 三条灰色文字行（纸面下方）
  const lineY = [size * 0.62, size * 0.71, size * 0.8];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;
          for (const ly of lineY) {
            if (X >= size * 0.2 && X <= size * 0.8 && Math.abs(Y - ly) <= size * 0.014) {
              blend(canvas, px, py, 176, 182, 194, 220);
            }
          }
        }
      }
    }
  }
  return canvas;
}

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
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    src.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
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
          const sx0 = Math.min(src.size - 1, Math.floor(x * f + (sx * f) / 2));
          const sy0 = Math.min(src.size - 1, Math.floor(y * f + (sy * f) / 2));
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

const canvas512 = drawFileIcon(512);
const png512 = encodePng(canvas512);
const canvas256 = downsample(canvas512, 256);
const png256 = encodePng(canvas256);

writeFileSync(join(outDir, 'file-assoc.png'), png512);
writeFileSync(join(outDir, 'file-assoc.ico'), icoFromPng(png256, 256));
console.log(`[make-file-icon] generated build/file-assoc.png and build/file-assoc.ico`);
