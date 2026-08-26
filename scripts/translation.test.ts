import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTranslationCacheKey, readTranslationCache } from '../electron/services/translation/cache';
import { TranslationError } from '../electron/services/translation/errors';
import { protectGlossaryTerms } from '../electron/services/translation/glossary';
import { fetchWithPolicy } from '../electron/services/translation/http';
import { OpenAICompatibleProvider } from '../electron/services/translation/providers/openAICompatible';
import { NiuTransProvider } from '../electron/services/translation/providers/niuTrans';
import { GoogleWebProvider } from '../electron/services/translation/providers/googleWeb';
import { MyMemoryProvider } from '../electron/services/translation/providers/myMemory';
import { BingWebProvider } from '../electron/services/translation/providers/bingWeb';
import { EdgeWebProvider } from '../electron/services/translation/providers/edgeWeb';
import { TransmartWebProvider } from '../electron/services/translation/providers/transmartWeb';
import { YoudaoWebProvider } from '../electron/services/translation/providers/youdaoWeb';
import { firstSuccessfulHedged } from '../electron/services/translation/scheduler';
import { assertUsableTranslation } from '../electron/services/translation/quality';
import { splitTextByUtf8Bytes } from '../electron/services/translation/providers/textChunks';
import { buildAcademicTranslationPrompt } from '../electron/services/translation/prompt';
import { buildProviderStatuses } from '../electron/services/translation/providerStatus';
import type { ProviderTranslateInput } from '../electron/services/translation/types';
import {
  formatTranslationNote,
  isCurrentTranslationRequest,
  parseTranslationError,
  nextTranslationNoteNumber,
  splitNoteMarkdown,
  translationSelectionId,
} from '../src/lib/translation';
import { parseNoteReferenceUrl, preserveNoteReferenceUrl } from '../src/lib/noteReference';
import { formulaMarkdown, normalizeLocalFormulaLatex, parseFormulaRecognition } from '../src/lib/formulaRecognition';
import { normalizeShortcutCode, sanitizeShortcutKeys, shortcutLabel, shortcutMatches } from '../src/lib/shortcut';
import type { TranslationResult, TranslationSettings } from '../src/shared/types';

const defaultSettings: TranslationSettings = {
  enabled: true,
  shortcutEnabled: false,
  shortcutKeys: ['Alt', 'KeyT'],
  provider: 'transmart',
  defaultProviderRevision: 5,
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  contextMode: 'auto',
  cacheEnabled: true,
  timeoutMs: 20_000,
  maxSelectedCharacters: 500_000,
  longSelectionCharacters: 3_000,
  openAICompatible: { name: 'Local Model', endpoint: 'https://example.test/v1', model: 'academic-mt' },
  formulaEngine: 'local',
  formulaModelSources: [],
};

test('translation shortcut supports arbitrary one-key and two-key chords', () => {
  assert.equal(normalizeShortcutCode('ControlRight'), 'Control');
  assert.deepEqual(sanitizeShortcutKeys(['ControlLeft', 'KeyT', 'KeyY']), ['Control', 'KeyT']);
  assert.equal(shortcutLabel(['Control', 'KeyT']), 'Ctrl + T');
  assert.equal(shortcutLabel(['F8']), 'F8');
  assert.equal(shortcutMatches(new Set(['F8']), ['F8']), true);
  assert.equal(shortcutMatches(new Set(['KeyA', 'KeyB']), ['KeyA', 'KeyB']), true);
  assert.equal(shortcutMatches(new Set(['Control', 'KeyT', 'Shift']), ['Control', 'KeyT']), false);
});

test('hedged provider scheduling starts a backup early and keeps the first success', async () => {
  const started: string[] = [];
  const winner = await firstSuccessfulHedged([
    {
      id: 'slow',
      run: (signal) => new Promise<string>((resolve, reject) => {
        started.push('slow');
        const timer = setTimeout(() => resolve('slow result'), 80);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    },
    {
      id: 'fast',
      run: async () => {
        started.push('fast');
        return 'fast result';
      },
    },
  ], new AbortController().signal, 5);
  assert.deepEqual(winner, { id: 'fast', value: 'fast result' });
  assert.deepEqual(started, ['slow', 'fast']);
});

test('translation quality gate rejects unchanged text, error pages and truncated output', () => {
  assert.doesNotThrow(() => assertUsableTranslation('The method improves robustness.', '该方法提高了鲁棒性。', 'Test'));
  assert.throws(() => assertUsableTranslation('The method improves robustness.', 'The method improves robustness.', 'Test'), TranslationError);
  assert.throws(() => assertUsableTranslation('A'.repeat(200), 'x', 'Test'), TranslationError);
  assert.throws(() => assertUsableTranslation('Academic text', '<html>captcha</html>', 'Test'), TranslationError);
});

function providerInput(signal = new AbortController().signal): ProviderTranslateInput {
  return {
    requestId: 'req-a',
    text: 'The proposed method improves robustness.',
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    context: 'The method is evaluated on three datasets.',
    glossary: [{
      id: 1, term: 'robustness', translation: '鲁棒性', domain: 'control', note: '', enabled: true,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }],
    signal,
    timeoutMs: 100,
  };
}

test('academic prompt limits output to selected text and injects matching glossary', () => {
  const prompt = buildAcademicTranslationPrompt(providerInput());
  assert.match(prompt.system, /robustness => 鲁棒性/);
  assert.match(prompt.system, /Do not translate or include it/);
  assert.match(prompt.user, /<context>/);
  assert.match(prompt.user, /<selected>/);
});

test('plain translation providers preserve user glossary terms through protected placeholders', () => {
  const glossary = providerInput().glossary;
  const protectedText = protectGlossaryTerms('Robustness and ROBUSTNESS matter.', glossary);
  assert.ok(!/robustness/i.test(protectedText.text));
  const providerOutput = protectedText.text.replace(/MINEPDFGLOSSARYTOKEN/g, 'M I N E P D F G L O S S A R Y T O K E N ');
  assert.equal(protectedText.restore(providerOutput), '鲁棒性 and 鲁棒性 matter.');
});

test('cache key varies with context and glossary version', () => {
  const base = {
    pdfId: 7, page: 2, text: 'It improves performance.', sourceLanguage: 'en', targetLanguage: 'zh-CN',
    provider: 'openai-compatible' as const, model: 'mt', glossaryVersion: 'v1',
  };
  assert.notEqual(buildTranslationCacheKey({ ...base, context: 'model A' }), buildTranslationCacheKey({ ...base, context: 'model B' }));
  assert.notEqual(buildTranslationCacheKey(base), buildTranslationCacheKey({ ...base, glossaryVersion: 'v2' }));
});

test('cache hit is rebound to the current request id; miss remains null', () => {
  const result: TranslationResult = {
    requestId: '', translatedText: '译文', provider: 'niutrans', providerName: 'NiuTrans',
    providerModel: 'NiuTrans API', sourceLanguage: 'en', targetLanguage: 'zh-CN', cached: true,
  };
  assert.equal(readTranslationCache({ getTranslationCache: () => null }, 'missing', 'req-1'), null);
  assert.deepEqual(readTranslationCache({ getTranslationCache: () => result }, 'hit', 'req-2'), { ...result, requestId: 'req-2', cached: true });
});

test('OpenAI-compatible provider uses Chat Completions and reads usage', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = '';
  globalThis.fetch = (async (_url, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: '该方法提高了鲁棒性。' } }], usage: { prompt_tokens: 42, completion_tokens: 11 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider('Test', 'https://example.test/v1', 'secret-not-logged', 'academic-mt');
    const result = await provider.translate(providerInput());
    assert.equal(result.translatedText, '该方法提高了鲁棒性。');
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 11 });
    const parsed = JSON.parse(requestBody) as { model: string; messages: Array<{ content: string }> };
    assert.equal(parsed.model, 'academic-mt');
    assert.match(parsed.messages[0].content, /robustness => 鲁棒性/);
    assert.ok(!requestBody.includes('secret-not-logged'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NiuTrans provider sends short, long and multiline selections through the official API shape', async () => {
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body ?? '');
    sent.push(new URLSearchParams(body).get('src_text') ?? '');
    return new Response(JSON.stringify({ tgt_text: '真实接口响应结构' }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new NiuTransProvider('secret-not-logged');
    for (const text of ['Short sentence.', 'A long academic sentence '.repeat(80), 'First line.\nSecond line.']) {
      const input = providerInput();
      input.text = text;
      assert.equal((await provider.translate(input)).translatedText, '真实接口响应结构');
    }
    assert.deepEqual(sent, ['Short sentence.', 'A long academic sentence '.repeat(80), 'First line.\nSecond line.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('free providers translate without credentials and parse their real response shapes', async (t) => {
  const originalFetch = globalThis.fetch;
  try {
    await t.test('MyMemory', async () => {
      let requested = '';
      globalThis.fetch = (async (url) => {
        requested = String(url);
        return new Response(JSON.stringify({
          responseData: { translatedText: '&#35813;&#26041;&#27861;&amp;&#32467;&#26524;', detectedLanguage: 'en' },
          responseStatus: 200,
          quotaFinished: false,
        }), { status: 200 });
      }) as typeof fetch;
      const input = providerInput();
      input.sourceLanguage = 'auto';
      const result = await new MyMemoryProvider().translate(input);
      assert.equal(result.translatedText, '该方法&结果');
      assert.equal(result.detectedLanguage, 'en');
      assert.match(requested, /langpair=Autodetect%7Czh-CN/);
    });

    await t.test('Google Web multisegment', async () => {
      let requestUrl = '';
      globalThis.fetch = (async (url) => {
        requestUrl = String(url);
        return new Response(JSON.stringify([[['该方法', 'The method'], ['提高鲁棒性。', ' improves robustness.']], null, 'en']), { status: 200 });
      }) as typeof fetch;
      const result = await new GoogleWebProvider().translate(providerInput());
      assert.equal(result.translatedText, '该方法提高鲁棒性。');
      assert.equal(result.detectedLanguage, 'en');
      assert.equal(new URL(requestUrl).searchParams.get('client'), 'gtx');
    });

    await t.test('Bing Web session and translation', async () => {
      let calls = 0;
      globalThis.fetch = (async (_url, init) => {
        calls++;
        if (!init || init.method === 'GET') {
          return new Response('IG:"ABCDEF0123" data-iid="translator.5023"; var params_AbusePreventionHelper = [123456,"token-value",3600000];', { status: 200 });
        }
        const body = new URLSearchParams(String(init.body));
        assert.equal(body.get('key'), '123456');
        assert.equal(body.get('token'), 'token-value');
        return new Response(JSON.stringify([{ translations: [{ text: '该方法提高了鲁棒性。' }], detectedLanguage: { language: 'en' } }]), { status: 200 });
      }) as typeof fetch;
      const result = await new BingWebProvider().translate(providerInput());
      assert.equal(result.translatedText, '该方法提高了鲁棒性。');
      assert.equal(result.detectedLanguage, 'en');
      assert.equal(calls, 2);
    });

    await t.test('Microsoft Edge browser translation', async () => {
      let requestUrl = '';
      let requestBody = '';
      globalThis.fetch = (async (url, init) => {
        requestUrl = String(url);
        requestBody = String(init?.body ?? '');
        return new Response(JSON.stringify([{
          translations: [{ text: '该方法提高了鲁棒性。', to: 'zh-Hans' }],
          detectedLanguage: { language: 'en' },
        }]), { status: 200 });
      }) as typeof fetch;
      const input = providerInput();
      input.sourceLanguage = 'auto';
      const result = await new EdgeWebProvider().translate(input);
      assert.equal(result.translatedText, '该方法提高了鲁棒性。');
      assert.equal(new URL(requestUrl).searchParams.get('to'), 'zh-Hans');
      assert.equal(new URL(requestUrl).searchParams.has('from'), false);
      assert.deepEqual(JSON.parse(requestBody), [input.text]);
    });

    await t.test('Tencent TranSmart', async () => {
      let requestBody = '';
      globalThis.fetch = (async (_url, init) => {
        requestBody = String(init?.body ?? '');
        return new Response(JSON.stringify({
          header: { ret_code: 'succ' },
          auto_translation: ['该方法提高了鲁棒性。'],
          src_lang: 'en',
        }), { status: 200 });
      }) as typeof fetch;
      const result = await new TransmartWebProvider().translate(providerInput());
      assert.equal(result.translatedText, '该方法提高了鲁棒性。');
      assert.equal(result.detectedLanguage, 'en');
      const parsed = JSON.parse(requestBody) as { source: { text_list: string[] }; target: { lang: string } };
      assert.deepEqual(parsed.source.text_list, [providerInput().text]);
      assert.equal(parsed.target.lang, 'zh');
    });

    await t.test('Youdao Web', async () => {
      globalThis.fetch = (async (_url, init) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        assert.equal(body.get('to'), 'zh-CHS');
        return new Response(JSON.stringify({
          errorCode: '0',
          translation: ['该方法提高了鲁棒性。'],
          l: 'en2zh-CHS',
        }), { status: 200 });
      }) as typeof fetch;
      const result = await new YoudaoWebProvider().translate(providerInput());
      assert.equal(result.translatedText, '该方法提高了鲁棒性。');
      assert.equal(result.detectedLanguage, 'en');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('free providers map quotas and malformed responses to typed errors', async (t) => {
  const originalFetch = globalThis.fetch;
  try {
    await t.test('MyMemory quota', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ responseStatus: 429, responseDetails: 'Daily quota exceeded', quotaFinished: true }), { status: 200 })) as typeof fetch;
      await assert.rejects(new MyMemoryProvider().translate(providerInput()), (error: unknown) => error instanceof TranslationError && error.code === 'RATE_LIMITED');
    });
    await t.test('Google malformed response', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ changed: true }), { status: 200 })) as typeof fetch;
      await assert.rejects(new GoogleWebProvider().translate(providerInput()), (error: unknown) => error instanceof TranslationError && error.code === 'PROVIDER_ERROR');
    });
    await t.test('HTTP 200 empty bodies become retryable provider errors', async () => {
      const providers = [
        new EdgeWebProvider(), new TransmartWebProvider(), new YoudaoWebProvider(),
        new GoogleWebProvider(), new MyMemoryProvider(), new BingWebProvider(),
      ];
      for (const provider of providers) {
        globalThis.fetch = (async (_url, init) => {
          if (provider.id === 'bing' && (!init || init.method === 'GET')) {
            return new Response('IG:"ABCDEF0123" data-iid="translator.5023"; var params_AbusePreventionHelper = [123456,"token-value",3600000];', { status: 200 });
          }
          return new Response('', { status: 200 });
        }) as typeof fetch;
        await assert.rejects(
          provider.translate(providerInput()),
          (error: unknown) => error instanceof TranslationError
            && error.code === 'PROVIDER_ERROR'
            && error.retryable
            && !error.message.includes('Unexpected end'),
          provider.name,
        );
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('free-provider chunking respects UTF-8 byte limits without losing text', () => {
  const text = `${'Academic translation sentence. '.repeat(20)}${'科研文本。'.repeat(40)}`;
  const chunks = splitTextByUtf8Bytes(text, 120);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 120));
});

test('long Google Web selections send every chunk and retain the final segment', async () => {
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (url) => {
    const chunk = new URL(String(url)).searchParams.get('q') ?? '';
    sent.push(chunk);
    return new Response(JSON.stringify([[[`译文分块${sent.length}`, chunk]], null, 'en']), { status: 200 });
  }) as typeof fetch;
  try {
    const input = providerInput();
    input.text = `${'Long academic selection. '.repeat(500)}FINAL_SEGMENT`;
    const result = await new GoogleWebProvider().translate(input);
    assert.ok(sent.length > 2);
    assert.equal(sent.join(''), input.text);
    assert.match(result.translatedText, new RegExp(`译文分块${sent.length}$`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider maps 401, 429 and empty output to typed errors', async (t) => {
  const originalFetch = globalThis.fetch;
  const provider = new OpenAICompatibleProvider('Test', 'https://example.test/v1', 'secret', 'mt');
  try {
    await t.test('401', async () => {
      globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
      await assert.rejects(provider.translate(providerInput()), (error: unknown) => error instanceof TranslationError && error.code === 'UNAUTHORIZED');
    });
    await t.test('429', async () => {
      globalThis.fetch = (async () => new Response('', { status: 429 })) as typeof fetch;
      const input = providerInput();
      input.timeoutMs = 10;
      await assert.rejects(provider.translate(input), (error: unknown) => error instanceof TranslationError && error.code === 'RATE_LIMITED');
    });
    await t.test('empty', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 })) as typeof fetch;
      await assert.rejects(provider.translate(providerInput()), (error: unknown) => error instanceof TranslationError && error.code === 'EMPTY_RESULT');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request policy reports timeout and caller cancellation', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })) as typeof fetch;
  try {
    await t.test('timeout', async () => {
      await assert.rejects(fetchWithPolicy('https://example.test', {}, new AbortController().signal, 5, 1), (error: unknown) => error instanceof TranslationError && error.code === 'TIMEOUT');
    });
    await t.test('abort', async () => {
      const controller = new AbortController();
      const pending = fetchWithPolicy('https://example.test', {}, controller.signal, 1_000, 1);
      controller.abort();
      await assert.rejects(pending, (error: unknown) => error instanceof TranslationError && error.code === 'ABORTED');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider statuses distinguish keyless, configured and reserved adapters', () => {
  const statuses = buildProviderStatuses({ settings: defaultSettings, secureStorageAvailable: true, niuTransCredential: false, openAICredential: true });
  assert.equal(statuses.find((row) => row.id === 'mymemory')?.state, 'available');
  assert.equal(statuses.find((row) => row.id === 'edge')?.freeWithoutKey, true);
  assert.equal(statuses.find((row) => row.id === 'transmart')?.freeWithoutKey, true);
  assert.equal(statuses.find((row) => row.id === 'youdao')?.freeWithoutKey, true);
  assert.equal(statuses.find((row) => row.id === 'mymemory')?.freeWithoutKey, true);
  assert.equal(statuses.find((row) => row.id === 'niutrans')?.state, 'not-configured');
  assert.equal(statuses.find((row) => row.id === 'openai-compatible')?.state, 'configured');
  assert.equal(statuses.find((row) => row.id === 'google')?.state, 'available');
  assert.equal(statuses.find((row) => row.id === 'google')?.experimental, true);
  assert.equal(statuses.find((row) => row.id === 'bing')?.freeWithoutKey, true);
  assert.equal(statuses.find((row) => row.id === 'deepl')?.implemented, false);
});

test('selection identity and request guard reject stale A -> B -> C results', () => {
  assert.notEqual(translationSelectionId(1, 1, 'A'), translationSelectionId(1, 1, 'B'));
  assert.equal(isCurrentTranslationRequest('req-c', 'req-a'), false);
  assert.equal(isCurrentTranslationRequest('req-c', 'req-c'), true);
  assert.equal(isCurrentTranslationRequest(null, 'req-c'), false);
});

test('translation errors decode and Add to Note preserves research provenance', () => {
  assert.deepEqual(
    parseTranslationError({ translationError: { code: 'RATE_LIMITED', message: 'Try another provider', retryable: true, status: 429 } }),
    { code: 'RATE_LIMITED', message: 'Try another provider', retryable: true, status: 429 },
  );
  const parsed = parseTranslationError(new Error('TRANSLATION_ERROR:{"code":"RATE_LIMITED","message":"Slow down","retryable":true,"status":429}'));
  assert.equal(parsed.code, 'RATE_LIMITED');
  const note = formatTranslationNote({
    original: 'The proposed method improves robustness.',
    translation: '该方法提高了鲁棒性。',
    paperTitle: 'Control Systems',
    page: 6,
    time: new Date('2026-08-22T10:30:00+08:00'),
    sequence: 3,
  });
  assert.equal(nextTranslationNoteNumber(''), 1);
  assert.equal(nextTranslationNoteNumber('## Translation\n\nold\n\n## Translation 4\n'), 5);
  assert.match(note, /^## Translation 3/m);
  assert.match(note, /<!-- minepdf:translation:start 3 -->/);
  assert.match(note, /<!-- minepdf:translation:end -->/);
  assert.match(note, /\*\*Original\*\*/);
  assert.match(note, /The proposed method improves robustness\./);
  assert.match(note, /\*\*Translation\*\*/);
  assert.match(note, /Control Systems · Page 6/);
  assert.match(note, /\*\*Time\*\*/);
});

test('translation note cards preserve surrounding Markdown and support legacy entries', () => {
  const card = formatTranslationNote({
    original: 'A compact original sentence.',
    translation: '一段简洁的译文。',
    paperTitle: 'Card Rendering',
    page: 2,
    time: new Date('2026-08-23T09:00:00+08:00'),
    sequence: 2,
  });
  const segments = splitNoteMarkdown(`# Reading notes\n\nBefore card.\n\n${card}\n## Discussion\n\nAfter card.`);
  assert.deepEqual(segments.map((segment) => segment.kind), ['markdown', 'translation', 'markdown']);
  assert.match(segments[0].markdown, /Before card/);
  assert.equal(segments[1].kind === 'translation' ? segments[1].sequence : 0, 2);
  assert.doesNotMatch(segments[1].markdown, /^## Translation/m);
  assert.match(segments[1].markdown, /A compact original sentence/);
  assert.match(segments[2].markdown, /## Discussion/);
  assert.match(segments[2].markdown, /After card/);
  assert.equal(nextTranslationNoteNumber(card), 3);

  const legacy = splitNoteMarkdown('Intro\n\n## Translation 4\n\n**Original**\n\nLegacy text\n\n**Translation**\n\n旧译文\n\n**Source**: Paper · Page 1\n\n**Time**: 2026/8/22 10:30:00\n\nThis paragraph must stay outside the card.');
  assert.deepEqual(legacy.map((segment) => segment.kind), ['markdown', 'translation', 'markdown']);
  assert.equal(legacy[1].kind === 'translation' ? legacy[1].sequence : 0, 4);
  assert.doesNotMatch(legacy[1].markdown, /must stay outside/);
  assert.match(legacy[2].markdown, /must stay outside/);

  const incomplete = splitNoteMarkdown('## Translation 8\n\nA user heading without MinePDF metadata.\n\nMore notes.');
  assert.deepEqual(incomplete, [{ kind: 'markdown', markdown: '## Translation 8\n\nA user heading without MinePDF metadata.\n\nMore notes.' }]);
});

test('MinePDF note-reference URLs survive Markdown safety filtering and reject unsafe variants', () => {
  assert.equal(parseNoteReferenceUrl('minepdf://ref/42'), 42);
  assert.equal(preserveNoteReferenceUrl('minepdf://ref/42'), 'minepdf://ref/42');
  assert.equal(parseNoteReferenceUrl('minepdf://ref/0'), null);
  assert.equal(parseNoteReferenceUrl('minepdf://other/42'), null);
  assert.equal(parseNoteReferenceUrl('javascript:alert(1)'), null);
});

test('formula recognition normalizes JSON, fenced LaTeX and Markdown delimiters', () => {
  assert.deepEqual(
    parseFormulaRecognition('{"latex":"\\\\frac{a}{b}","markdown":"ignored"}'),
    { latex: '\\frac{a}{b}', markdown: '$$\n\\frac{a}{b}\n$$' },
  );
  assert.deepEqual(
    parseFormulaRecognition('```latex\n\\[ x^2 + y^2 \\]\n```'),
    { latex: 'x^2 + y^2', markdown: '$$\nx^2 + y^2\n$$' },
  );
  assert.equal(formulaMarkdown('  E = mc^2  '), '$$\nE = mc^2\n$$');
});

test('local formula recognition normalizes spaced functions and legacy bold commands', () => {
  assert.equal(
    normalizeLocalFormulaLatex('\\tilde{ \\bf X}=s i g m o i d(\\frac{1}{\\bf E})\\odot\\bf X,'),
    '\\tilde{\\mathbf{X}}=\\operatorname{sigmoid}(\\frac{1}{\\mathbf{E}})\\odot\\mathbf{X},',
  );
});
