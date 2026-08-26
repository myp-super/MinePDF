import type { FormulaRecognitionRequest, FormulaRecognitionResult } from '../../src/shared/types';
import { parseFormulaRecognition } from '../../src/lib/formulaRecognition';
import { getSettings } from './settings';
import { credentialStore } from './translation/credentialStore';
import { TranslationError } from './translation/errors';
import { fetchWithPolicy, readJsonResponse } from './translation/http';

interface VisionChatResponse {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
}

function completionUrl(endpoint: string): string {
  const clean = endpoint.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
}

function messageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => part.text ?? '').join('\n').trim();
}

export async function recognizeFormula(input: FormulaRecognitionRequest): Promise<FormulaRecognitionResult> {
  const settings = getSettings().translation;
  const config = settings.openAICompatible;
  const apiKey = credentialStore.get('openai-compatible');
  if (!apiKey || !config.endpoint.trim() || !config.model.trim()) {
    throw new TranslationError(
      'NOT_CONFIGURED',
      'Formula recognition requires an OpenAI-compatible vision model, endpoint and API key. Configure it in Translation settings.',
      false,
    );
  }
  if (
    !input.requestId
    || !Number.isInteger(input.pdfId)
    || input.page < 1
    || !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(input.imageDataUrl)
  ) {
    throw new TranslationError('INVALID_REQUEST', 'Formula recognition request is incomplete', false);
  }
  if (input.imageDataUrl.length > 18_000_000) {
    throw new TranslationError('TEXT_TOO_LONG', 'The selected image is too large for formula recognition', false);
  }
  if (
    !/^https:\/\//i.test(config.endpoint.trim())
    && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(`${config.endpoint.trim()}/`)
  ) {
    throw new TranslationError('INVALID_REQUEST', 'Provider endpoint must use HTTPS (HTTP is allowed only for localhost)', false);
  }
  const response = await fetchWithPolicy(
    completionUrl(config.endpoint),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are an expert mathematical OCR engine. Read the formula in the image and return JSON only with two string fields: latex and markdown. Preserve every symbol, superscript, subscript, fraction, matrix, alignment, and line break. The latex field must contain raw LaTeX without surrounding delimiters. The markdown field must be a complete Markdown formula block using $$ delimiters. Do not explain anything.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Recognize the mathematical formula in this image.' },
              { type: 'image_url', image_url: { url: input.imageDataUrl, detail: 'high' } },
            ],
          },
        ],
      }),
    },
    new AbortController().signal,
    Math.min(Math.max(settings.timeoutMs, 8_000), 90_000),
    2,
  );
  const data = await readJsonResponse<VisionChatResponse>(response, config.name || 'OpenAI-compatible vision model');
  const parsed = parseFormulaRecognition(messageText(data.choices?.[0]?.message?.content));
  if (!parsed.latex) throw new TranslationError('EMPTY_RESULT', 'Formula recognition returned an empty result', true);
  return {
    requestId: input.requestId,
    latex: parsed.latex,
    markdown: parsed.markdown,
    providerName: config.name || 'OpenAI Compatible',
    providerModel: config.model,
  };
}
