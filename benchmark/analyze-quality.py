# 量化对比 PDF.js / PDFium 渲染画质（清晰度、差异、空白率、尺寸）
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.stdout.reconfigure(encoding="utf-8")

OUT = os.path.join(os.path.dirname(__file__), "out")


def lap_var(gray):
    """拉普拉斯方差：衡量图像锐度/边缘能量"""
    edges = gray.filter(ImageFilter.FIND_EDGES)
    arr = np.asarray(edges, dtype=np.float32)
    return float(arr.var())


print(f"{'文件':<18}{'引擎':<8}{'尺寸':<16}{'锐度':<10}{'空白%':<8}{'Png大小'}")
for d in sorted(glob.glob(os.path.join(OUT, "**", "*_s2"), recursive=True)):
    if not os.path.isdir(d):
        continue
    pair = {}
    for eng in ("pdfjs", "pdfium"):
        p = os.path.join(d, f"{eng}_p1.png")
        if os.path.exists(p):
            pair[eng] = p
    if len(pair) != 2:
        continue
    label = os.path.basename(os.path.dirname(d)) if "英语" in d else os.path.basename(d)
    imgs = {}
    for eng, p in pair.items():
        im = Image.open(p).convert("RGB")
        gray = im.convert("L")
        arr = np.asarray(gray)
        blank = 100.0 * (arr > 250).mean()
        imgs[eng] = im
        print(
            f"{label:<18}{eng:<8}{str(im.size):<16}{lap_var(gray):<10.3f}{blank:<8.1f}"
            f"{os.path.getsize(p) // 1024}KB"
        )
    # 两图差异（统一尺寸后逐像素平均绝对差）
    a = imgs["pdfjs"].resize(imgs["pdfium"].size)
    aa = np.asarray(a, dtype=np.float32)
    bb = np.asarray(imgs["pdfium"], dtype=np.float32)
    diff = np.abs(aa - bb).mean()
    print(f"{'':<18}{'MAE':<8}{diff:<16.2f}")
