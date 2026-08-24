const NOTE_REFERENCE_RE = /^minepdf:\/\/ref\/(\d+)$/;

export function parseNoteReferenceUrl(url: string | null | undefined): number | null {
  const match = NOTE_REFERENCE_RE.exec(url ?? '');
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function preserveNoteReferenceUrl(url: string): string | null {
  return parseNoteReferenceUrl(url) != null ? url : null;
}
