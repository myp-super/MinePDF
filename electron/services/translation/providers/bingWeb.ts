import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import type { ProviderTranslateInput, TranslationProvider } from '../types';
import { joinTranslatedChunks, splitTextByUtf8Bytes } from './textChunks';

const LANGUAGE_MAP: Record<string, string> = {
  auto: 'auto-detect',
  'en-US': 'en', en: 'en',
  'zh-CN': 'zh-Hans', zh: 'zh-Hans',
  ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};

interface BingSession {
  ig: string;
  iid: string;
  key: string;
  token: string;
  expiresAt: number;
}

interface BingResponseRow {
  translations?: Array<{ text?: string }>;
  detectedLanguage?: { language?: string };
}

let sessionCache: BingSession | null = null;

function parseSession(html: string): BingSession {
  const ig = html.match(/IG:"([A-F0-9]+)"/)?.[1];
  const iid = html.match(/data-iid="([^"]+)"/)?.[1];
  const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/);
  if (!ig || !iid || !abuse) {
    throw new TranslationError('PROVIDER_ERROR', 'Bing Web session metadata changed', true);
  }
  return {
    ig,
    iid,
    key: abuse[1],
    token: abuse[2],
    expiresAt: Date.now() + Math.max(60_000, Number(abuse[3]) - 60_000),
  };
}

async function getSession(input: ProviderTranslateInput, force = false): Promise<BingSession> {
  if (!force && sessionCache && sessionCache.expiresAt > Date.now()) return sessionCache;
  const response = await fetchWithPolicy(
    'https://www.bing.com/translator',
    { method: 'GET', headers: { Accept: 'text/html' } },
    input.signal,
    Math.min(input.timeoutMs, 10_000),
    1,
  );
  sessionCache = parseSession(await response.text());
  return sessionCache;
}

export class BingWebProvider implements TranslationProvider {
  readonly id = 'bing' as const;
  readonly name = 'Bing Web';
  readonly model = 'Bing Translator web endpoint';
  readonly glossaryMode = 'protected-terms' as const;

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const source = LANGUAGE_MAP[input.sourceLanguage] ?? input.sourceLanguage;
    const target = LANGUAGE_MAP[input.targetLanguage] ?? input.targetLanguage;
    const output: string[] = [];
    let detectedLanguage: string | undefined;

    for (const chunk of splitTextByUtf8Bytes(input.text, 4_000)) {
      let session = await getSession(input);
      let parsed: BingResponseRow[] | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = new URL('https://www.bing.com/ttranslatev3');
        url.searchParams.set('isVertical', '1');
        url.searchParams.set('IG', session.ig);
        url.searchParams.set('IID', `${session.iid}.${attempt + 1}`);
        const body = new URLSearchParams({
          fromLang: source,
          to: target,
          text: chunk,
          key: session.key,
          token: session.token,
          tryFetchingGenderDebiasedTranslations: 'true',
        });
        const response = await fetchWithPolicy(
          url.toString(),
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              Referer: 'https://www.bing.com/translator',
            },
            body: body.toString(),
          },
          input.signal,
          Math.min(input.timeoutMs, 10_000),
          1,
        );
        const data = await readJsonResponse<unknown>(response, this.name);
        if (Array.isArray(data)) {
          parsed = data as BingResponseRow[];
          break;
        }
        sessionCache = null;
        session = await getSession(input, true);
      }
      const row = parsed?.[0];
      const value = row?.translations?.[0]?.text?.trim();
      if (!value) throw new TranslationError('EMPTY_RESULT', 'Bing Web returned an empty translation', true);
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
