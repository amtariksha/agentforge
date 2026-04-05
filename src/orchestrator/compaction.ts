import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'compaction' });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: Anthropic.MessageParam[]): number {
  return messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + estimateTokens(m.content);
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s, block) => {
        if ('text' in block && typeof block.text === 'string') return s + estimateTokens(block.text);
        if ('content' in block && typeof block.content === 'string') return s + estimateTokens(block.content);
        return s + 50; // tool_use / tool_result blocks
      }, 0);
    }
    return sum + 50;
  }, 0);
}

interface CompactionContext {
  systemTokenBudget: number;
  contextBudget: number; // Max context window tokens
  memoryIndex?: string;
  userProfile?: Record<string, unknown>;
  corrections?: string[];
}

interface CompactionResult {
  messages: Anthropic.MessageParam[];
  stage: 'none' | 'micro' | 'auto' | 'full';
  tokensBefore: number;
  tokensAfter: number;
}

const MICRO_THRESHOLD = 0.70; // 70% of context
const AUTO_THRESHOLD = 0.85;  // 85%
const FULL_THRESHOLD = 0.95;  // 95%
const MAX_AUTO_FAILURES = 3;

let consecutiveAutoFailures = 0;

export async function compactIfNeeded(
  messages: Anthropic.MessageParam[],
  systemTokens: number,
  ctx: CompactionContext,
): Promise<CompactionResult> {
  const messageTokens = estimateMessagesTokens(messages);
  const totalTokens = systemTokens + messageTokens;
  const utilization = totalTokens / ctx.contextBudget;

  if (utilization < MICRO_THRESHOLD) {
    return { messages, stage: 'none', tokensBefore: messageTokens, tokensAfter: messageTokens };
  }

  log.info({ utilization: utilization.toFixed(2), messageTokens, totalTokens }, 'Context compaction needed');

  // Stage 1: MicroCompact (zero API cost)
  if (utilization < AUTO_THRESHOLD) {
    const compacted = microCompact(messages);
    const tokensAfter = estimateMessagesTokens(compacted);
    log.info({ stage: 'micro', tokensBefore: messageTokens, tokensAfter }, 'MicroCompact applied');
    return { messages: compacted, stage: 'micro', tokensBefore: messageTokens, tokensAfter };
  }

  // Stage 2: AutoCompact (one Haiku call)
  if (utilization < FULL_THRESHOLD && consecutiveAutoFailures < MAX_AUTO_FAILURES) {
    try {
      const compacted = await autoCompact(messages, ctx);
      consecutiveAutoFailures = 0;
      const tokensAfter = estimateMessagesTokens(compacted);
      log.info({ stage: 'auto', tokensBefore: messageTokens, tokensAfter }, 'AutoCompact applied');
      return { messages: compacted, stage: 'auto', tokensBefore: messageTokens, tokensAfter };
    } catch (err) {
      consecutiveAutoFailures++;
      log.error({ err, failures: consecutiveAutoFailures }, 'AutoCompact failed');
      // Fall through to MicroCompact
      const compacted = microCompact(messages);
      const tokensAfter = estimateMessagesTokens(compacted);
      return { messages: compacted, stage: 'micro', tokensBefore: messageTokens, tokensAfter };
    }
  }

  // Stage 3: FullCompact (one Sonnet call)
  try {
    const compacted = await fullCompact(messages, ctx);
    const tokensAfter = estimateMessagesTokens(compacted);
    log.info({ stage: 'full', tokensBefore: messageTokens, tokensAfter }, 'FullCompact applied');
    return { messages: compacted, stage: 'full', tokensBefore: messageTokens, tokensAfter };
  } catch (err) {
    log.error({ err }, 'FullCompact failed, aggressive micro-compact');
    const compacted = aggressiveMicroCompact(messages);
    const tokensAfter = estimateMessagesTokens(compacted);
    return { messages: compacted, stage: 'micro', tokensBefore: messageTokens, tokensAfter };
  }
}

/**
 * Stage 1: MicroCompact — zero API cost
 * - Trim old tool_result content (keep only success/failure + summary)
 * - Remove intermediate reasoning from assistant messages
 * - Collapse repeated user messages
 */
function microCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  const keepRecent = 6; // Always keep last 6 messages

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isRecent = i >= messages.length - keepRecent;

    if (isRecent) {
      result.push(msg);
      continue;
    }

    // Trim old tool results to summaries
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const trimmed = msg.content.map(block => {
        if ('type' in block && block.type === 'tool_result' && 'content' in block) {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          if (content.length > 200) {
            return { ...block, content: content.slice(0, 200) + '...[trimmed]' };
          }
        }
        return block;
      });
      result.push({ ...msg, content: trimmed });
      continue;
    }

    // Trim long assistant messages
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 500) {
      result.push({ ...msg, content: msg.content.slice(0, 400) + '...[compacted]' });
      continue;
    }

    result.push(msg);
  }

  return result;
}

/**
 * Stage 2: AutoCompact — one Haiku call
 * Generate 2,000-token summary preserving: intent, pending actions, decisions.
 */
async function autoCompact(
  messages: Anthropic.MessageParam[],
  ctx: CompactionContext,
): Promise<Anthropic.MessageParam[]> {
  // Summarize all but last 4 messages
  const toSummarize = messages.slice(0, -4);
  const toKeep = messages.slice(-4);

  const summaryPrompt = `Summarize this conversation history into a structured summary (~500 words). Preserve:
1. Customer's original request and intent
2. All pending/unresolved actions
3. Key decisions made
4. Tool results and their outcomes
5. Any promises made to the customer
Format as a concise narrative, not bullet points.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 800,
    temperature: 0,
    system: summaryPrompt,
    messages: [{ role: 'user', content: serializeMessages(toSummarize) }],
  });

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Rebuild: summary as first message pair, then recent messages
  const compacted: Anthropic.MessageParam[] = [
    { role: 'user', content: `[Previous conversation summary]\n${summary}` },
    { role: 'assistant', content: 'I understand the context. Let me continue helping.' },
    ...toKeep,
  ];

  return compacted;
}

/**
 * Stage 3: FullCompact — one Sonnet call
 * Compress everything with higher-quality model.
 */
async function fullCompact(
  messages: Anthropic.MessageParam[],
  ctx: CompactionContext,
): Promise<Anthropic.MessageParam[]> {
  const toKeep = messages.slice(-2);

  const summaryPrompt = `Compress this entire conversation into a detailed summary (~800 words). You MUST preserve:
1. The customer's identity and key profile information
2. Every unresolved issue or pending action
3. All tool calls made and their results
4. Any commitments or promises made
5. The current state of the conversation
6. Customer sentiment and tone
This summary will replace the conversation history, so nothing important can be lost.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    temperature: 0,
    system: summaryPrompt,
    messages: [{ role: 'user', content: serializeMessages(messages) }],
  });

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Re-inject memory index and user profile
  const contextParts = ['[Compressed conversation context]', summary];
  if (ctx.memoryIndex) {
    contextParts.push('\n[Memory index]', ctx.memoryIndex);
  }
  if (ctx.corrections && ctx.corrections.length > 0) {
    contextParts.push('\n[Active corrections]', ctx.corrections.join('\n'));
  }

  return [
    { role: 'user', content: contextParts.join('\n') },
    { role: 'assistant', content: 'I have full context. Let me continue assisting.' },
    ...toKeep,
  ];
}

/**
 * Aggressive micro-compact — last resort when all else fails
 */
function aggressiveMicroCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Keep only last 4 messages
  return messages.slice(-4);
}

function serializeMessages(messages: Anthropic.MessageParam[]): string {
  return messages.map(m => {
    const role = m.role === 'user' ? 'Customer' : 'Agent';
    if (typeof m.content === 'string') return `${role}: ${m.content}`;
    if (Array.isArray(m.content)) {
      const parts = m.content.map(block => {
        if ('text' in block && typeof block.text === 'string') return block.text;
        if ('type' in block && block.type === 'tool_use') return `[Tool: ${(block as Anthropic.ToolUseBlock).name}]`;
        if ('type' in block && block.type === 'tool_result') return `[Tool Result]`;
        return '[block]';
      });
      return `${role}: ${parts.join(' ')}`;
    }
    return `${role}: [content]`;
  }).join('\n');
}
