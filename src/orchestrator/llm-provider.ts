/**
 * LLM provider abstraction for streaming + tool-use cycles.
 *
 * Two backends supported:
 *   • Anthropic (default) — uses @anthropic-ai/sdk.
 *   • Gemini — uses Gemini's OpenAI-compatible endpoint via the `openai` SDK
 *     pointed at https://generativelanguage.googleapis.com/v1beta/openai/.
 *
 * Selection: env LLM_PROVIDER. If unset OR equal to 'anthropic', use Anthropic.
 * If 'gemini', use Gemini. Per-agent `modelOverride` is honored only when it
 * matches the active provider's model family — otherwise we fall back to the
 * provider's default model below.
 *
 * Output shape normalises on Anthropic's content blocks so the agent loop in
 * agent-stream.ts doesn't need provider-specific code paths.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'llm-provider' });

const PROVIDER = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() as 'anthropic' | 'gemini';
const GEMINI_DEFAULT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const gemini = PROVIDER === 'gemini'
  ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    })
  : null;

export function activeProvider(): 'anthropic' | 'gemini' {
  return PROVIDER;
}

/** A tool the agent has access to, in Anthropic-native shape. */
export interface NormalisedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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

export interface StreamResult {
  content: Anthropic.ContentBlock[];
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number };
  stopReason: string | null;
}

export async function streamLlm(args: StreamArgs): Promise<StreamResult> {
  if (PROVIDER === 'gemini') {
    return streamGemini(args);
  }
  return streamAnthropic(args);
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

async function streamAnthropic(args: StreamArgs): Promise<StreamResult> {
  const stream = anthropic.messages.stream({
    model: args.model,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    system: args.system,
    messages: args.messages,
    tools: args.tools.length > 0
      ? args.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        }))
      : undefined,
  });

  stream.on('text', (delta) => args.onTextDelta(delta));

  const response = await stream.finalMessage();
  const usage = response.usage as unknown as Record<string, number>;
  return {
    content: response.content,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cached_tokens: usage['cache_read_input_tokens'] ?? 0,
    },
    stopReason: response.stop_reason,
  };
}

// ─── Gemini via OpenAI-compat ───────────────────────────────────────────────

async function streamGemini(args: StreamArgs): Promise<StreamResult> {
  if (!gemini) {
    throw new Error('LLM_PROVIDER=gemini but Gemini client not initialised — set GEMINI_API_KEY');
  }

  const geminiModel = pickGeminiModel(args.model);

  // Convert Anthropic messages → OpenAI Chat Completions messages.
  const oaiMessages = anthropicMessagesToOpenAi(args.system, args.messages);

  const oaiTools = args.tools.length > 0
    ? args.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    : undefined;

  const stream = await gemini.chat.completions.create({
    model: geminiModel,
    messages: oaiMessages,
    tools: oaiTools,
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    stream: true,
  });

  // Accumulate the stream — tokens, tool-call deltas, finish reason.
  let text = '';
  const toolCallAccum = new Map<number, { id: string; name: string; argsText: string }>();
  let finishReason: string | null = null;
  // Gemini's OpenAI-compat is inconsistent about returning per-chunk usage;
  // fall back to estimating from text length if absent.
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

  // Build normalised content blocks (text + tool_use) so the rest of the
  // pipeline doesn't care which provider responded.
  const content: Anthropic.ContentBlock[] = [];
  if (text) {
    content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  }
  for (const tc of toolCallAccum.values()) {
    let parsedInput: unknown = {};
    try { parsedInput = tc.argsText ? JSON.parse(tc.argsText) : {}; } catch { parsedInput = { _raw: tc.argsText }; }
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: parsedInput,
    } as Anthropic.ToolUseBlock);
  }

  // Map OpenAI finish_reason → Anthropic stop_reason equivalent (just enough
  // for the agent loop to decide whether to continue tool-calling).
  let stopReason: string | null = finishReason;
  if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'stop') stopReason = 'end_turn';

  log.debug({
    text_len: text.length, tool_calls: toolCallAccum.size, finishReason, stopReason,
  }, 'Gemini stream complete');

  return {
    content,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: 0 },
    stopReason,
  };
}

function pickGeminiModel(requested: string): string {
  // If the agent's modelOverride is an Anthropic model, swap to Gemini default.
  if (requested.startsWith('claude-')) return GEMINI_DEFAULT_MODEL;
  return requested;
}

/**
 * Convert Anthropic-format MessageParam[] to OpenAI Chat Completions messages.
 *
 * The agent loop uses three message shapes:
 *   • { role: 'user', content: <string> }                    — initial user msg
 *   • { role: 'assistant', content: <ContentBlock[]> }       — model reply (may include tool_use)
 *   • { role: 'user', content: <ToolResultBlockParam[]> }   — tool results
 *
 * Translate accordingly. Tool results become `{role: 'tool', tool_call_id, content}` in OAI.
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
      // Assistant message — may contain text + tool_use blocks.
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
      // User message — may contain tool_result blocks that become separate
      // OpenAI 'tool' messages.
      for (const block of m.content) {
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content,
          });
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
