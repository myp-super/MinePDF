import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import type { ProviderTranslateInput, TranslationProvider } from '../types';
import { joinTranslatedChunks, splitTextByUtf8Bytes } from './textChunks';

const LANGUAGE_MAP: Record<string, string> = {
  auto: 'Auto',
  'en-US': 'en', en: 'en',
  'zh-CN': 'zh-CHS', zh: 'zh-CHS',
  ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};

interface YoudaoResponse {
  errorCode?: string;
  translation?: string[];
  l?: string;
}

export class YoudaoWebProvider implements TranslationProvider {
  readonly id = 'youdao' as const;
  readonly name = 'Youdao Web';
  readonly model = 'Youdao public web translation';
  readonly glossaryMode = 'protected-terms' as const;

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const translated: string[] = [];
    let detectedLanguage: string | undefined;
    for (const chunk of splitTextByUtf8Bytes(input.text, 1_800)) {
      const body = new URLSearchParams({
        q: chunk,
        from: LANGUAGE_MAP[input.sourceLanguage] ?? input.sourceLanguage,
        to: LANGUAGE_MAP[input.targetLanguage] ?? input.targetLanguage,
      });
      const response = await fetchWithPolicy(
        'https://aidemo.youdao.com/trans',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Referer: 'https://fanyi.youdao.com/',
          },
          body: body.toString(),
        },
        input.signal,
        Math.min(input.timeoutMs, 6_000),
        1,
      );
      const data = await readJsonResponse<YoudaoResponse>(response, this.name);
      const value = data.translation?.join('\n').trim();
      if (data.errorCode !== '0' || !value) {
        throw new TranslationError('EMPTY_RESULT', 'Youdao Web returned no usable translation', true);
      }
      translated.push(value);
      detectedLanguage ||= data.l?.split('2')[0];
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
