# 生成一个带 /Rotate 90 的单页 PDF，用于验证 PDFium 旋转处理
import os

import pypdfium2 as pdfium

out_dir = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(out_dir, exist_ok=True)
pdf_path = os.path.join(out_dir, "rotated-test.pdf")

content = "BT /F1 20 Tf 72 720 Td (Rotated Hello) Tj ET"
objs = {
    1: "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    2: "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    3: (
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 "
        "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
    ),
    4: f"4 0 obj\n<< /Length {len(content.encode('latin1'))} >>\nstream\n{content}\nendstream\nendobj\n",
    5: "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
}
pdf = "%PDF-1.4\n"
offs = {}
for i in sorted(objs):
    offs[i] = len(pdf.encode("latin1"))
    pdf += objs[i]
xref = len(pdf.encode("latin1"))
pdf += "xref\n0 6\n0000000000 65535 f \n"
for i in range(1, 6):
    pdf += f"{offs[i]:010d} 00000 n \n"
pdf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
with open(pdf_path, "wb") as f:
    f.write(pdf.encode("latin1"))

doc = pdfium.PdfDocument(pdf_path)
pg = doc[0]
print("rotation", pg.get_rotation(), "size", pg.get_size())
bmp = pg.render(scale=2.0)
print("pypdfium2 render size", bmp.size)
bmp.to_pil().save(os.path.join(out_dir, "rotated-pypdfium.png"))
doc.close()
