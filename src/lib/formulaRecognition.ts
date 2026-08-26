export function stripFormulaCodeFence(value: string): string {
  return value.replace(/^```(?:json|latex|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function formulaMarkdown(latex: string): string {
  return `$$\n${latex.trim()}\n$$`;
}

export function parseFormulaRecognition(value: string): { latex: string; markdown: string } {
  const cleaned = stripFormulaCodeFence(value);
  try {
    const parsed = JSON.parse(cleaned) as { latex?: unknown; markdown?: unknown };
    if (typeof parsed.latex === 'string' && parsed.latex.trim()) {
      const latex = stripFormulaCodeFence(parsed.latex)
        .replace(/^\\\[\s*/, '')
        .replace(/\s*\\\]$/, '')
        .replace(/^\$\$\s*/, '')
        .replace(/\s*\$\$$/, '')
        .trim();
      return { latex, markdown: formulaMarkdown(latex) };
    }
  } catch {
    /* Compatible models may ignore the requested JSON shape. */
  }
  const latex = cleaned
    .replace(/^\\\(\s*/, '')
    .replace(/\s*\\\)$/, '')
    .replace(/^\\\[\s*/, '')
    .replace(/\s*\\\]$/, '')
    .replace(/^\$\$\s*/, '')
    .replace(/\s*\$\$$/, '')
    .trim();
  return { latex, markdown: formulaMarkdown(latex) };
}
