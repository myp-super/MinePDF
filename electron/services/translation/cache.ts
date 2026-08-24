import { createHash } from 'crypto';
import type { TranslationProviderId, TranslationResult } from '../../../src/shared/types';

export interface TranslationCacheReader {
  getTranslationCache(cacheKey: string): TranslationResult | null;
}

export function buildTranslationCacheKey(input: {
  pdfId: number;
  page: number;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: TranslationProviderId;
  model: string;
  glossaryVersion: string;
  context?: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function readTranslationCache(
  cache: TranslationCacheReader,
  cacheKey: string,
  requestId: string,
): TranslationResult | null {
  const hit = cache.getTranslationCache(cacheKey);
  return hit ? { ...hit, requestId, cached: true } : null;
}
