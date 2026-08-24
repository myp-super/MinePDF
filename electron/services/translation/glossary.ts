import type { GlossaryEntry } from '../../../src/shared/types';

export interface ProtectedGlossaryText {
  text: string;
  restore(translatedText: string): string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function protectGlossaryTerms(text: string, glossary: GlossaryEntry[]): ProtectedGlossaryText {
  const terms = [...glossary].sort((a, b) => b.term.length - a.term.length);
  const replacements: Array<{ token: string; translation: string }> = [];
  let protectedText = text;
  for (const [index, entry] of terms.entries()) {
    const token = `MINEPDFGLOSSARYTOKEN${String(index).padStart(3, '0')}`;
    const pattern = new RegExp(escapeRegExp(entry.term), 'giu');
    if (!pattern.test(protectedText)) continue;
    pattern.lastIndex = 0;
    protectedText = protectedText.replace(pattern, token);
    replacements.push({ token, translation: entry.translation });
  }
  return {
    text: protectedText,
    restore(translatedText: string): string {
      let restored = translatedText;
      for (const replacement of replacements) {
        const flexible = replacement.token.split('').map(escapeRegExp).join('\\s*');
        restored = restored.replace(new RegExp(flexible, 'giu'), replacement.translation);
      }
      return restored;
    },
  };
}
