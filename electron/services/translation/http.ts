import { TranslationError, normalizeTranslationError } from './errors';

function retryDelay(attempt: number): number {
  return 350 * 2 ** attempt;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new TranslationError('ABORTED', 'Translation cancelled', false));
      },
      { once: true },
    );
  });
}

export async function fetchWithPolicy(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  attempts = 3,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        throw new TranslationError('UNAUTHORIZED', 'API key was rejected by the provider', false, response.status);
      }
      if (response.status === 429) {
        throw new TranslationError('RATE_LIMITED', 'Provider rate limit reached', true, 429);
      }
      if (!response.ok) {
        throw new TranslationError(
          response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
          `Provider returned HTTP ${response.status}`,
          response.status >= 500,
          response.status,
        );
      }
      return response;
    } catch (error) {
      let normalized: TranslationError;
      if (signal.aborted) normalized = new TranslationError('ABORTED', 'Translation cancelled', false);
      else if (controller.signal.aborted) normalized = new TranslationError('TIMEOUT', 'Translation request timed out', true);
      else normalized = normalizeTranslationError(error);
      if (!normalized.retryable || attempt === attempts - 1) throw normalized;
      await wait(retryDelay(attempt), signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  throw new TranslationError('NETWORK', 'Translation request failed', true);
}

/**
 * Translation web endpoints occasionally return HTTP 200 with an empty body,
 * an HTML challenge page, or truncated JSON. Convert those parser failures to
 * a typed, retryable provider error so the free-provider fallback chain runs.
 */
export async function readJsonResponse<T>(response: Response, providerName: string): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    throw new TranslationError('PROVIDER_ERROR', `${providerName} returned an empty response`, true, response.status);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new TranslationError('PROVIDER_ERROR', `${providerName} returned an invalid response`, true, response.status);
  }
}
