import type { TranslationErrorCode, TranslationErrorPayload } from '../../../src/shared/types';

export class TranslationError extends Error {
  constructor(
    public readonly code: TranslationErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TranslationError';
  }

  toPayload(): TranslationErrorPayload {
    return { code: this.code, message: this.message, retryable: this.retryable, status: this.status };
  }
}

export function normalizeTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new TranslationError('ABORTED', 'Translation cancelled', false);
  }
  return new TranslationError(
    'NETWORK',
    error instanceof Error ? error.message : 'Translation network request failed',
    true,
  );
}

export function encodeTranslationError(error: unknown): Error {
  const normalized = normalizeTranslationError(error);
  return new Error(`TRANSLATION_ERROR:${JSON.stringify(normalized.toPayload())}`);
}
