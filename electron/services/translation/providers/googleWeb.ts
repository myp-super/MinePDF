import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import type { ProviderTranslateInput, TranslationProvider } from '../types';
import { joinTranslatedChunks, splitTextByUtf8Bytes } from './textChunks';

const LANGUAGE_MAP: Record<string, string> = {
  auto: 'auto',
  'en-US': 'en', en: 'en',
  'zh-CN': 'zh-CN', zh: 'zh-CN',
  ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};

function parseGoogleResponse(data: unknown): { translatedText: string; detectedLanguage?: string } {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new TranslationError('PROVIDER_ERROR', 'Google Web returned an unexpected response', true);
  }
  const translatedText = data[0]
    .map((segment) => Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')
    .join('')
    .trim();
  if (!translatedText) throw new TranslationError('EMPTY_RESULT', 'Google Web returned an empty translation', true);
  return { translatedText, detectedLanguage: typeof data[2] === 'string' ? data[2] : undefined };
}

export class GoogleWebProvider implements TranslationProvider {
  readonly id = 'google' as const;
  readonly name = 'Google Web';
  readonly model = 'Google Translate web endpoint';
  readonly glossaryMode = 'protected-terms' as const;

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const source = LANGUAGE_MAP[input.sourceLanguage] ?? input.sourceLanguage;
    const target = LANGUAGE_MAP[input.targetLanguage] ?? input.targetLanguage;
    const translated: string[] = [];
    let detectedLanguage: string | undefined;

    for (const chunk of splitTextByUtf8Bytes(input.text, 4_000)) {
      const url = new URL('https://translate.google.com/translate_a/single');
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', source);
      url.searchParams.set('tl', target);
      url.searchParams.set('dt', 't');
      url.searchParams.set('q', chunk);
      let response: Response;
      try {
        response = await fetchWithPolicy(
          url.toString(),
          {
            method: 'GET',
            headers: { Accept: 'application/json,text/plain,*/*' },
          },
          input.signal,
          Math.min(input.timeoutMs, 8_000),
          1,
        );
      } catch (error) {
        if (error instanceof TranslationError && error.code === 'UNAUTHORIZED') {
          throw new TranslationError('PROVIDER_UNAVAILABLE', 'Google Web rejected the unofficial endpoint request', true, error.status);
        }
        throw error;
      }
      const parsed = parseGoogleResponse(await readJsonResponse<unknown>(response, this.name));
      translated.push(parsed.translatedText);
      detectedLanguage ||= parsed.detectedLanguage;
    }

    return {
      translatedText: joinTranslatedChunks(translated),
      provider: this.id,
      providerName: this.name,
      providerModel: this.model,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      detectedLanguage,
    };
  }
}
