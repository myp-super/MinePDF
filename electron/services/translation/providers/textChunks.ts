export function splitTextByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (maxBytes < 16) throw new Error('maxBytes must be at least 16');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    let bytes = 0;
    let hardCut = 0;
    for (const character of remaining) {
      const size = Buffer.byteLength(character, 'utf8');
      if (bytes + size > maxBytes) break;
      bytes += size;
      hardCut += character.length;
    }
    if (hardCut >= remaining.length) {
      chunks.push(remaining);
      break;
    }

    const candidate = remaining.slice(0, hardCut);
    const minimumSoftCut = Math.floor(hardCut * 0.55);
    let softCut = -1;
    const boundaries = /(?:\r?\n|[.!?。！？;；:]\s+|\s+)/gu;
    for (let match = boundaries.exec(candidate); match; match = boundaries.exec(candidate)) {
      const end = match.index + match[0].length;
      if (end >= minimumSoftCut) softCut = end;
    }
    const cut = softCut > 0 ? softCut : hardCut;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

export function joinTranslatedChunks(chunks: string[]): string {
  return chunks.map((chunk) => chunk.trim()).filter(Boolean).join('\n');
}
