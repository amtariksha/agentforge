import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiError, connectionError, timeoutError, textResponse, fakeStream } from '../helpers/anthropic-fake.js';

// Hoisted mocks shared with the module factories.
const { streamMock, createMock, ctorOpts, warnSpy, oaiCreateMock, oaiCtorOpts } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  createMock: vi.fn(),
  ctorOpts: [] as unknown[],
  warnSpy: vi.fn(),
  oaiCreateMock: vi.fn(),
  oaiCtorOpts: [] as unknown[],
}));

// Mock the Anthropic SDK: replace the client constructor but keep the REAL error
// classes as statics so `instanceof` classification is exercised for real.
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  const Real = actual.default as unknown as Record<string, unknown>;
  class MockAnthropic {
    messages = { stream: streamMock, create: createMock };
    constructor(opts?: unknown) { ctorOpts.push(opts); }
  }
  for (const key of Object.getOwnPropertyNames(Real)) {
    if (['length', 'name', 'prototype'].includes(key)) continue;
    Object.defineProperty(MockAnthropic, key, Object.getOwnPropertyDescriptor(Real, key)!);
  }
  return { ...actual, default: MockAnthropic };
});

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  const Real = actual.default as unknown as Record<string, unknown>;
  class MockOpenAI {
    chat = { completions: { create: oaiCreateMock } };
    constructor(opts?: unknown) { oaiCtorOpts.push(opts); }
  }
  for (const key of Object.getOwnPropertyNames(Real)) {
    if (['length', 'name', 'prototype'].includes(key)) continue;
    Object.defineProperty(MockOpenAI, key, Object.getOwnPropertyDescriptor(Real, key)!);
  }
  return { ...actual, default: MockOpenAI };
});

vi.mock('../../src/shared/utils/logger.js', () => {
  const l = { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => l };
  return { createChildLogger: () => l, logger: l };
});

import { streamLlm, callLlm, isRetryableLlmError } from '../../src/orchestrator/llm-provider.js';
import type { StreamArgs } from '../../src/orchestrator/llm-provider.js';

function streamArgs(overrides: Partial<StreamArgs> = {}): StreamArgs {
  return {
    model: 'claude-sonnet-4-6',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    temperature: 0.1,
    maxTokens: 256,
    onTextDelta: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  streamMock.mockReset();
  createMock.mockReset();
  oaiCreateMock.mockReset();
  warnSpy.mockReset();
});

describe('isRetryableLlmError', () => {
  it('treats 429, 5xx (incl. 529), and network/timeout as retryable', () => {
    expect(isRetryableLlmError(apiError(429, 'rate_limit_error'))).toBe(true);
    expect(isRetryableLlmError(apiError(529, 'overloaded_error'))).toBe(true);
    expect(isRetryableLlmError(apiError(500, 'api_error'))).toBe(true);
    expect(isRetryableLlmError(apiError(503, 'api_error'))).toBe(true);
    expect(isRetryableLlmError(connectionError())).toBe(true);
    expect(isRetryableLlmError(timeoutError())).toBe(true);
  });

  it('treats 4xx client errors and plain errors as non-retryable', () => {
    expect(isRetryableLlmError(apiError(400, 'invalid_request_error'))).toBe(false);
    expect(isRetryableLlmError(apiError(401, 'authentication_error'))).toBe(false);
    expect(isRetryableLlmError(apiError(403, 'permission_error'))).toBe(false);
    expect(isRetryableLlmError(apiError(404, 'not_found_error'))).toBe(false);
    expect(isRetryableLlmError(apiError(422, 'invalid_request_error'))).toBe(false);
    expect(isRetryableLlmError(new Error('boom'))).toBe(false);
  });
});

describe('streamLlm fallback (single hop, same-provider)', () => {
  for (const [label, err] of [
    ['429 rate_limit', apiError(429, 'rate_limit_error')],
    ['529 overloaded', apiError(529, 'overloaded_error')],
    ['500 api_error', apiError(500, 'api_error')],
    ['network error', connectionError()],
    ['request timeout', timeoutError()],
  ] as const) {
    it(`falls back once on ${label} with zero deltas`, async () => {
      streamMock
        .mockReturnValueOnce(fakeStream({ deltas: [], error: err }))
        .mockReturnValueOnce(fakeStream({ deltas: ['hi'], finalMessage: textResponse('hi', { input_tokens: 50, output_tokens: 5 }) }));

      const res = await streamLlm(streamArgs());

      expect(streamMock).toHaveBeenCalledTimes(2);        // A1
      expect(res.servedBy).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' }); // A3
      expect(res.usage.input_tokens).toBe(50);            // tokens from the served (fallback) attempt only
      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'llm_fallback' }), 'llm_fallback'); // A5
    });
  }

  it('does NOT fall back on a 400 (non-retryable) and rethrows', async () => {
    streamMock.mockReturnValueOnce(fakeStream({ deltas: [], error: apiError(400, 'invalid_request_error') }));
    await expect(streamLlm(streamArgs())).rejects.toBeInstanceOf(Error);
    expect(streamMock).toHaveBeenCalledTimes(1);          // A6 — no fallback
  });

  it('does NOT fall back once a text delta has been emitted (A7)', async () => {
    const onTextDelta = vi.fn();
    streamMock.mockReturnValueOnce(fakeStream({ deltas: ['partial'], error: apiError(529, 'overloaded_error') }));
    await expect(streamLlm(streamArgs({ onTextDelta }))).rejects.toBeInstanceOf(Error);
    expect(onTextDelta).toHaveBeenCalledWith('partial');
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it('propagates when both primary and fallback fail', async () => {
    streamMock
      .mockReturnValueOnce(fakeStream({ deltas: [], error: apiError(529, 'overloaded_error') }))
      .mockReturnValueOnce(fakeStream({ deltas: [], error: apiError(529, 'overloaded_error') }));
    await expect(streamLlm(streamArgs())).rejects.toBeInstanceOf(Error);
    expect(streamMock).toHaveBeenCalledTimes(2);          // primary + one fallback, nothing more
  });
});

describe('callLlm fallback (non-streaming)', () => {
  it('falls back once on 429 and attributes usage to the served model', async () => {
    createMock
      .mockRejectedValueOnce(apiError(429, 'rate_limit_error'))
      .mockResolvedValueOnce(textResponse('ok', { input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 6 }));

    const res = await callLlm({ model: 'claude-sonnet-4-6', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [], temperature: 0.7, maxTokens: 512 });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(res.servedBy).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    expect(res.usage).toMatchObject({ input_tokens: 30, output_tokens: 4, cache_read_tokens: 10, cache_write_tokens: 6 });
  });

  it('does NOT fall back on 401', async () => {
    createMock.mockRejectedValueOnce(apiError(401, 'authentication_error'));
    await expect(callLlm({ model: 'claude-sonnet-4-6', system: 's', messages: [], tools: [], temperature: 0.7, maxTokens: 100 })).rejects.toBeInstanceOf(Error);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe('client construction', () => {
  it('constructs the Anthropic client with maxRetries and a timeout', () => {
    // llm-provider constructs its client once at module load.
    expect(ctorOpts[0]).toMatchObject({ maxRetries: 2, timeout: 60_000 });
  });
});

describe('cross-provider fallback (anthropic → gemini)', () => {
  it('constructs the gemini client for fallback and serves from it on primary 429', async () => {
    const prevFallbackProvider = process.env.LLM_FALLBACK_PROVIDER;
    const prevFallbackModel = process.env.LLM_FALLBACK_MODEL;
    process.env.LLM_FALLBACK_PROVIDER = 'gemini';
    process.env.LLM_FALLBACK_MODEL = 'gemini-2.0-flash';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    oaiCtorOpts.length = 0;
    vi.resetModules();

    // Gemini returns a minimal one-chunk async stream.
    oaiCreateMock.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'from-gemini' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
      },
    });
    streamMock.mockReturnValueOnce(fakeStream({ deltas: [], error: apiError(529, 'overloaded_error') }));

    const mod = await import('../../src/orchestrator/llm-provider.js');
    const res = await mod.streamLlm(streamArgs());

    expect(oaiCtorOpts.length).toBeGreaterThan(0);        // gemini client was constructed even though primary is anthropic
    expect(oaiCreateMock).toHaveBeenCalledTimes(1);        // fallback dispatched to gemini
    expect(res.servedBy.provider).toBe('gemini');

    process.env.LLM_FALLBACK_PROVIDER = prevFallbackProvider;
    process.env.LLM_FALLBACK_MODEL = prevFallbackModel;
    vi.resetModules();
  });
});
