import type {
  GlossaryEntry,
  TranslationProviderId,
  TranslationResult,
} from '../../../src/shared/types';

export interface ProviderTranslateInput {
  requestId: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  context?: string;
  glossary: GlossaryEntry[];
  signal: AbortSignal;
  timeoutMs: number;
}

export interface TranslationProvider {
  readonly id: TranslationProviderId;
  readonly name: string;
  readonly model: string;
  readonly cacheIdentity?: string;
  readonly glossaryMode: 'prompt' | 'protected-terms';
  translate(input: ProviderTranslateInput): Promise<Omit<TranslationResult, 'requestId' | 'cached'>>;
}
