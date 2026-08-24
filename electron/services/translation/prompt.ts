import type { GlossaryEntry } from '../../../src/shared/types';

export function buildAcademicTranslationPrompt(input: {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  context?: string;
  glossary: GlossaryEntry[];
}): { system: string; user: string } {
  const glossary = input.glossary.length
    ? `\nUse these terms consistently:\n${input.glossary.map((g) => `- ${g.term} => ${g.translation}${g.domain ? ` [${g.domain}]` : ''}`).join('\n')}`
    : '';
  const system = [
    'You are an academic literature translator.',
    `Translate only the text inside <selected> from ${input.sourceLanguage} to ${input.targetLanguage}.`,
    'Use precise scholarly language. Preserve formulas, citation markers, symbols, and paragraph breaks.',
    'Context is for disambiguation only. Do not translate or include it in the output.',
    'Return only the translation without commentary or quotation marks.',
    glossary,
  ].join('\n');
  const context = input.context?.trim() ? `<context>\n${input.context.trim()}\n</context>\n\n` : '';
  return { system, user: `${context}<selected>\n${input.text}\n</selected>` };
}
