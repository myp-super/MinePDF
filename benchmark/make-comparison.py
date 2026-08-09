# 生成 PDF.js vs PDFium 画质对比图（整页并排 + 局部裁剪放大）
import glob
import os
import re
import sys

from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8")

OUT = os.path.join(os.path.dirname(__file__), "out")
COMP = os.path.join(OUT, "comparison")
if os.path.isdir(COMP):
    for f in os.listdir(COMP):
        os.remove(os.path.join(COMP, f))
else:
    os.makedirs(COMP, exist_ok=True)


def load(name, page):
    d = os.path.join(OUT, name)
    pjs = os.path.join(d, f"pdfjs_p{page}.png")
    pfm = os.path.join(d, f"pdfium_p{page}.png")
    return pjs, pfm


cases = []
for d in sorted(glob.glob(os.path.join(OUT, "**", "*_s2"), recursive=True)):
    if os.path.isdir(d) and os.path.exists(os.path.join(d, "pdfjs_p1.png")) and os.path.exists(os.path.join(d, "pdfium_p1.png")):
        base = os.path.basename(d)
        if base.startswith("PID"):
            label = "PID-Tuning-Methods"
        elif base.startswith("sn-article"):
            label = "sn-article"
        elif "感受野" in d:
            label = "感受野"
        elif "英语" in d:
            label = "英语复习资料"
        else:
            label = base
        cases.append((d, label, 1))

for folder, label, page in cases:
    pjs, pfm = load(folder, page)
    if not (os.path.exists(pjs) and os.path.exists(pfm)):
        print("skip", folder)
        continue
    a = Image.open(pjs).convert("RGB")
    b = Image.open(pfm).convert("RGB")

    # 统一高度后并排（加分隔线 + 标签）
    h = min(a.height, b.height)
    w = int(a.width * h / a.height), int(b.width * h / b.height)
    a = a.resize((w[0], h))
    b = b.resize((w[1], h))
    gap = 8
    canvas = Image.new("RGB", (w[0] + w[1] + gap, h + 24), (20, 22, 26))
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 6), "PDF.js", fill=(255, 255, 255))
    draw.text((w[0] + gap + 10, 6), "PDFium", fill=(255, 255, 255))
    canvas.paste(a, (0, 24))
    canvas.paste(b, (w[0] + gap, 24))
    canvas.save(os.path.join(COMP, f"{label}_full.png"))

    # 局部裁剪：取同一区域（约页面宽度 45% 处、高度 60% 处）放大 3 倍
    cx = int(w[0] * 0.45)
    cy = int(h * 0.6)
    cw = int(w[0] * 0.35)
    ch = int(h * 0.2)
    ca = a.crop((cx, cy, min(cx + cw, a.width), min(cy + ch, a.height)))
    cb = b.crop((cx, cy, min(cx + cw, b.width), min(cy + ch, b.height)))
    ca = ca.resize((ca.width * 3, ca.height * 3), Image.LANCZOS)
    cb = cb.resize((cb.width * 3, cb.height * 3), Image.LANCZOS)
    h2 = max(ca.height, cb.height)
    w2 = ca.width + cb.width + gap
    canvas2 = Image.new("RGB", (w2, h2 + 24), (20, 22, 26))
    draw2 = ImageDraw.Draw(canvas2)
    draw2.text((10, 6), "PDF.js (放大)", fill=(255, 255, 255))
    draw2.text((ca.width + gap + 10, 6), "PDFium (放大)", fill=(255, 255, 255))
    canvas2.paste(ca, (0, 24))
    canvas2.paste(cb, (ca.width + gap, 24))
    canvas2.save(os.path.join(COMP, f"{label}_crop.png"))
    print("saved", label)
