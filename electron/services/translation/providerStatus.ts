import type { TranslationProviderStatus, TranslationSettings } from '../../../src/shared/types';

export function buildProviderStatuses(input: {
  settings: TranslationSettings;
  secureStorageAvailable: boolean;
  niuTransCredential: boolean;
  openAICredential: boolean;
}): TranslationProviderStatus[] {
  const openAIConfigured =
    input.openAICredential &&
    Boolean(input.settings.openAICompatible.endpoint.trim()) &&
    Boolean(input.settings.openAICompatible.model.trim());
  return [
    {
      id: 'edge', name: 'Microsoft Edge', implemented: true, requiresCredential: false,
      freeWithoutKey: true, experimental: true, state: 'available',
      detail: 'Microsoft Edge browser translation endpoint; no API key required',
    },
    {
      id: 'transmart', name: 'Tencent TranSmart', implemented: true, requiresCredential: false,
      freeWithoutKey: true, experimental: true, state: 'available',
      detail: 'Tencent TranSmart web translation; optimized for fast English-Chinese fallback',
    },
    {
      id: 'youdao', name: 'Youdao Web', implemented: true, requiresCredential: false,
      freeWithoutKey: true, experimental: true, state: 'available',
      detail: 'Youdao public web translation endpoint; no API key required',
    },
    {
      id: 'mymemory', name: 'MyMemory', implemented: true, requiresCredential: false,
      freeWithoutKey: true, state: 'available',
      detail: 'Free public API; no API key required; daily usage limits apply',
    },
    {
      id: 'google', name: 'Google Web', implemented: true, requiresCredential: false,
      freeWithoutKey: true, experimental: true, state: 'available',
      detail: 'Unofficial web endpoint; may be rate limited, blocked or changed without notice',
    },
    {
      id: 'bing', name: 'Bing Web', implemented: true, requiresCredential: false,
      freeWithoutKey: true, experimental: true, state: 'available',
      detail: 'Unofficial Bing Translator web endpoint; no API key required',
    },
    {
      id: 'niutrans', name: 'NiuTrans', implemented: true, requiresCredential: true,
      state: !input.secureStorageAvailable ? 'error' : input.niuTransCredential ? 'configured' : 'not-configured',
      detail: !input.secureStorageAvailable ? 'Secure credential storage unavailable' : input.niuTransCredential ? 'API key saved locally' : 'API key required',
    },
    {
      id: 'openai-compatible', name: input.settings.openAICompatible.name || 'OpenAI Compatible',
      implemented: true, requiresCredential: true,
      state: !input.secureStorageAvailable ? 'error' : openAIConfigured ? 'configured' : 'not-configured',
      detail: !input.secureStorageAvailable ? 'Secure credential storage unavailable' : openAIConfigured ? 'Endpoint, model and API key configured' : 'Endpoint, model and API key required',
    },
    ...(['deepl', 'qwen', 'custom'] as const).map((id) => ({
      id,
      name: id === 'deepl' ? 'DeepL' : id === 'qwen' ? 'Qwen / Qwen-MT' : 'Custom Provider',
      implemented: false,
      requiresCredential: true,
      state: 'unavailable' as const,
      detail: 'Adapter reserved; no production API implementation in this release',
    })),
  ];
}
