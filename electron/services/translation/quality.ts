import { TranslationError } from './errors';

function compact(value: string): string {
  return value.replace(/\s+/g, '').trim().toLocaleLowerCase();
}

/** Reject obvious challenge/error payloads and untranslated long selections. */
export function assertUsableTranslation(source: string, translated: string, providerName: string): void {
  const output = translated.trim();
  const suspiciousMessage = /(?:<html|captcha|too many requests|request blocked|access denied|访问出现异常|系统繁忙|服务异常)/i;
  const comparableSource = compact(source);
  const comparableOutput = compact(output);
  const unchangedSentence = comparableSource.length >= 18 && comparableSource === comparableOutput;
  const truncatedResult = source.length >= 160 && output.length < Math.max(4, Math.floor(source.length * 0.025));
  if (!output || suspiciousMessage.test(output) || unchangedSentence || truncatedResult) {
    throw new TranslationError('EMPTY_RESULT', `${providerName} returned an unusable translation`, true);
  }
}
