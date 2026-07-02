/**
 * streamAgentBySlug — focused entrypoint for direct-by-slug agent invocation
 * over SSE. Used by /api/v1/chat/:tenantSlug/stream when the caller (e.g. the
 * Swarg LMS admin panel) specifies which agent to run.
 *
 * Differences from processMessage (the WhatsApp/Telegram entrypoint):
 *   • Caller specifies agentSlug — no intent classification.
 *   • Single-shot user message + tool-use cycle. No conversation history fetch
 *     beyond what sessionId implies. Each sessionId maps to one conversation
 *     row keyed off a synthetic platform = 'agent-force' user.
 *   • No channel-side delivery — caller consumes the SSE stream.
 *   • No language detection, RAG, escalation, channel-specific guardrails.
 *   • Honors agentTypes.shadowMode + agentTypes.dailySpendCapUsd.
 *
 * Emitted SSE events (via the onEvent callback):
 *   { type: 'token',       content: string }            — text delta from Claude
 *   { type: 'tool_call',   id, name, input }            — Claude invoked a tool
 *   { type: 'tool_result', id, name, output, success }  — handler returned
 *   { type: 'done',        usage, finalText }           — terminal success
 *   { type: 'error',       message }                    — terminal failure
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq, and, desc, sql, gte } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../shared/db.js';
import {
  users, conversations, messages as messagesTable,
  agentTypes, llmUsageLogs, tenants,
} from '../shared/schema/index.js';
import { loadToolsForAgent, executeTool } from '../tools/executor.js';
import { createChildLogger } from '../shared/utils/logger.js';
import { computeCostUsd } from './pricing.js';
import { fireWebhooks } from '../gateway/outbound-webhooks.js';
import { streamLlm } from './llm-provider.js';
import { renderUiToolDef } from '../tools/platform/render-ui.js';
import { textBlock, type ContentBlock } from '../ui/content-blocks.js';

// Slugs of agents whose runs should fire an outbound `agent_run.completed`
// webhook so the admin panel can post-process. Per integration plan §4.3,
// Phase 1 only fires for async runs — currently just lms-insights.
const ASYNC_WEBHOOK_AGENT_SLUGS = new Set(['lms-insights']);

const log = createChildLogger({ module: 'agent-stream' });

const MAX_TOOL_ITERATIONS = 10;
const SYNTHETIC_PLATFORM = 'agent-force';


export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: unknown; success: boolean }
  | { type: 'ui'; blocks: ContentBlock[] }
  | { type: 'done'; usage: { input_tokens: number; output_tokens: number; cached_tokens: number; cache_write_tokens: number; cache_read_tokens: number; cost_usd: number | null }; finalText: string }
  | { type: 'error'; message: string };

export interface StreamAgentParams {
  tenantId: string;
  agentSlug: string;
  sessionId: string;
  userMessage: string;
  userId?: string;
  requestId?: string;
  onEvent: (event: StreamEvent) => void;
}

export interface StreamAgentResult {
  finalText: string;
  conversationId: string;
  agentDisabled?: 'budget' | 'not_found' | 'inactive';
  reason?: string;
}

export async function streamAgentBySlug(params: StreamAgentParams): Promise<StreamAgentResult> {
  const { tenantId, agentSlug, sessionId, userMessage, onEvent } = params;
  const requestId = params.requestId ?? uuidv4();
  const childLog = log.child({ requestId, tenantId, agentSlug, sessionId });

  // 1. Look up agent
  const [agent] = await db
    .select()
    .from(agentTypes)
    .where(and(eq(agentTypes.tenantId, tenantId), eq(agentTypes.slug, agentSlug)))
    .limit(1);

  if (!agent) {
    onEvent({ type: 'error', message: `Agent "${agentSlug}" not found` });
    return { finalText: '', conversationId: '', agentDisabled: 'not_found' };
  }
  if (!agent.isActive) {
    onEvent({ type: 'error', message: `Agent "${agentSlug}" is not active` });
    return { finalText: '', conversationId: '', agentDisabled: 'inactive' };
  }

  // 2. Daily spend cap
  if (agent.dailySpendCapUsd) {
    const cap = Number(agent.dailySpendCapUsd);
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const [{ total }] = await db
      .select({ total: sql<number>`COALESCE(SUM(${llmUsageLogs.costUsd}), 0)` })
      .from(llmUsageLogs)
      .where(and(
        eq(llmUsageLogs.tenantId, tenantId),
        eq(llmUsageLogs.agentTypeSlug, agentSlug),
        gte(llmUsageLogs.createdAt, startOfDay),
      ));
    if (Number(total) >= cap) {
      childLog.warn({ today: total, cap }, 'Agent disabled by daily spend cap');
      onEvent({ type: 'error', message: 'agent_disabled_budget' });
      return { finalText: '', conversationId: '', agentDisabled: 'budget', reason: `today=${total} cap=${cap}` };
    }
  }

  // 3. Tenant slug
  const [tenantRow] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const tenantSlug = tenantRow?.slug ?? '';

  // 4. Resolve synthetic user + conversation keyed by sessionId
  const user = await resolveAgentForceUser(tenantId, sessionId);
  const conversation = await resolveAgentForceConversation(tenantId, user.id, sessionId);

  // 5. Store inbound message
  await db.insert(messagesTable).values({
    conversationId: conversation.id,
    tenantId,
    senderType: 'user',
    content: { text: userMessage, contentType: 'text' },
    metadata: { sessionId, requestId, agentSlug },
  });

  // 6. Load tools assigned to this agent
  const toolDefs = await loadToolsForAgent(tenantId, agentSlug);
  const normalisedTools = toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));

  // 6b. Offer render_ui (path B) only to agents that opted in via a non-empty
  // block whitelist. Path A (tool-returned ui) always works.
  const allowedBlockTypes = (agent.allowedBlockTypes as string[] | null | undefined) ?? null;
  if (Array.isArray(allowedBlockTypes) && allowedBlockTypes.length > 0) {
    normalisedTools.push(renderUiToolDef());
  }

  // 7. Streaming tool-use loop
  const model = agent.modelOverride ?? 'claude-sonnet-4-6';
  let currentMessages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;
  // Provider/model that actually served (may be the fallback).
  let servedBy: { provider: string; model: string } = { provider: 'anthropic', model };
  const uiBlocks: ContentBlock[] = [];
  let finalText = '';
  let iterations = 0;

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      // LMS agents emit STRICT JSON — keep temperature low so the parser
      // on the admin side rarely fails.
      const response = await streamLlm({
        model,
        system: agent.systemPrompt,
        messages: currentMessages,
        tools: normalisedTools,
        temperature: 0.1,
        maxTokens: 4096,
        onTextDelta: (delta) => onEvent({ type: 'token', content: delta }),
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      totalCacheWriteTokens += response.usage.cache_write_tokens;
      totalCacheReadTokens += response.usage.cache_read_tokens;
      servedBy = response.servedBy;

      // Pull text + tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      if (textBlocks.length > 0) {
        finalText = textBlocks.map((b) => b.text).join('\n');
      }

      if (toolUseBlocks.length === 0 || response.stopReason === 'end_turn') {
        break;
      }

      // Execute tools
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        onEvent({ type: 'tool_call', id: toolUse.id, name: toolUse.name, input: toolUse.input });

        const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, {
          tenantId,
          tenantSlug,
          userId: user.id,
          conversationId: conversation.id,
          agentTypeSlug: agentSlug,
          shadowMode: agent.shadowMode,
          requestId,
          allowedBlockTypes,
        });

        onEvent({
          type: 'tool_result',
          id: toolUse.id,
          name: toolUse.name,
          output: result.success ? result.data : result.error,
          success: result.success,
        });

        // Generative-UI blocks (path A/B): stream progressively + collect for persistence.
        if (result.success && Array.isArray(result.ui)) {
          const blocks = result.ui as ContentBlock[];
          uiBlocks.push(...blocks);
          onEvent({ type: 'ui', blocks });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.success ? result.data : result.error),
          is_error: !result.success,
        });
      }

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    // 8. Persist agent response + usage (text + any generative-UI blocks)
    if (finalText || uiBlocks.length > 0) {
      const finalBlocks: ContentBlock[] = uiBlocks.length > 0
        ? [textBlock(finalText), ...uiBlocks]
        : [textBlock(finalText)];
      await db.insert(messagesTable).values({
        conversationId: conversation.id,
        tenantId,
        senderType: 'agent',
        content: { type: 'text', text: finalText, blocks: finalBlocks },
        metadata: { model, requestId, agentSlug },
      });
    }

    // Cost accounting uses the versioned model_pricing table, attributed to the
    // provider/model that actually served (may be the fallback).
    const { costUsd, pricingId } = await computeCostUsd(servedBy.provider, servedBy.model, {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheWrite: totalCacheWriteTokens,
      cacheRead: totalCacheReadTokens,
    });
    await db.insert(llmUsageLogs).values({
      tenantId,
      conversationId: conversation.id,
      agentTypeSlug: agentSlug,
      model: servedBy.model,
      provider: servedBy.provider,
      tokensInput: totalInputTokens,
      tokensOutput: totalOutputTokens,
      tokensCacheWrite: totalCacheWriteTokens,
      tokensCacheRead: totalCacheReadTokens,
      costUsd: costUsd === null ? null : costUsd.toFixed(6),
      pricingId,
    });

    await db.update(conversations)
      .set({
        messageCount: (conversation.messageCount ?? 0) + 2,
        lastMessageAt: new Date(),
        currentAgentType: agentSlug,
      })
      .where(eq(conversations.id, conversation.id));

    onEvent({
      type: 'done',
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cached_tokens: totalCacheReadTokens,   // = cache_read_tokens, kept for consumer compat
        cache_write_tokens: totalCacheWriteTokens,
        cache_read_tokens: totalCacheReadTokens,
        cost_usd: costUsd === null ? null : Number(costUsd.toFixed(6)),
      },
      finalText,
    });

    // Fire async-result webhook for agents whose results need post-processing
    // beyond the SSE stream (currently just lms-insights — admin panel reads
    // the structured payload and may double-check the rows the agent wrote).
    if (ASYNC_WEBHOOK_AGENT_SLUGS.has(agentSlug)) {
      fireWebhooks(tenantId, 'agent_run.completed', {
        agentSlug,
        sessionId,
        result: finalText,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cached_tokens: totalCacheReadTokens,
          cache_write_tokens: totalCacheWriteTokens,
          cache_read_tokens: totalCacheReadTokens,
          cost_usd: costUsd === null ? null : Number(costUsd.toFixed(6)),
        },
      }).catch((err) => childLog.warn({ err }, 'agent_run.completed webhook fire failed'));
    }

    childLog.info({
      iterations, totalInputTokens, totalOutputTokens,
      totalCacheWriteTokens, totalCacheReadTokens, costUsd,
      provider: servedBy.provider, model: servedBy.model,
      shadowMode: agent.shadowMode,
    }, 'Stream agent run complete');

    return { finalText, conversationId: conversation.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    childLog.error({ err }, 'Stream agent run failed');
    onEvent({ type: 'error', message });
    return { finalText: '', conversationId: conversation.id };
  }
}

async function resolveAgentForceUser(tenantId: string, sessionId: string) {
  const [existing] = await db
    .select()
    .from(users)
    .where(and(
      eq(users.tenantId, tenantId),
      eq(users.platformUserId, sessionId),
      eq(users.platform, SYNTHETIC_PLATFORM),
    ))
    .limit(1);
  if (existing) return existing;

  const [created] = await db.insert(users).values({
    tenantId,
    platformUserId: sessionId,
    platform: SYNTHETIC_PLATFORM,
    displayName: `agent-force:${sessionId}`,
  }).returning();
  return created;
}

async function resolveAgentForceConversation(tenantId: string, userId: string, sessionId: string) {
  // Look up an existing active conversation for this synthetic user.
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(
      eq(conversations.tenantId, tenantId),
      eq(conversations.userId, userId),
      eq(conversations.status, 'active'),
    ))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  if (existing) return existing;

  const [created] = await db.insert(conversations).values({
    tenantId,
    userId,
    channel: SYNTHETIC_PLATFORM,
    status: 'active',
    messageCount: 0,
    sessionState: { sessionId },
  }).returning();
  return created;
}
