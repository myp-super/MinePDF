import type { TranslationErrorPayload } from '../shared/types';

export function parseTranslationError(error: unknown): TranslationErrorPayload {
  const embedded = (error as { translationError?: TranslationErrorPayload } | null)?.translationError;
  if (embedded?.code && typeof embedded.message === 'string' && typeof embedded.retryable === 'boolean') {
    return embedded;
  }
  const fallback: TranslationErrorPayload = {
    code: 'PROVIDER_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
  const message = error instanceof Error ? error.message : String(error);
  const prefix = 'TRANSLATION_ERROR:';
  const index = message.indexOf(prefix);
  if (index < 0) return fallback;
  try {
    return JSON.parse(message.slice(index + prefix.length)) as TranslationErrorPayload;
  } catch {
    return fallback;
  }
}

export function translationSelectionId(pdfId: number, page: number, text: string): string {
  let hash = 2166136261;
  const value = `${pdfId}\u0000${page}\u0000${text}`;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${pdfId}:${page}:${(hash >>> 0).toString(16)}`;
}

export function isCurrentTranslationRequest(activeRequestId: string | null, resultRequestId: string): boolean {
  return activeRequestId !== null && activeRequestId === resultRequestId;
}

export function nextTranslationNoteNumber(markdown: string): number {
  const matches = [...markdown.matchAll(/^## Translation(?:\s+(\d+))?\s*$/gim)];
  const highest = matches.reduce((max, match) => Math.max(max, Number(match[1] ?? 0)), 0);
  return Math.max(matches.length, highest) + 1;
}

export type NoteMarkdownSegment =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'translation'; sequence: number; markdown: string };

const TRANSLATION_START_RE = /<!--\s*minepdf:translation:start\s+(\d+)\s*-->/gi;
const TRANSLATION_END_RE = /<!--\s*minepdf:translation:end\s*-->/gi;

function stripTranslationHeading(markdown: string): string {
  return markdown.replace(/^\s*## Translation(?:\s+\d+)?\s*\r?\n?/i, '').trim();
}

/**
 * Splits note Markdown into normal content and MinePDF translation cards.
 * New cards use explicit HTML-comment markers so later user content is never
 * accidentally pulled into a card. Legacy blocks are recognized only when a
 * complete Time/时间 line is present, and the card ends exactly on that line.
 */
export function splitNoteMarkdown(markdown: string): NoteMarkdownSegment[] {
  const marked: NoteMarkdownSegment[] = [];
  let cursor = 0;
  let start: RegExpExecArray | null;
  TRANSLATION_START_RE.lastIndex = 0;
  while ((start = TRANSLATION_START_RE.exec(markdown)) !== null) {
    TRANSLATION_END_RE.lastIndex = TRANSLATION_START_RE.lastIndex;
    const end = TRANSLATION_END_RE.exec(markdown);
    if (!end) break;
    if (start.index > cursor) {
      marked.push({ kind: 'markdown', markdown: markdown.slice(cursor, start.index) });
    }
    marked.push({
      kind: 'translation',
      sequence: Number(start[1]),
      markdown: stripTranslationHeading(markdown.slice(TRANSLATION_START_RE.lastIndex, end.index)),
    });
    cursor = TRANSLATION_END_RE.lastIndex;
    TRANSLATION_START_RE.lastIndex = cursor;
  }
  if (marked.length > 0) {
    if (cursor < markdown.length) marked.push({ kind: 'markdown', markdown: markdown.slice(cursor) });
    return marked.filter((segment) => segment.markdown.trim());
  }

  const legacyHeading = /^## Translation(?:\s+(\d+))?\s*$/gim;
  const matches = [...markdown.matchAll(legacyHeading)];
  if (matches.length === 0) return markdown.trim() ? [{ kind: 'markdown', markdown }] : [];

  const segments: NoteMarkdownSegment[] = [];
  let legacyCursor = 0;
  matches.forEach((match, index) => {
    const headingStart = match.index ?? 0;
    if (headingStart < legacyCursor) return;
    const bodyStart = headingStart + match[0].length;
    const nextTranslation = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(bodyStart, nextTranslation);
    const timeLine = /^\*\*(?:Time|时间)\*\*\s*[:：]\s*.*$/im.exec(body);
    // An incomplete or user-authored "Translation" heading stays ordinary Markdown.
    if (!timeLine) return;
    if (headingStart > legacyCursor) {
      segments.push({ kind: 'markdown', markdown: markdown.slice(legacyCursor, headingStart) });
    }
    const bodyEnd = bodyStart + timeLine.index + timeLine[0].length;
    segments.push({
      kind: 'translation',
      sequence: Number(match[1] ?? index + 1),
      markdown: markdown.slice(bodyStart, bodyEnd).trim(),
    });
    legacyCursor = bodyEnd;
  });
  if (legacyCursor < markdown.length) {
    segments.push({ kind: 'markdown', markdown: markdown.slice(legacyCursor) });
  }
  return segments.filter((segment) => segment.markdown.trim());
}

export function formatTranslationNote(input: {
  original: string;
  translation: string;
  paperTitle: string;
  page: number;
  time: Date;
  sequence: number;
}): string {
  const stamp = input.time.toLocaleString('zh-CN', { hour12: false });
  return [
    `<!-- minepdf:translation:start ${input.sequence} -->`,
    `## Translation ${input.sequence}`,
    '',
    '**Original**',
    '',
    input.original.trim(),
    '',
    '**Translation**',
    '',
    input.translation.trim(),
    '',
    `**Source**: ${input.paperTitle} · Page ${input.page}`,
    '',
    `**Time**: ${stamp}`,
    '',
    '<!-- minepdf:translation:end -->',
    '',
  ].join('\n');
}
