# PDFium 渲染基准：使用 pypdfium2 渲染同一批页面
# 用法: python benchmark/pdfium-bench.py <pdf路径> <起始页> <页数> <scale> <输出目录>
import json
import os
import sys
import time

import pypdfium2 as pdfium


def main():
    pdf_path = sys.argv[1]
    start_page = int(sys.argv[2])
    page_count = int(sys.argv[3])
    scale = float(sys.argv[4])
    out_dir = sys.argv[5]

    t0 = time.perf_counter()
    doc = pdfium.PdfDocument(pdf_path)
    cold_ms = (time.perf_counter() - t0) * 1000

    total = min(page_count, len(doc) - start_page)
    times = []
    pngs = []
    for i in range(total):
        page = doc[start_page + i]
        # 预热一次，排除字体/资源加载
        if i == 0:
            warm = page.render(scale=scale / 8)
            warm.close()
        t1 = time.perf_counter()
        bitmap = page.render(scale=scale)
        times.append((time.perf_counter() - t1) * 1000)
        img = bitmap.to_pil()
        png_path = os.path.join(out_dir, f"pdfium_p{start_page + i + 1}.png")
        img.save(png_path)
        pngs.append(png_path)
        img.close()
        bitmap.close()
        page.close()

    times.sort()
    result = {
        "engine": "pdfium",
        "file": pdf_path,
        "scale": scale,
        "pagesRendered": total,
        "coldOpenMs": cold_ms,
        "perPageMs": times,
        "medianMs": times[len(times) // 2],
        "meanMs": sum(times) / len(times),
        "maxMs": times[-1],
        "pngs": pngs,
    }
    # 等待宿主进程读取内存后放行（宿主通过 stdin 发送换行）
    print("READY", flush=True)
    sys.stdin.readline()
    print(json.dumps(result), flush=True)
    doc.close()


if __name__ == "__main__":
    main()
