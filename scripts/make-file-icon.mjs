// PDF 文件关联图标生成器：蓝色底 + 白色纸张 + 蓝色 PDF 字样（与应用 Logo 区分，
// 且与系统里常见的白色文件图标一眼区分）。
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

  // 蓝色渐变圆角背景（铺满整块图标）
  const bgm = size * 0.02;
  const bgrr = size * 0.14;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;
          if (X >= bgm && X <= size - bgm && Y >= bgm && Y <= size - bgm) {
            const cx = Math.min(Math.max(X, bgm + bgrr), size - bgm - bgrr);
            const cy = Math.min(Math.max(Y, bgm + bgrr), size - bgm - bgrr);
            if (Math.hypot(X - cx, Y - cy) <= bgrr) {
              const t = Math.min(1, Math.max(0, (X - size * 0.08) / (size * 0.84)));
              blend(canvas, px, py, lerp(c1r, c2r, t), lerp(c1g, c2g, t), lerp(c1b, c2b, t), 255);
            }
          }
        }
      }
    }
  }

  // 白色纸张（圆角矩形，居中偏上）
  const m = size * 0.16;
  const rr = size * 0.07;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;
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
          // 右上折角（蓝灰三角）
          if (pointInPoly(X, Y, [
            [size * 0.66, size * 0.16],
            [size * 0.84, size * 0.16],
            [size * 0.66, size * 0.34],
          ])) {
            blend(canvas, px, py, 96, 122, 173, 255);
          } else if (pointInPoly(X, Y, [
            [size * 0.66, size * 0.16],
            [size * 0.84, size * 0.16],
            [size * 0.84, size * 0.34],
            [size * 0.66, size * 0.34],
          ])) {
            // 折角阴影（纸张缺角处）
            blend(canvas, px, py, 180, 194, 224, 255);
          }
        }
      }
    }
  }

  // 蓝色 "PDF" 像素字（白色纸上）
  const cell = size * 0.032;
  const glyphW = 5 * cell;
  const glyphH = 7 * cell;
  const totalW = glyphW * 3 + cell * 2;
  const tx = (size - totalW) / 2;
  const ty = size * 0.24;
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
            const t = Math.min(1, Math.max(0, (px0 - size * 0.16) / (size * 0.68)));
            blend(
              canvas,
              Math.round(px0 + x),
              Math.round(py0 + y),
              lerp(c1r, c2r, t),
              lerp(c1g, c2g, t),
              lerp(c1b, c2b, t),
              255,
            );
          }
        }
      }
    }
  }

  // 三条浅蓝文字行（纸面下方）
  const lineY = [size * 0.62, size * 0.72, size * 0.82];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + (sx + 0.5) / ss;
          const Y = py + (sy + 0.5) / ss;
          for (const ly of lineY) {
            if (X >= size * 0.26 && X <= size * 0.74 && Math.abs(Y - ly) <= size * 0.016) {
              blend(canvas, px, py, 122, 146, 196, 235);
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
