import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import type { ProviderTranslateInput, TranslationProvider } from '../types';
import { joinTranslatedChunks, splitTextByUtf8Bytes } from './textChunks';

const LANGUAGE_MAP: Record<string, string> = {
  auto: 'auto',
  'en-US': 'en', en: 'en',
  'zh-CN': 'zh', zh: 'zh',
  ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};

interface TransmartResponse {
  header?: { ret_code?: string };
  auto_translation?: string[];
  src_lang?: string;
}

export class TransmartWebProvider implements TranslationProvider {
  readonly id = 'transmart' as const;
  readonly name = 'Tencent TranSmart';
  readonly model = 'Tencent TranSmart web translation';
  readonly glossaryMode = 'protected-terms' as const;

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const translated: string[] = [];
    let detectedLanguage: string | undefined;
    for (const chunk of splitTextByUtf8Bytes(input.text, 3_500)) {
      const source = LANGUAGE_MAP[input.sourceLanguage] ?? input.sourceLanguage;
      const target = LANGUAGE_MAP[input.targetLanguage] ?? input.targetLanguage;
      const response = await fetchWithPolicy(
        'https://transmart.qq.com/api/imt',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Referer: 'https://transmart.qq.com/',
          },
          body: JSON.stringify({
            header: { fn: 'auto_translation', client_key: 'browser-chrome-130', user: '' },
            type: 'plain',
            model_category: 'normal',
            source: { lang: source, text_list: [chunk] },
            target: { lang: target, text_list: [''] },
          }),
        },
        input.signal,
        Math.min(input.timeoutMs, 6_000),
        1,
      );
      const data = await readJsonResponse<TransmartResponse>(response, this.name);
      const value = data.auto_translation?.join('').trim();
      if (data.header?.ret_code !== 'succ' || !value) {
        throw new TranslationError('EMPTY_RESULT', 'Tencent TranSmart returned no usable translation', true);
      }
      translated.push(value);
      detectedLanguage ||= data.src_lang;
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
