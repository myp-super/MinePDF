import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import type { ProviderTranslateInput, TranslationProvider } from '../types';
import { joinTranslatedChunks, splitTextByUtf8Bytes } from './textChunks';

const LANGUAGE_MAP: Record<string, string> = {
  auto: 'Autodetect',
  'en-US': 'en', en: 'en',
  'zh-CN': 'zh-CN', zh: 'zh-CN',
  ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};

interface MyMemoryResponse {
  responseData?: { translatedText?: string; detectedLanguage?: string };
  responseStatus?: number | string;
  responseDetails?: string;
  quotaFinished?: boolean;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export class MyMemoryProvider implements TranslationProvider {
  readonly id = 'mymemory' as const;
  readonly name = 'MyMemory';
  readonly model = 'MyMemory public API';
  readonly glossaryMode = 'protected-terms' as const;

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const source = LANGUAGE_MAP[input.sourceLanguage] ?? input.sourceLanguage;
    const target = LANGUAGE_MAP[input.targetLanguage] ?? input.targetLanguage;
    const translated: string[] = [];
    let detectedLanguage: string | undefined;

    for (const chunk of splitTextByUtf8Bytes(input.text, 450)) {
      const url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', chunk);
      url.searchParams.set('langpair', `${source}|${target}`);
      const response = await fetchWithPolicy(
        url.toString(),
        { method: 'GET' },
        input.signal,
        Math.min(input.timeoutMs, 10_000),
        1,
      );
      const data = await readJsonResponse<MyMemoryResponse>(response, this.name);
      const status = Number(data.responseStatus ?? 200);
      if (data.quotaFinished || status === 429) {
        throw new TranslationError('RATE_LIMITED', data.responseDetails || 'MyMemory free quota has been reached', true, 429);
      }
      if (status >= 400) {
        throw new TranslationError(
          status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
          data.responseDetails || `MyMemory returned status ${status}`,
          status >= 500,
          status,
        );
      }
      const value = data.responseData?.translatedText?.trim();
      if (!value) throw new TranslationError('EMPTY_RESULT', 'MyMemory returned an empty translation', true);
      translated.push(decodeEntities(value));
      detectedLanguage ||= data.responseData?.detectedLanguage;
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
