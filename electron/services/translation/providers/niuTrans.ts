import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import type { ProviderTranslateInput, TranslationProvider } from '../types';

const LANGUAGE_MAP: Record<string, string> = {
  auto: 'auto',
  'en-US': 'en', en: 'en',
  'zh-CN': 'zh', zh: 'zh',
  ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};

interface NiuTransResponse {
  tgt_text?: string;
  to?: string;
  error_code?: string;
  error_msg?: string;
}

export class NiuTransProvider implements TranslationProvider {
  readonly id = 'niutrans' as const;
  readonly name = 'NiuTrans';
  readonly model = 'NiuTrans API';
  readonly glossaryMode = 'protected-terms' as const;

  constructor(private readonly apiKey: string) {}

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const body = new URLSearchParams({
      from: LANGUAGE_MAP[input.sourceLanguage] ?? input.sourceLanguage,
      to: LANGUAGE_MAP[input.targetLanguage] ?? input.targetLanguage,
      apikey: this.apiKey,
      src_text: input.text,
    });
    const response = await fetchWithPolicy(
      'https://api.niutrans.com/NiuTransServer/translation',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      input.signal,
      input.timeoutMs,
    );
    const data = await readJsonResponse<NiuTransResponse>(response, this.name);
    if (data.error_code) {
      const unauthorized = ['10005', '10006', '13001'].includes(data.error_code);
      throw new TranslationError(
        unauthorized ? 'UNAUTHORIZED' : 'PROVIDER_ERROR',
        data.error_msg || `NiuTrans error ${data.error_code}`,
        !unauthorized,
      );
    }
    const translatedText = data.tgt_text?.trim();
    if (!translatedText) throw new TranslationError('EMPTY_RESULT', 'Provider returned an empty translation', true);
    return {
      translatedText,
      provider: this.id,
      providerName: this.name,
      providerModel: this.model,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      detectedLanguage: input.sourceLanguage === 'auto' ? undefined : input.sourceLanguage,
    };
  }
}
