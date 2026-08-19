/**
 * 文献元数据识别（科研工作流）。
 *
 * 分级策略：
 * 1. 从 PDF 首页文本提取 DOI（本地，必做）；
 * 2. 有 DOI 时尽力联网 Crossref 补全（超时/失败静默，不阻塞阅读）；
 * 3. 本地启发式提取标题/作者/年份（低置信度，需用户确认）；
 * 4. 识别结果只填空字段，绝不覆盖用户已手动填写的内容。
 */
import type { DetectedLiterature, LiteratureMetadata } from '../../src/shared/types';
import { repository } from '../db/repository';
import { pdfiumTextChars } from './pdfium';

/** 用 PDFium 字符框重建第一页的视觉行（y-up 按基线分组） */
function pageLines(pdfId: number): string[] {
  try {
    const chars = pdfiumTextChars(pdfId, 1);
    if (!chars.length) return [];
    const sorted = [...chars].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: { y: number; parts: string[] }[] = [];
    const tol = 3;
    for (const c of sorted) {
      let target = -1;
      for (let i = 0; i < lines.length; i++) {
        if (Math.abs(lines[i].y - c.y) <= tol) {
          target = i;
          break;
        }
      }
      if (target < 0) {
        lines.push({ y: c.y, parts: [] });
        target = lines.length - 1;
      }
      lines[target].parts.push(c.str);
    }
    lines.sort((a, b) => b.y - a.y);
    return lines
      .map((l) => l.parts.join('').replace(/[ \t]+/g, ' ').trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function extractDoi(text: string): string | null {
  const m = /(?:doi:\s*|https?:\/\/doi\.org\/)?(10\.\d{4,9}\/[^\s"']+)/i.exec(text);
  if (!m) return null;
  return m[1].replace(/[.,;:)\]}>]+$/, '');
}

function extractYear(text: string): number | null {
  const m = /\b(19|20)\d{2}\b/.exec(text);
  return m ? Number(m[0]) : null;
}

interface CrossrefWork {
  title?: string[];
  author?: Array<{ given?: string; family?: string }>;
  'container-title'?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  published?: { 'date-parts'?: number[][] };
  abstract?: string;
  subject?: string[];
}

/** 尽力联网解析 DOI（超时静默失败，返回 null） */
async function crossrefByDoi(doi: string): Promise<Partial<DetectedLiterature> | null> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'MinePDF/3.7 (mailto:myp-super@users.noreply.github.com)' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { message?: CrossrefWork };
    const m = json.message;
    if (!m) return null;
    const out: Partial<DetectedLiterature> = {};
    if (m.title?.[0]) out.title = m.title[0];
    if (m.author?.length) {
      out.authors = m.author
        .map((a) => [a.given, a.family].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('; ');
    }
    if (m['container-title']?.[0]) out.journal = m['container-title'][0];
    if (m.volume) out.volume = String(m.volume);
    if (m.issue) out.issue = String(m.issue);
    if (m.page) out.pages = String(m.page);
    const year = m.published?.['date-parts']?.[0]?.[0];
    if (year) out.year = year;
    if (m.abstract) {
      out.abstract = m.abstract
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (m.subject?.length) out.keywords = m.subject.slice(0, 8).join(', ');
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** 本地启发式：标题/作者（低置信度，供用户确认） */
function localHeuristics(lines: string[]): Partial<DetectedLiterature> {
  const out: Partial<DetectedLiterature> = {};
  const title = lines.find((l) => l.length >= 20 && l.length <= 300);
  if (title) out.title = title;
  const ti = lines.indexOf(title ?? '');
  for (let i = ti + 1; i < Math.min(lines.length, ti + 3); i++) {
    const l = lines[i];
    if (l.length > 6 && l.length < 200 && /[,;]|\band\b/i.test(l)) {
      out.authors = l.replace(/\s+/g, ' ').trim();
      break;
    }
  }
  return out;
}

/** 识别文献元数据（不落库）；失败返回 null，不抛错 */
export function detectLiterature(pdfId: number): DetectedLiterature | null {
  const lines = pageLines(pdfId);
  if (!lines.length) return null;
  const text = lines.join('\n');
  const doi = extractDoi(text);
  const year = extractYear(text);
  const heuristic = localHeuristics(lines);
  const result: DetectedLiterature = {
    ...heuristic,
    confidence: 'low',
  };
  if (doi) result.doi = doi;
  if (year) result.year = year;
  return result;
}

/** 识别并合并保存：只填空字段，不覆盖用户已有内容；网络失败保持低置信结果 */
export async function detectAndSave(pdfId: number): Promise<LiteratureMetadata | null> {
  const local = detectLiterature(pdfId);
  if (!local) return null;
  let merged: Partial<DetectedLiterature> = local;
  if (local.doi) {
    const remote = await crossrefByDoi(local.doi);
    if (remote) {
      merged = { ...remote, doi: local.doi, confidence: 'high' };
    }
  }
  const existing = repository.getLiterature(pdfId);
  const patch: Partial<LiteratureMetadata> = { autoDetected: true };
  const map: Array<[keyof LiteratureMetadata, string | number | null | undefined]> = [
    ['title', merged.title],
    ['authors', merged.authors],
    ['journal', merged.journal],
    ['conference', merged.conference],
    ['year', merged.year],
    ['volume', merged.volume],
    ['issue', merged.issue],
    ['pages', merged.pages],
    ['doi', merged.doi],
    ['abstract', merged.abstract],
    ['keywords', merged.keywords],
  ];
  for (const [key, val] of map) {
    const cur = existing ? String(existing[key] ?? '') : '';
    if (!cur && val != null && String(val).trim()) {
      (patch as Record<string, unknown>)[key] = val;
    }
  }
  return repository.upsertLiterature(pdfId, patch);
}
