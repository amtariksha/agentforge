/**
 * LLM provider abstraction for streaming + non-streaming tool-use cycles, with
 * a single primary→fallback hop.
 *
 * Two backends supported:
 *   • Anthropic (default) — uses @anthropic-ai/sdk.
 *   • Gemini — uses Gemini's OpenAI-compatible endpoint via the `openai` SDK
 *     pointed at https://generativelanguage.googleapis.com/v1beta/openai/.
 *
 * Selection: env LLM_PROVIDER (default 'anthropic'). Fallback: env
 * LLM_FALLBACK_PROVIDER (default 'anthropic') + LLM_FALLBACK_MODEL (default
 * 'claude-haiku-4-5'). On a retryable primary failure — after the SDK's own
 * retries exhaust — we make exactly ONE fallback hop. Streaming never falls back
 * once a text delta has reached the client (would duplicate tokens on the SSE
 * stream). The per-tenant `tenantConfig.ai.fallbackProvider` seam is reserved
 * for a future override; M1 uses env defaults.
 *
 * Output normalises on Anthropic's content blocks + a 4-field usage
 * (input/output/cache_write/cache_read) so the agent loop stays provider-
 * agnostic. `servedBy` records the provider+model that actually answered, so
 * usage rows and cost are attributed to the real (possibly fallback) model.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'llm-provider' });

export type ProviderName = 'anthropic' | 'gemini';

const PROVIDER = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() as ProviderName;
const FALLBACK_PROVIDER = (process.env.LLM_FALLBACK_PROVIDER ?? 'anthropic').toLowerCase() as ProviderName;
const FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL ?? 'claude-haiku-4-5';
const GEMINI_DEFAULT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 2,        // SDK retries 408/409/429/5xx/connection ⇒ 3 attempts total before our fallback hop
  timeout: 60_000,      // ms
});

// Construct the Gemini client whenever EITHER the primary or the fallback needs
// it, so a cross-provider (anthropic→gemini) fallback is actually possible.
const gemini = (PROVIDER === 'gemini' || FALLBACK_PROVIDER === 'gemini')
  ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      maxRetries: 2,
      timeout: 60_000,
    })
  : null;

export function activeProvider(): ProviderName {
  return PROVIDER;
}

/** A tool the agent has access to, in Anthropic-native shape. */
export interface NormalisedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface NormalisedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;  // Anthropic cache_creation_input_tokens
  cache_read_tokens: number;   // Anthropic cache_read_input_tokens
}

export interface StreamArgs {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: NormalisedTool[];
  temperature: number;
  maxTokens: number;
  onTextDelta: (delta: string) => void;
}

export interface CallArgs {
  model: string;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: NormalisedTool[];
  temperature: number;
  maxTokens: number;
}

export interface LlmResult {
  content: Anthropic.ContentBlock[];
  usage: NormalisedUsage;
  servedBy: { provider: ProviderName; model: string };
  stopReason: string | null;
}

export type StreamResult = LlmResult;
export type CallResult = LlmResult;

// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Retryable = worth a fallback hop: rate limits (429), server errors (5xx incl.
 * 529 overloaded), and network/timeout errors. Non-retryable = 4xx client
 * errors (400/401/403/404/413/422) — those propagate untouched.
 */
export function isRetryableLlmError(err: unknown): boolean {
  // APIConnectionError (network + timeout) is a subclass of APIError — check first.
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const s = err.status ?? 0;
    return s === 429 || s >= 500;
  }
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (err instanceof OpenAI.APIError) {
    const s = typeof err.status === 'number' ? err.status : 0;
    return s === 429 || s >= 500;
  }
  return false;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') return err.status;
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') return err.status;
  return undefined;
}

function typeOf(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) return 'connection_error';
  if (err instanceof Error) return err.name;
  return 'unknown';
}

// ─── Streaming entrypoint (with fallback) ─────────────────────────────────────

export async function streamLlm(args: StreamArgs): Promise<StreamResult> {
  let deltaEmitted = false;
  const guardedArgs: StreamArgs = {
    ...args,
    onTextDelta: (d) => { deltaEmitted = true; args.onTextDelta(d); },
  };

  try {
    return await dispatchStream(PROVIDER, args.model, guardedArgs);
  } catch (err) {
    // Never fall back mid-stream (would duplicate tokens on the SSE client),
    // nor on non-retryable errors.
    if (deltaEmitted || !isRetryableLlmError(err)) throw err;
    log.warn({
      event: 'llm_fallback',
      fromProvider: PROVIDER, fromModel: args.model,
      toProvider: FALLBACK_PROVIDER, toModel: FALLBACK_MODEL,
      status: statusOf(err), errorType: typeOf(err),
    }, 'llm_fallback');
    return await dispatchStream(FALLBACK_PROVIDER, FALLBACK_MODEL, guardedArgs);
  }
}

// ─── Non-streaming entrypoint (with fallback) ─────────────────────────────────

export async function callLlm(args: CallArgs): Promise<CallResult> {
  try {
    return await dispatchCall(PROVIDER, args.model, args);
  } catch (err) {
    if (!isRetryableLlmError(err)) throw err;
    log.warn({
      event: 'llm_fallback',
      fromProvider: PROVIDER, fromModel: args.model,
      toProvider: FALLBACK_PROVIDER, toModel: FALLBACK_MODEL,
      status: statusOf(err), errorType: typeOf(err),
    }, 'llm_fallback');
    return await dispatchCall(FALLBACK_PROVIDER, FALLBACK_MODEL, args);
  }
}

function dispatchStream(provider: ProviderName, model: string, args: StreamArgs): Promise<StreamResult> {
  const withModel = { ...args, model };
  return provider === 'gemini' ? streamGemini(withModel) : streamAnthropic(withModel);
}

function dispatchCall(provider: ProviderName, model: string, args: CallArgs): Promise<CallResult> {
  const withModel = { ...args, model };
  return provider === 'gemini' ? callGemini(withModel) : callAnthropic(withModel);
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

function anthropicUsage(usage: Anthropic.Usage): NormalisedUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

function toAnthropicTools(tools: NormalisedTool[]): Anthropic.Tool[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool['input_schema'],
  }));
}

async function streamAnthropic(args: StreamArgs): Promise<StreamResult> {
  const stream = anthropic.messages.stream({
    model: args.model,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    system: args.system,
    messages: args.messages,
    tools: toAnthropicTools(args.tools),
  });

  stream.on('text', (delta) => args.onTextDelta(delta));

  const response = await stream.finalMessage();
  return {
    content: response.content,
    usage: anthropicUsage(response.usage),
    servedBy: { provider: 'anthropic', model: args.model },
    stopReason: response.stop_reason,
  };
}

async function callAnthropic(args: CallArgs): Promise<CallResult> {
  const response = await anthropic.messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    system: args.system,
    messages: args.messages,
    tools: toAnthropicTools(args.tools),
  });
  return {
    content: response.content,
    usage: anthropicUsage(response.usage),
    servedBy: { provider: 'anthropic', model: args.model },
    stopReason: response.stop_reason,
  };
}

// ─── Gemini via OpenAI-compat ───────────────────────────────────────────────

function requireGemini(): OpenAI {
  if (!gemini) {
    throw new Error('Gemini client not initialised — set GEMINI_API_KEY and LLM_PROVIDER/LLM_FALLBACK_PROVIDER=gemini');
  }
  return gemini;
}

function toOaiTools(tools: NormalisedTool[]): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function oaiStopReason(finishReason: string | null): string | null {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'stop') return 'end_turn';
  return finishReason;
}

function buildContentBlocks(
  text: string,
  toolCalls: Iterable<{ id: string; name: string; argsText: string }>,
): Anthropic.ContentBlock[] {
  const content: Anthropic.ContentBlock[] = [];
  if (text) {
    content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  }
  for (const tc of toolCalls) {
    let parsedInput: unknown = {};
    try { parsedInput = tc.argsText ? JSON.parse(tc.argsText) : {}; } catch { parsedInput = { _raw: tc.argsText }; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput } as Anthropic.ToolUseBlock);
  }
  return content;
}

async function streamGemini(args: StreamArgs): Promise<StreamResult> {
  const client = requireGemini();
  const geminiModel = pickGeminiModel(args.model);
  const oaiMessages = anthropicMessagesToOpenAi(args.system, args.messages);

  const stream = await client.chat.completions.create({
    model: geminiModel,
    messages: oaiMessages,
    tools: toOaiTools(args.tools),
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    stream: true,
  });

  let text = '';
  const toolCallAccum = new Map<number, { id: string; name: string; argsText: string }>();
  let finishReason: string | null = null;
  // Gemini's OpenAI-compat is inconsistent about per-chunk usage; estimate if absent.
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (delta?.content) {
      text += delta.content;
      args.onTextDelta(delta.content);
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = toolCallAccum.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: '', argsText: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.argsText += tc.function.arguments;
        toolCallAccum.set(idx, acc);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const u = (chunk as unknown as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (u) {
      inputTokens = u.prompt_tokens ?? inputTokens;
      outputTokens = u.completion_tokens ?? outputTokens;
    }
  }

  if (inputTokens === 0) inputTokens = Math.ceil(approxTokens(oaiMessages));
  if (outputTokens === 0) outputTokens = Math.ceil(text.length / 4);

  log.debug({ text_len: text.length, tool_calls: toolCallAccum.size, finishReason }, 'Gemini stream complete');

  return {
    content: buildContentBlocks(text, toolCallAccum.values()),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_write_tokens: 0, cache_read_tokens: 0 },
    servedBy: { provider: 'gemini', model: geminiModel },
    stopReason: oaiStopReason(finishReason),
  };
}

async function callGemini(args: CallArgs): Promise<CallResult> {
  const client = requireGemini();
  const geminiModel = pickGeminiModel(args.model);
  const oaiMessages = anthropicMessagesToOpenAi(systemToString(args.system), args.messages);

  const response = await client.chat.completions.create({
    model: geminiModel,
    messages: oaiMessages,
    tools: toOaiTools(args.tools),
    temperature: args.temperature,
    max_tokens: args.maxTokens,
  });

  const choice = response.choices?.[0];
  const text = choice?.message?.content ?? '';
  const toolCalls = new Map<number, { id: string; name: string; argsText: string }>();
  (choice?.message?.tool_calls ?? []).forEach((tc, idx) => {
    toolCalls.set(idx, {
      id: tc.id ?? `call_${idx}`,
      name: tc.function?.name ?? '',
      argsText: tc.function?.arguments ?? '',
    });
  });

  const usage = response.usage;
  const inputTokens = usage?.prompt_tokens ?? Math.ceil(approxTokens(oaiMessages));
  const outputTokens = usage?.completion_tokens ?? Math.ceil(text.length / 4);

  return {
    content: buildContentBlocks(text, toolCalls.values()),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_write_tokens: 0, cache_read_tokens: 0 },
    servedBy: { provider: 'gemini', model: geminiModel },
    stopReason: oaiStopReason(choice?.finish_reason ?? null),
  };
}

function pickGeminiModel(requested: string): string {
  // If the agent's modelOverride is an Anthropic model, swap to Gemini default.
  if (requested.startsWith('claude-')) return GEMINI_DEFAULT_MODEL;
  return requested;
}

function systemToString(system: string | Anthropic.TextBlockParam[]): string {
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

/**
 * Convert Anthropic-format MessageParam[] to OpenAI Chat Completions messages.
 *
 * The agent loop uses three message shapes:
 *   • { role: 'user', content: <string> }                    — initial user msg
 *   • { role: 'assistant', content: <ContentBlock[]> }       — model reply (may include tool_use)
 *   • { role: 'user', content: <ToolResultBlockParam[]> }    — tool results
 *
 * Tool results become `{role: 'tool', tool_call_id, content}` in OAI.
 */
function anthropicMessagesToOpenAi(
  system: string,
  messages: Anthropic.MessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role as 'user' | 'assistant', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
      for (const block of m.content) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      out.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (m.role === 'user') {
      for (const block of m.content) {
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
          out.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
        } else if (typeof block === 'object' && 'type' in block && block.type === 'text') {
          out.push({ role: 'user', content: block.text });
        }
      }
    }
  }
  return out;
}

function approxTokens(msgs: OpenAI.Chat.ChatCompletionMessageParam[]): number {
  let total = 0;
  for (const m of msgs) {
    if (typeof m.content === 'string') total += m.content.length / 4;
  }
  return total;
}
