import type { TranslationResult } from '../../../../src/shared/types';
import { TranslationError } from '../errors';
import { fetchWithPolicy, readJsonResponse } from '../http';
import { buildAcademicTranslationPrompt } from '../prompt';
import type { ProviderTranslateInput, TranslationProvider } from '../types';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function completionUrl(endpoint: string): string {
  const clean = endpoint.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
}

export class OpenAICompatibleProvider implements TranslationProvider {
  readonly id = 'openai-compatible' as const;
  readonly cacheIdentity: string;
  readonly glossaryMode = 'prompt' as const;

  constructor(
    readonly name: string,
    private readonly endpoint: string,
    private readonly apiKey: string,
    readonly model: string,
  ) {
    this.cacheIdentity = `${completionUrl(endpoint)}|${model}`;
  }

  async translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>> {
    const prompt = buildAcademicTranslationPrompt(input);
    const response = await fetchWithPolicy(
      completionUrl(this.endpoint),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      },
      input.signal,
      input.timeoutMs,
    );
    const data = await readJsonResponse<ChatCompletionResponse>(response, this.name);
    const translatedText = data.choices?.[0]?.message?.content?.trim();
    if (!translatedText) throw new TranslationError('EMPTY_RESULT', 'Provider returned an empty translation', true);
    return {
      translatedText,
      provider: this.id,
      providerName: this.name,
      providerModel: this.model,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
    };
  }
}
