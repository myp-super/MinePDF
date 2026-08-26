export function stripFormulaCodeFence(value: string): string {
  return value.replace(/^```(?:json|latex|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function formulaMarkdown(latex: string): string {
  return `$$\n${latex.trim()}\n$$`;
}

export function normalizeLocalFormulaLatex(value: string): string {
  let latex = value.trim();
  const namedFunctions = ['sigmoid', 'softmax', 'argmax', 'argmin', 'relu', 'gelu', 'tanh', 'log', 'exp', 'sin', 'cos', 'tan'];
  for (const name of namedFunctions) {
    const spaced = new RegExp(`\\b${name.split('').join('\\s+')}\\b`, 'gi');
    latex = latex.replace(spaced, `\\operatorname{${name}}`);
  }
  return latex
    .replace(/\\bf\s+([A-Za-z0-9])/g, '\\mathbf{$1}')
    .replace(/{\s+/g, '{')
    .replace(/\s+}/g, '}')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')');
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
