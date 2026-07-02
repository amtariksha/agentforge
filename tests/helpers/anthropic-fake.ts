/**
 * Builders for fake Anthropic responses, errors, and stream objects.
 *
 * Errors are constructed as real `@anthropic-ai/sdk` error subclasses so the
 * production `isRetryableLlmError` classifier (which uses `instanceof`) is
 * exercised for real, not stubbed.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

const DEFAULT_USAGE: FakeUsage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function usageWith(partial?: Partial<FakeUsage>): FakeUsage {
  return { ...DEFAULT_USAGE, ...partial };
}

/** A terminal text-only assistant message (`stop_reason: 'end_turn'`). */
export function textResponse(
  text: string,
  usage?: Partial<FakeUsage>,
  stopReason: string = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageWith(usage),
  } as unknown as Anthropic.Message;
}

/** An assistant message that invokes a tool (`stop_reason: 'tool_use'`). */
export function toolUseResponse(
  name: string,
  input: Record<string, unknown>,
  opts: { id?: string; text?: string; usage?: Partial<FakeUsage> } = {},
): Anthropic.Message {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text, citations: null });
  content.push({ type: 'tool_use', id: opts.id ?? 'toolu_test', name, input });
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: usageWith(opts.usage),
  } as unknown as Anthropic.Message;
}

/** Construct a real SDK error subclass for the given HTTP status. */
export function apiError(status: number, type: string): InstanceType<typeof Anthropic.APIError> {
  const body = { type: 'error', error: { type, message: `${type} (${status})` } };
  const msg = `${status} ${type}`;
  const headers = {};
  switch (status) {
    case 400: return new Anthropic.BadRequestError(400, body, msg, headers);
    case 401: return new Anthropic.AuthenticationError(401, body, msg, headers);
    case 403: return new Anthropic.PermissionDeniedError(403, body, msg, headers);
    case 404: return new Anthropic.NotFoundError(404, body, msg, headers);
    case 422: return new Anthropic.UnprocessableEntityError(422, body, msg, headers);
    case 429: return new Anthropic.RateLimitError(429, body, msg, headers);
    default:  return new Anthropic.InternalServerError(status, body, msg, headers);
  }
}

export function connectionError(message = 'Connection error.'): InstanceType<typeof Anthropic.APIConnectionError> {
  return new Anthropic.APIConnectionError({ message });
}

export function timeoutError(): InstanceType<typeof Anthropic.APIConnectionTimeoutError> {
  return new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' });
}

export interface FakeStreamOpts {
  deltas?: string[];
  finalMessage?: Anthropic.Message;
  error?: unknown;
}

/**
 * Fake of the object returned by `anthropic.messages.stream(...)`.
 * `.on('text', cb)` fires each delta; `.finalMessage()` resolves the message
 * or rejects with `error` (used to simulate a mid-stream failure after deltas).
 */
export function fakeStream(opts: FakeStreamOpts) {
  const deltas = opts.deltas ?? [];
  return {
    on(event: string, cb: (delta: string) => void) {
      if (event === 'text') for (const d of deltas) cb(d);
      return this;
    },
    async finalMessage(): Promise<Anthropic.Message> {
      if (opts.error) throw opts.error;
      return opts.finalMessage ?? textResponse('');
    },
  };
}
