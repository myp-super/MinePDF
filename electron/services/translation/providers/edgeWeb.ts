import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import type { ProviderTranslateInput, TranslationProvider } from '../types';
import { joinTranslatedChunks, splitTextByUtf8Bytes } from './textChunks';

const LANGUAGE_MAP: Record<string, string> = {
  'en-US': 'en', en: 'en',
  'zh-CN': 'zh-Hans', zh: 'zh-Hans',
  ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};

interface EdgeResponseRow {
  translations?: Array<{ text?: string; to?: string }>;
  detectedLanguage?: { language?: string };
}

/** Microsoft Edge's browser translation endpoint. It does not require a user API key. */
export class EdgeWebProvider implements TranslationProvider {
  readonly id = 'edge' as const;
  readonly name = 'Microsoft Edge';
  readonly model = 'Microsoft Edge browser translation';
  readonly glossaryMode = 'protected-terms' as const;

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const source = LANGUAGE_MAP[input.sourceLanguage] ?? input.sourceLanguage;
    const target = LANGUAGE_MAP[input.targetLanguage] ?? input.targetLanguage;
    const output: string[] = [];
    let detectedLanguage: string | undefined;

    for (const chunk of splitTextByUtf8Bytes(input.text, 4_000)) {
      const url = new URL('https://edge.microsoft.com/translate/translatetext');
      if (input.sourceLanguage !== 'auto') url.searchParams.set('from', source);
      url.searchParams.set('to', target);
      url.searchParams.set('isEnterpriseClient', 'false');
      const response = await fetchWithPolicy(
        url.toString(),
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify([chunk]),
        },
        input.signal,
        Math.min(input.timeoutMs, 12_000),
        1,
      );
      const data = await readJsonResponse<EdgeResponseRow[]>(response, this.name);
      const row = Array.isArray(data) ? data[0] : undefined;
      const value = row?.translations?.[0]?.text?.trim();
      if (!value) throw new TranslationError('EMPTY_RESULT', 'Microsoft Edge returned an empty translation', true);
      output.push(value);
      detectedLanguage ||= row?.detectedLanguage?.language;
    }

    return {
      translatedText: joinTranslatedChunks(output),
      provider: this.id,
      providerName: this.name,
      providerModel: this.model,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      detectedLanguage,
    };
  }
}
