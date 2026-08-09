// 分析 PDF.js / PDFium 渲染图的内容位置（非白像素包围盒 + 质心）
// 用法: node scripts/analyze-position.mjs <pdfjs.png> <pdfium.png>
import { createCanvas, loadImage } from '@napi-rs/canvas';

async function stats(pngPath) {
  const img = await loadImage(pngPath);
  const w = img.width;
  const h = img.height;
  const tmp = createCanvas(w, h);
  const ctx = tmp.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 250 || g < 250 || b < 250) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x; sumY += y; count++;
      }
    }
  }
  return {
    size: `${w}x${h}`,
    bbox: `x:[${minX},${maxX}] y:[${minY},${maxY}] w=${maxX - minX + 1} h=${maxY - minY + 1}`,
    centroid: `(${(sumX / count).toFixed(1)},${(sumY / count).toFixed(1)})`,
    contentPx: count,
  };
}

const [a, b] = process.argv.slice(2);
const sa = await stats(a);
const sb = await stats(b);
console.log('pdfjs :', JSON.stringify(sa));
console.log('pdfium:', JSON.stringify(sb));
