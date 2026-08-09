// 生成 NSIS 安装程序品牌资源（BMP，24bit）：
// - installerSidebar.bmp    164x314：欢迎/完成页左侧竖条（logo + “更新中，请稍候”）
// - installerHeaderIcon.bmp 150x57：安装向导顶部右侧小图标
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function writeBmp(canvas, file) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, w, h).data;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelOffset = 54;
  const fileSize = pixelOffset + rowSize * h;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(pixelOffset, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const si = (srcY * w + x) * 4;
      const di = pixelOffset + y * rowSize + x * 3;
      buf[di] = data[si + 2];
      buf[di + 1] = data[si + 1];
      buf[di + 2] = data[si];
    }
  }
  writeFileSync(file, buf);
}

const out = join(process.cwd(), 'build');
const font = '"Segoe UI", "Microsoft YaHei", sans-serif';

// ---------- 侧边栏 164x314 ----------
{
  const w = 164;
  const h = 314;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#161a23');
  grad.addColorStop(0.55, '#0f131b');
  grad.addColorStop(1, '#0a0d12');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // 顶部细蓝线
  ctx.fillStyle = '#5b8def';
  ctx.fillRect(0, 0, w, 3);
  // logo
  try {
    const logo = await loadImage(join(process.cwd(), 'public', 'logo.svg'));
    const lw = 58;
    ctx.drawImage(logo, (w - lw) / 2, 52, lw, lw);
  } catch {
    // SVG 加载失败时用简化图形占位
    ctx.fillStyle = '#5b8def';
    ctx.beginPath();
    ctx.roundRect((w - 58) / 2, 52, 58, 58, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 26px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', w / 2, 82);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e6edf3';
  ctx.font = `600 18px ${font}`;
  ctx.textAlign = 'center';
  ctx.fillText('MinePDF', w / 2, 138);
  ctx.fillStyle = '#8b98ab';
  ctx.font = `12px ${font}`;
  ctx.fillText('更新中，请稍候', w / 2, 166);
  ctx.fillStyle = '#4b5668';
  ctx.fillText('Update in progress', w / 2, 186);
  // 底部版权
  ctx.font = `9px ${font}`;
  ctx.fillStyle = '#3a4352';
  ctx.fillText('MinePDF © 2026', w / 2, h - 16);
  writeBmp(c, join(out, 'installerSidebar.bmp'));
  console.log('[installer-assets] sidebar 164x314 written');
}

// ---------- 头部小图标 150x57 ----------
{
  const w = 150;
  const h = 57;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#10141c';
  ctx.fillRect(0, 0, w, h);
  try {
    const logo = await loadImage(join(process.cwd(), 'public', 'logo.svg'));
    ctx.drawImage(logo, 10, 10, 37, 37);
  } catch {
    ctx.fillStyle = '#5b8def';
    ctx.beginPath();
    ctx.roundRect(12, 12, 33, 33, 7);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 16px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', 28, 30);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e6edf3';
  ctx.font = `600 17px ${font}`;
  ctx.textAlign = 'left';
  ctx.fillText('MinePDF', 58, 26);
  ctx.fillStyle = '#8b98ab';
  ctx.font = `10px ${font}`;
  ctx.fillText('更新中，请稍候', 58, 44);
  writeBmp(c, join(out, 'installerHeaderIcon.bmp'));
  console.log('[installer-assets] header 150x57 written');
}
