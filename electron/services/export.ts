/**
 * 文献导出服务：Excel (.xlsx) / CSV (.csv)。
 * - 一篇文献一行，顺序严格跟随传入的 pdfIds；
 * - Excel：首行加粗、冻结首行、启用筛选、列宽自适应、长文本换行；
 * - 中文/换行/特殊字符安全，空字段留空，不截断。
 */
import { dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import type {
  ExportFormat,
  LiteratureMetadata,
  LiteratureReview,
  PdfRecord,
  Tag,
} from '../../src/shared/types';
import { repository } from '../db/repository';

export interface ExportRow {
  pdf: PdfRecord;
  literature: LiteratureMetadata | null;
  review: LiteratureReview | null;
  tags: Tag[];
}

const HEADERS = [
  '标题',
  '作者',
  '期刊/会议',
  '年份',
  'DOI',
  'URL',
  '关键词',
  '摘要',
  '标签',
  '阅读状态',
  '研究背景',
  '研究问题',
  '现有方法',
  '现有方法的问题',
  '核心方法',
  '主要创新',
  '实验与结果',
  '论文局限',
  '我的理解',
  '我的疑问',
  '对我的研究的启发',
  '一句话总结',
];

const STATUS_LABEL: Record<string, string> = {
  unread: '未读',
  reading: '阅读中',
  read: '已读',
};

function cell(row: ExportRow, idx: number): string {
  const { literature: l, review: r, tags } = row;
  const status = l?.readingStatus ?? 'unread';
  const venue = [l?.journal, l?.conference].filter(Boolean).join(' / ');
  const cells = [
    l?.title ?? '',
    l?.authors ?? '',
    venue,
    l?.year != null ? String(l.year) : '',
    l?.doi ?? '',
    l?.url ?? '',
    l?.keywords ?? '',
    l?.abstract ?? '',
    tags.map((t) => t.name).join(', '),
    STATUS_LABEL[status] ?? status,
    r?.background ?? '',
    r?.researchQuestion ?? '',
    r?.existingMethods ?? '',
    r?.existingMethodProblems ?? '',
    r?.coreMethod ?? '',
    r?.innovations ?? '',
    r?.experiments ?? '',
    r?.limitations ?? '',
    r?.myUnderstanding ?? '',
    r?.myQuestions ?? '',
    r?.researchImplications ?? '',
    r?.oneSentenceSummary ?? '',
  ];
  return cells[idx] ?? '';
}

function collectRows(pdfIds: number[]): ExportRow[] {
  const out: ExportRow[] = [];
  for (const id of pdfIds) {
    const pdf = repository.getPdf(id);
    if (!pdf) continue;
    out.push({
      pdf,
      literature: repository.getLiterature(id),
      review: repository.getLiteratureReview(id),
      tags: pdf.tags,
    });
  }
  return out;
}

async function writeXlsx(filePath: string, rows: ExportRow[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('文献');
  ws.addRow(HEADERS);
  // 字体：含中文的单元格用宋体，纯英文/数字用 Times New Roman
  const cellFont = (value: string): { name: string } =>
    /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(value)
      ? { name: '宋体' }
      : { name: 'Times New Roman' };
  ws.getRow(1).eachCell((c) => {
    c.font = { ...cellFont(String(c.value ?? '')), bold: true };
  });
  for (const r of rows) {
    const row = ws.addRow(HEADERS.map((_, i) => cell(r, i)));
    row.eachCell((c) => {
      c.font = cellFont(String(c.value ?? ''));
    });
  }
  // 自适应列宽：按“显示宽度”估算（中文全角字符按 2 计，表头/单元格同规则），封顶 50
  const widths = HEADERS.map((_, c) => {
    let max = displayWidth(HEADERS[c]);
    for (const r of rows) max = Math.max(max, displayWidth(cell(r, c)));
    return Math.min(50, Math.max(10, max + 2));
  });
  ws.columns = widths.map((w) => ({ width: w }));
  // 长文本换行 + 按估算行数自适应行高
  for (let c = 1; c <= HEADERS.length; c++) {
    const col = ws.getColumn(c);
    col.alignment = { vertical: 'top', wrapText: true };
  }
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) {
      // 表头也按显示宽度自适应行高（中文表头换行时给足高度）
      let headerLines = 1;
      row.eachCell({ includeEmpty: true }, (cellEl, colNum) => {
        const w = widths[colNum - 1] ?? 12;
        headerLines = Math.max(headerLines, Math.ceil(displayWidth(String(cellEl.value ?? '')) / Math.max(1, w * 0.9)));
      });
      row.height = Math.min(60, Math.max(20, headerLines * 18));
      return;
    }
    let lines = 1;
    row.eachCell({ includeEmpty: true }, (cellEl, colNum) => {
      const w = widths[colNum - 1] ?? 12;
      const v = String(cellEl.value ?? '');
      lines = Math.max(lines, Math.ceil(displayWidth(v) / Math.max(1, w * 0.85)));
    });
    row.height = Math.min(220, Math.max(15, lines * 14));
  });
  // 冻结首行 + 启用筛选
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(2, rows.length + 1), column: HEADERS.length } };
  await wb.xlsx.writeFile(filePath);
}

/** 显示宽度：中文/全角字符按 2 个半角宽计，其余按 1（与 Excel 列宽单位一致） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function writeCsv(filePath: string, rows: ExportRow[]): void {
  const lines = [HEADERS.join(',')];
  for (const r of rows) {
    lines.push(HEADERS.map((_, i) => csvEscape(cell(r, i))).join(','));
  }
  // UTF-8 BOM，保证 Excel 打开中文不乱码
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
}

export async function exportLiterature(
  pdfIds: number[],
  format: ExportFormat,
): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const ext = format === 'xlsx' ? 'xlsx' : 'csv';
  const res = dialog.showSaveDialogSync({
    defaultPath: `MinePDF-文献导出-${date}.${ext}`,
    filters: [{ name: format === 'xlsx' ? 'Excel 工作簿' : 'CSV', extensions: [ext] }],
  });
  if (!res) return null;
  const rows = collectRows(pdfIds);
  if (format === 'xlsx') await writeXlsx(res, rows);
  else writeCsv(res, rows);
  return res;
}
