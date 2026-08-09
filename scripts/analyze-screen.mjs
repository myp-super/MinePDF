// 分析应用截图：定位白色 PDF 页面在窗口中的位置（居中/偏移检测）
// 用法: node scripts/analyze-screen.mjs <screenshot.png>
import { createCanvas, loadImage } from '@napi-rs/canvas';

const png = process.argv[2];
const img = await loadImage(png);
const W = img.width;
const H = img.height;
const tmp = createCanvas(W, H);
const ctx = tmp.getContext('2d');
ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, W, H).data;

// 页面 = 大面积近白色区域；背景深色
let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
let sumX = 0, sumY = 0, count = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 235 && g > 235 && b > 235) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x; sumY += y; count++;
    }
  }
}

const pageW = maxX - minX + 1;
const pageH = maxY - minY + 1;
const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
console.log('window', `${W}x${H}`);
console.log('page bbox', `x:[${minX},${maxX}] y:[${minY},${maxY}]`, `${pageW}x${pageH}`);
console.log('page center', `(${cx.toFixed(1)},${cy.toFixed(1)})`, 'window center', `(${W / 2},${H / 2})`);
console.log(
  'left margin', minX,
  'right margin', W - maxX - 1,
  'top margin', minY,
  'bottom margin', H - maxY - 1,
);
console.log('white px', count, `(${(100 * count / (W * H)).toFixed(1)}%)`);
