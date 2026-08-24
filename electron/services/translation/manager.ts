import type {
  TranslateRequest,
  TranslationProviderId,
  TranslationProviderStatus,
  TranslationResult,
} from '../../../src/shared/types';
import { repository } from '../../db/repository';
import { getSettings } from '../settings';
import { credentialStore } from './credentialStore';
import { buildTranslationCacheKey, readTranslationCache } from './cache';
import { normalizeTranslationError, TranslationError } from './errors';
import { NiuTransProvider } from './providers/niuTrans';
import { OpenAICompatibleProvider } from './providers/openAICompatible';
import { GoogleWebProvider } from './providers/googleWeb';
import { MyMemoryProvider } from './providers/myMemory';
import { BingWebProvider } from './providers/bingWeb';
import { EdgeWebProvider } from './providers/edgeWeb';
import { TransmartWebProvider } from './providers/transmartWeb';
import { YoudaoWebProvider } from './providers/youdaoWeb';
import type { TranslationProvider } from './types';
import { buildProviderStatuses } from './providerStatus';
import { firstSuccessfulHedged } from './scheduler';
import { assertUsableTranslation } from './quality';

const FREE_PROVIDER_IDS = ['transmart', 'edge', 'youdao', 'bing', 'google', 'mymemory'] as const;
type FreeProviderId = typeof FREE_PROVIDER_IDS[number];

function isFreeProviderId(id: TranslationProviderId): id is FreeProviderId {
  return (FREE_PROVIDER_IDS as readonly string[]).includes(id);
}

export class TranslationManager {
  private readonly active = new Map<string, AbortController>();
  private readonly unavailableUntil = new Map<FreeProviderId, number>();

  listProviders(): TranslationProviderStatus[] {
    const settings = getSettings();
    const secure = credentialStore.isAvailable();
    const niuConfigured = credentialStore.has('niutrans');
    return buildProviderStatuses({
      settings: settings.translation,
      secureStorageAvailable: secure,
      niuTransCredential: niuConfigured,
      openAICredential: credentialStore.has('openai-compatible'),
    });
  }

  cancel(requestId: string): boolean {
    const active = this.active.get(requestId);
    if (!active) return false;
    active.abort();
    this.active.delete(requestId);
    return true;
  }

  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  private provider(id: TranslationProviderId): TranslationProvider {
    const settings = getSettings().translation;
    if (id === 'edge') return new EdgeWebProvider();
    if (id === 'transmart') return new TransmartWebProvider();
    if (id === 'youdao') return new YoudaoWebProvider();
    if (id === 'mymemory') return new MyMemoryProvider();
    if (id === 'google') return new GoogleWebProvider();
    if (id === 'bing') return new BingWebProvider();
    if (id === 'niutrans') {
      const apiKey = credentialStore.get('niutrans');
      if (!apiKey) throw new TranslationError('NOT_CONFIGURED', 'NiuTrans API key is not configured', false);
      return new NiuTransProvider(apiKey);
    }
    if (id === 'openai-compatible') {
      const config = settings.openAICompatible;
      const apiKey = credentialStore.get('openai-compatible');
      if (!apiKey || !config.endpoint.trim() || !config.model.trim()) {
        throw new TranslationError('NOT_CONFIGURED', 'OpenAI-compatible endpoint, model and API key are required', false);
      }
      if (!/^https:\/\//i.test(config.endpoint.trim()) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(`${config.endpoint.trim()}/`)) {
        throw new TranslationError('INVALID_REQUEST', 'Provider endpoint must use HTTPS (HTTP is allowed only for localhost)', false);
      }
      return new OpenAICompatibleProvider(config.name.trim() || 'OpenAI Compatible', config.endpoint, apiKey, config.model);
    }
    throw new TranslationError('PROVIDER_UNAVAILABLE', `${id} is not implemented in this release`, false);
  }

  async translate(request: TranslateRequest): Promise<TranslationResult> {
    const settings = getSettings().translation;
    if (!settings.enabled) throw new TranslationError('PROVIDER_UNAVAILABLE', 'Translation is disabled in Settings', false);
    const text = request.text.trim();
    if (!request.requestId || !Number.isInteger(request.pdfId) || request.page < 1 || !text) {
      throw new TranslationError('INVALID_REQUEST', 'Translation request is incomplete', false);
    }
    if (text.length > settings.maxSelectedCharacters) {
      throw new TranslationError('TEXT_TOO_LONG', `Selected text exceeds ${settings.maxSelectedCharacters} characters`, false);
    }
    this.cancel(request.requestId);
    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    try {
      const providerId = request.provider ?? settings.provider;
      const provider = this.provider(providerId);
      const sourceLanguage = request.sourceLanguage ?? settings.sourceLanguage;
      const targetLanguage = request.targetLanguage ?? settings.targetLanguage;
      const glossary: [] = [];
      const glossaryVersion = 'none';
      const cacheKey = buildTranslationCacheKey({
        pdfId: request.pdfId, page: request.page, text, sourceLanguage, targetLanguage,
        provider: provider.id, model: provider.cacheIdentity ?? provider.model, glossaryVersion,
        context: settings.contextMode === 'auto' ? request.context : undefined,
      });
      if (settings.cacheEnabled) {
        const cached = readTranslationCache(repository, cacheKey, request.requestId);
        if (cached) return cached;
      }
      const protectedText = { text, restore: (value: string): string => value };
      const providerInput = {
        requestId: request.requestId,
        text: protectedText.text,
        sourceLanguage,
        targetLanguage,
        context: settings.contextMode === 'auto' ? request.context : undefined,
        glossary,
        signal: controller.signal,
        timeoutMs: isFreeProviderId(provider.id) ? Math.min(settings.timeoutMs, 7_000) : settings.timeoutMs,
      };
      let activeProvider = provider;
      let result: Awaited<ReturnType<TranslationProvider['translate']>> | null = null;
      if (isFreeProviderId(provider.id)) {
        const orderedIds = [provider.id, ...FREE_PROVIDER_IDS.filter((id) => id !== provider.id)];
        const healthyIds = orderedIds.filter((id) => (this.unavailableUntil.get(id) ?? 0) <= Date.now());
        const candidateIds = healthyIds.length ? healthyIds : orderedIds;
        if (settings.cacheEnabled) {
          for (const id of candidateIds) {
            const candidate = this.provider(id);
            const candidateKey = buildTranslationCacheKey({
              pdfId: request.pdfId, page: request.page, text, sourceLanguage, targetLanguage,
              provider: candidate.id, model: candidate.cacheIdentity ?? candidate.model, glossaryVersion,
              context: settings.contextMode === 'auto' ? request.context : undefined,
            });
            const cached = readTranslationCache(repository, candidateKey, request.requestId);
            if (cached) return cached;
          }
        }
        const candidates = candidateIds.map((id) => this.provider(id));
        const winner = await firstSuccessfulHedged(
          candidates.map((candidate) => ({
            id: candidate.id,
            run: async (signal: AbortSignal) => {
              try {
                const value = await candidate.translate({ ...providerInput, signal });
                assertUsableTranslation(text, value.translatedText, candidate.name);
                this.unavailableUntil.delete(candidate.id as FreeProviderId);
                return value;
              } catch (error) {
                const normalized = normalizeTranslationError(error);
                if (normalized.code !== 'ABORTED') {
                  const cooldown = normalized.code === 'RATE_LIMITED' ? 5 * 60_000 : 75_000;
                  this.unavailableUntil.set(candidate.id as FreeProviderId, Date.now() + cooldown);
                }
                throw error;
              }
            },
          })),
          controller.signal,
          900,
        );
        activeProvider = candidates.find((candidate) => candidate.id === winner.id) ?? provider;
        result = winner.value;
      } else {
        result = await provider.translate(providerInput);
      }
      if (!result) throw new TranslationError('EMPTY_RESULT', 'Provider returned no translation', true);
      result.translatedText = protectedText.restore(result.translatedText);
      const complete: TranslationResult = { ...result, requestId: request.requestId, cached: false };
      if (settings.cacheEnabled) {
        const resultCacheKey = activeProvider.id === provider.id
          ? cacheKey
          : buildTranslationCacheKey({
              pdfId: request.pdfId, page: request.page, text, sourceLanguage, targetLanguage,
              provider: activeProvider.id, model: activeProvider.cacheIdentity ?? activeProvider.model, glossaryVersion,
              context: settings.contextMode === 'auto' ? request.context : undefined,
            });
        repository.putTranslationCache(resultCacheKey, complete);
        if (resultCacheKey !== cacheKey) repository.putTranslationCache(cacheKey, complete);
      }
      return complete;
    } finally {
      if (this.active.get(request.requestId) === controller) this.active.delete(request.requestId);
    }
  }
}

export const translationManager = new TranslationManager();
