import Anthropic from '@anthropic-ai/sdk';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../shared/db.js';
import {
  users, conversations, messages as messagesTable,
  agentTypes, conversationTraces, llmUsageLogs, tenants,
} from '../shared/schema/index.js';
import { buildPrompt, toAnthropicTools } from './prompt-builder.js';
import { classifyIntent, selectModel } from './classifier.js';
import { evaluateGuardrails } from './guardrails.js';
import { compactIfNeeded } from './compaction.js';
import { getMemoryIndex } from '../memory/memory-manager.js';
import { detectLanguage } from './language.js';
import { loadToolsForAgent, executeTool } from '../tools/executor.js';
import { deliverBlocks } from '../gateway/renderers/index.js';
import { renderUiToolDef } from '../tools/platform/render-ui.js';
import { extractText, textBlock, type ContentBlock } from '../ui/content-blocks.js';
import { sendWhatsAppText } from '../gateway/whatsapp/sender.js';
import { isAgentPaused } from '../gateway/whatsapp/coexistence.js';
import { fireWebhooks } from '../gateway/outbound-webhooks.js';
import { evaluateEscalation, executeEscalation } from '../admin/hitl/escalation.js';
import { loadActiveCorrections } from '../admin/corrections/routes.js';
import { searchPastCorrections, formatPastCorrections } from '../admin/corrections/retrieval.js';
import { searchKnowledge } from '../memory/knowledge-base.js';
import { createChildLogger } from '../shared/utils/logger.js';
import { checkBudget, incrementBudgetUsage } from './budget.js';
import { isTenantPaused } from '../billing/wallet-state.js';
import { raiseAlert } from '../billing/alerts.js';
import { utcMonthPrefix } from '../billing/period.js';
import { callLlm } from './llm-provider.js';
import { computeCostUsd } from './pricing.js';
import type { UnifiedMessage, TenantConfig, ConversationTrace, IntentClassification } from '../shared/types/index.js';

const log = createChildLogger({ module: 'agent-loop' });

const MAX_TOOL_ITERATIONS = 10;

/**
 * Sink for pushing the agent's reply to a live web/app client (WebSocket). The
 * WhatsApp/Telegram channels deliver via their senders; web has no sender, so
 * without a sink the browser widget receives no reply.
 */
export type ResponseSink = (evt: { type: 'text'; text: string } | { type: 'ui'; blocks: ContentBlock[] }) => void;

export async function processMessage(
  message: UnifiedMessage,
  tenantId: string,
  tenantConfig: TenantConfig,
  sink?: ResponseSink,
): Promise<void> {
  const traceId = uuidv4();
  const startTime = Date.now();

  const childLog = log.child({ traceId, tenantId, channel: message.channel });
  childLog.info({ messageType: message.content.type }, 'Processing message');

  try {
    // 1. Resolve or create user
    const user = await resolveUser(tenantId, message);
    childLog.info({ userId: user.id }, 'User resolved');

    // 1b. WhatsApp coexistence: skip if operator paused the agent
    if (message.channel === 'whatsapp') {
      const paused = await isAgentPaused(tenantId, message.sender.platformUserId);
      if (paused) {
        childLog.info({ phone: message.sender.platformUserId }, 'Agent paused — operator handling');
        return;
      }
    }

    // 2. Find or create conversation
    const conversation = await resolveConversation(tenantId, user.id, message.channel);
    childLog.info({ conversationId: conversation.id }, 'Conversation resolved');

    // 3. Store inbound message. For a rendered-UI action (button/list reply,
    // callback, web intent), enrich the text with the structured intent/payload
    // so the model — which reads this back via history — treats it as an intent
    // turn, not just the button label. Log ids only elsewhere (no PII).
    const action = message.metadata?.action;
    const inboundText = action
      ? `[user action: intent=${action.intent ?? 'postback'} payload=${action.payload}]${message.content.text ? ' ' + message.content.text : ''}`
      : message.content.text;
    await db.insert(messagesTable).values({
      conversationId: conversation.id,
      tenantId,
      senderType: 'user',
      content: { text: inboundText, mediaUrl: message.content.mediaUrl, contentType: message.content.type },
      metadata: message.metadata,
    });

    // 3b. Wallet pause (prepaid depleted or manual) — hard block on spend.
    if (await isTenantPaused(tenantId)) {
      childLog.warn({ tenantId }, 'Tenant wallet paused — blocking turn');
      if (message.channel === 'whatsapp') {
        await sendWhatsAppText(tenantConfig, {
          to: message.sender.platformUserId,
          text: 'Our AI assistant is temporarily unavailable. Please contact us directly for help.',
        });
      }
      return;
    }

    // 3c. Token-budget check (+ once-per-tier/month alert).
    const budget = await checkBudget(tenantId, tenantConfig);
    if (budget.thresholdCrossed) {
      await raiseAlert({
        tenantId,
        type: 'budget.tokens',
        severity: budget.thresholdCrossed === 100 ? 'critical' : 'warning',
        title: budget.thresholdCrossed === 100 ? 'Monthly token budget exceeded' : 'Monthly token budget at 80%',
        body: `Used ${budget.used} of ${budget.limit} tokens (${budget.percentUsed.toFixed(0)}%).`,
        dedupeKey: `budget-tokens:${tenantId}:${utcMonthPrefix(new Date())}:${budget.thresholdCrossed}`,
        webhookEvent: budget.thresholdCrossed === 100 ? 'budget.exceeded' : 'budget.threshold_reached',
        webhookData: { used: budget.used, limit: budget.limit, pct: budget.percentUsed.toFixed(0) },
      }).catch((err) => childLog.error({ err }, 'Budget alert failed'));
    }
    if (!budget.withinBudget) {
      childLog.warn({ used: budget.used, limit: budget.limit }, 'Tenant budget exceeded');
      if (message.channel === 'whatsapp') {
        await sendWhatsAppText(tenantConfig, {
          to: message.sender.platformUserId,
          text: 'Our AI assistant is temporarily unavailable. Please contact us directly for help.',
        });
      }
      return;
    }

    // 4. Input guardrails
    const inputText = message.content.text ?? '';
    const inputGuardrail = await evaluateGuardrails(inputText, tenantId, 'input');
    if (!inputGuardrail.passed) {
      childLog.info({ rule: inputGuardrail.ruleName }, 'Input blocked by guardrail');
      if (message.channel === 'whatsapp') {
        await sendWhatsAppText(tenantConfig, {
          to: message.sender.platformUserId,
          text: inputGuardrail.triggerResponse ?? "I can't process that request.",
        });
      }
      return;
    }
    const processedInput = inputGuardrail.processedText ?? inputText;

    // 5. Language detection
    const detectedLanguage = detectLanguage(processedInput);

    // 6. Intent classification + model routing
    const allAgentTypes = await db
      .select()
      .from(agentTypes)
      .where(and(eq(agentTypes.tenantId, tenantId), eq(agentTypes.isActive, true)));

    let classification: IntentClassification | undefined;
    let selectedAgent = allAgentTypes.find(a => a.isDefault) ?? allAgentTypes[0];

    if (tenantConfig.orchestrator.enableAutoRouting && allAgentTypes.length > 1) {
      classification = await classifyIntent({
        userMessage: processedInput,
        agentTypes: allAgentTypes.map(a => ({
          slug: a.slug,
          name: a.name,
          description: a.description ?? '',
          intentKeywords: a.intentKeywords ?? [],
          intentExamples: a.intentExamples ?? [],
        })),
        tenantConfig,
      });

      const routed = allAgentTypes.find(a => a.slug === classification!.agentType);
      if (routed) selectedAgent = routed;
    }

    const agentSlug = selectedAgent?.slug ?? 'support';
    const agentSystemPrompt = selectedAgent?.systemPrompt ?? '';
    const agentModelOverride = selectedAgent?.modelOverride;

    // Select model based on classification
    const model = classification
      ? selectModel(classification, tenantConfig, agentModelOverride)
      : (agentModelOverride ?? tenantConfig.ai.primaryModel);

    // 6b. Escalation check
    if (classification) {
      const escalation = evaluateEscalation({
        tenantId,
        conversationId: conversation.id,
        userId: user.id,
        classification,
        messageText: processedInput,
        messageCount: conversation.messageCount ?? 0,
      }, tenantConfig);

      if (escalation.shouldEscalate) {
        await executeEscalation({
          tenantId,
          conversationId: conversation.id,
          userId: user.id,
          classification,
          messageText: processedInput,
          messageCount: conversation.messageCount ?? 0,
        }, escalation);

        await fireWebhooks(tenantId, 'handoff_triggered', {
          conversationId: conversation.id,
          reasons: escalation.reasons,
          priority: escalation.priority,
        });
      }
    }

    // 7. Load memory index (Layer 1)
    const memoryIndex = await getMemoryIndex(user.id, tenantId);

    // 7b. RAG context (knowledge base search)
    let ragContext: string | undefined;
    if (classification?.requiresRag && processedInput) {
      const kbResults = await searchKnowledge(tenantId, processedInput, 3);
      if (kbResults.length > 0) {
        ragContext = kbResults.map(r => r.content).join('\n---\n');
      }
    }

    // 7c. Load active correction rules + retrieve similar past corrections
    const corrections = await loadActiveCorrections(tenantId, agentSlug);
    const pastCorrectionRows = await searchPastCorrections(tenantId, agentSlug, processedInput);
    const pastCorrections = formatPastCorrections(pastCorrectionRows);

    // 8. Load tools for agent
    const toolDefs = await loadToolsForAgent(tenantId, agentSlug);
    const anthropicTools = toAnthropicTools(toolDefs.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    })));

    // 8b. Generative UI: offer render_ui (path B) only to agents that opted in
    // via a non-empty block whitelist. Path A (tool-returned ui) always works.
    const allowedBlockTypes = (selectedAgent?.allowedBlockTypes as string[] | null | undefined) ?? null;
    const uiEnabled = Array.isArray(allowedBlockTypes) && allowedBlockTypes.length > 0;
    if (uiEnabled) {
      const def = renderUiToolDef();
      anthropicTools.push({ name: def.name, description: def.description, input_schema: def.input_schema as Anthropic.Tool['input_schema'] });
    }

    // 6. Load conversation history (last N messages)
    const maxTurns = tenantConfig.context?.maxConversationTurns ?? 50;
    const historyRows = await db
      .select({
        senderType: messagesTable.senderType,
        content: messagesTable.content,
      })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversation.id))
      .orderBy(desc(messagesTable.createdAt))
      .limit(maxTurns * 2); // user + agent messages

    // Convert to Anthropic message format (reverse to chronological order)
    const conversationHistory: Anthropic.MessageParam[] = historyRows
      .reverse()
      .map(row => ({
        role: row.senderType === 'user' ? 'user' as const : 'assistant' as const,
        // Normalize any content shape (legacy {text}, new {blocks}) → plain text
        // for the model. Prevents rich assistant turns collapsing to '[media message]'.
        content: extractText(row.content),
      }));

    // 10. Context compaction if needed
    const contextBudget = 200000; // 200k context window
    const systemTokenEstimate = 4000;
    const compaction = await compactIfNeeded(conversationHistory, systemTokenEstimate, {
      systemTokenBudget: tenantConfig.context?.systemTokenBudget ?? 2000,
      contextBudget,
      memoryIndex: memoryIndex ?? undefined,
      userProfile: user.profileData as Record<string, unknown> | undefined,
    });
    const compactedHistory = compaction.messages;

    // 11. Build prompt with static/dynamic split
    const prompt = buildPrompt({
      tenantConfig,
      agentSystemPrompt,
      toolDefinitions: anthropicTools,
      userProfile: user.profileData as Record<string, unknown> | undefined,
      memoryIndex: memoryIndex ?? undefined,
      ragContext,
      corrections: corrections.length > 0 ? corrections : undefined,
      pastCorrections: pastCorrections.length > 0 ? pastCorrections : undefined,
      conversationHistory: compactedHistory,
      language: detectedLanguage !== 'en' ? detectedLanguage : (user.languagePreferred ?? undefined),
    });

    // 12. LLM call with tool loop
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalCacheReadTokens = 0;
    let finalText = '';
    // Provider/model that actually served the turn (may be the fallback).
    let servedBy: { provider: string; model: string } = { provider: 'anthropic', model };
    const toolsCalled: ConversationTrace['toolsCalled'] = [];
    // Generative-UI blocks emitted by tools (path A) or render_ui (path B).
    const uiBlocks: ContentBlock[] = [];

    let currentMessages = prompt.messages;
    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const llmStart = Date.now();
      const response = await callLlm({
        model,
        maxTokens: tenantConfig.ai.maxTokensPerResponse ?? 1024,
        temperature: tenantConfig.ai.temperature ?? 0.7,
        system: prompt.system,
        messages: currentMessages,
        tools: prompt.tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          input_schema: t.input_schema as Record<string, unknown>,
        })),
      });

      const llmMs = Date.now() - llmStart;

      // Track token usage (both cache tiers) and the serving provider/model.
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      totalCacheWriteTokens += response.usage.cache_write_tokens;
      totalCacheReadTokens += response.usage.cache_read_tokens;
      servedBy = response.servedBy;

      // Check for tool calls
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      if (textBlocks.length > 0) {
        finalText = textBlocks.map(b => b.text).join('\n');
      }

      if (toolUseBlocks.length === 0 || response.stopReason === 'end_turn') {
        // No more tool calls — we're done
        break;
      }

      // Execute tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        childLog.info({ tool: toolUse.name }, 'Executing tool');

        const [tenantRow] = await db.select({ slug: tenants.slug })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        const tenantSlug = tenantRow?.slug ?? '';

        const toolStart = Date.now();
        const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, {
          tenantId,
          tenantSlug,
          userId: user.id,
          conversationId: conversation.id,
          agentTypeSlug: agentSlug,
          allowedBlockTypes,
        });
        const toolMs = Date.now() - toolStart;

        toolsCalled.push({ name: toolUse.name, status: result.success ? 'success' : 'error', durationMs: toolMs });
        if (result.success && Array.isArray(result.ui)) uiBlocks.push(...(result.ui as ContentBlock[]));

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.success ? result.data : result.error),
        });
      }

      // Feed tool results back to LLM
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    // 13. Output guardrails
    const outputGuardrail = await evaluateGuardrails(finalText, tenantId, 'output');
    if (!outputGuardrail.passed) {
      finalText = tenantConfig.persona.fallbackMessage ?? "Let me connect you with our team for this request.";
      childLog.info({ rule: outputGuardrail.ruleName }, 'Output blocked by guardrail');
    } else if (outputGuardrail.processedText !== finalText) {
      finalText = outputGuardrail.processedText ?? finalText;
    }

    // 14. Store agent response (text + any generative-UI blocks; zero-migration
    // shape: legacy readers use `text`, rich readers use `blocks`).
    const finalBlocks: ContentBlock[] = uiBlocks.length > 0
      ? [textBlock(finalText), ...uiBlocks]
      : [textBlock(finalText)];
    await db.insert(messagesTable).values({
      conversationId: conversation.id,
      tenantId,
      senderType: 'agent',
      content: { type: 'text', text: finalText, blocks: finalBlocks },
      metadata: { model, traceId },
    });

    // 10. Update conversation
    await db.update(conversations)
      .set({
        messageCount: (conversation.messageCount ?? 0) + 2, // user + agent
        lastMessageAt: new Date(),
        currentAgentType: agentSlug,
      })
      .where(eq(conversations.id, conversation.id));

    // 15. Send response via channel. WhatsApp/Telegram render blocks to native
    // elements (degrading unsupported ones to fallbackText); web/app push through
    // the sink to the live WebSocket client.
    if (finalText || uiBlocks.length > 0) {
      const to = message.sender.platformUserId;
      switch (message.channel) {
        case 'whatsapp':
          await deliverBlocks('whatsapp', finalBlocks, { tenantConfig, to });
          break;
        case 'telegram':
          await deliverBlocks('telegram', finalBlocks, { tenantConfig, to, botToken: tenantConfig.channels.telegram?.botToken });
          break;
        case 'web':
        case 'app':
          if (uiBlocks.length > 0) sink?.({ type: 'ui', blocks: finalBlocks });
          else sink?.({ type: 'text', text: finalText });
          break;
      }
    }

    // 16. Fire outbound webhooks
    fireWebhooks(tenantId, 'conversation_started', {
      conversationId: conversation.id,
      channel: message.channel,
      userId: user.id,
    }).catch(() => { /* non-blocking */ });

    // 17. Log trace
    const totalMs = Date.now() - startTime;
    const allGuardrailsTriggered = [
      ...inputGuardrail.triggered.map(g => ({ name: g.name, action: g.action })),
      ...outputGuardrail.triggered.map(g => ({ name: g.name, action: g.action })),
    ];
    const trace: ConversationTrace = {
      traceId,
      conversationId: conversation.id,
      turnNumber: Math.ceil((conversation.messageCount ?? 0) / 2) + 1,
      timing: { totalMs, llmMs: totalMs, toolMs: toolsCalled.reduce((sum, t) => sum + t.durationMs, 0) },
      ai: {
        modelUsed: servedBy.model,
        tokensInput: totalInputTokens,
        tokensOutput: totalOutputTokens,
        tokensCached: totalCacheReadTokens,
        tokensCacheWrite: totalCacheWriteTokens,
        tokensCacheRead: totalCacheReadTokens,
        confidence: classification?.confidence,
        intent: classification?.intent,
        agentType: agentSlug,
      },
      toolsCalled,
      guardrailsTriggered: allGuardrailsTriggered,
      hitlTriggered: classification?.requiresHitl ?? false,
      wasCorrected: false,
    };

    await db.insert(conversationTraces).values({
      conversationId: conversation.id,
      tenantId,
      turnNumber: trace.turnNumber,
      traceData: trace,
    });

    // Log LLM usage — cost computed from the versioned model_pricing table,
    // attributed to the provider/model that actually served (may be fallback).
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

    // Update budget counter
    await incrementBudgetUsage(tenantId, totalInputTokens + totalOutputTokens);

    childLog.info({
      totalMs,
      model: servedBy.model,
      provider: servedBy.provider,
      tokensIn: totalInputTokens,
      tokensOut: totalOutputTokens,
      tokensCacheWrite: totalCacheWriteTokens,
      tokensCacheRead: totalCacheReadTokens,
      costUsd: costUsd === null ? null : costUsd.toFixed(6),
      toolsUsed: toolsCalled.length,
    }, 'Message processed');

  } catch (err) {
    childLog.error({ err }, 'Agent loop failed');

    // Try to send fallback message
    if (message.channel === 'whatsapp') {
      const fallback = tenantConfig.persona.fallbackMessage ?? "I'm sorry, I encountered an issue. Please try again.";
      await sendWhatsAppText(tenantConfig, {
        to: message.sender.platformUserId,
        text: fallback,
      }).catch(() => { /* best effort */ });
    }
  }
}

async function resolveUser(tenantId: string, message: UnifiedMessage) {
  const [existing] = await db
    .select()
    .from(users)
    .where(and(
      eq(users.tenantId, tenantId),
      eq(users.platformUserId, message.sender.platformUserId),
      eq(users.platform, message.channel),
    ))
    .limit(1);

  if (existing) return existing;

  const [created] = await db.insert(users).values({
    tenantId,
    platformUserId: message.sender.platformUserId,
    platform: message.channel,
    displayName: message.sender.displayName,
  }).returning();

  return created;
}

async function resolveConversation(tenantId: string, userId: string, channel: string) {
  // Find active conversation for this user
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

  if (existing) {
    // Check if conversation is stale (>24h since last message)
    const lastMsg = existing.lastMessageAt ?? existing.startedAt;
    const hoursSinceLastMsg = lastMsg ? (Date.now() - new Date(lastMsg).getTime()) / (1000 * 60 * 60) : 999;

    if (hoursSinceLastMsg < 24) {
      return existing;
    }

    // Close stale conversation
    await db.update(conversations)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(conversations.id, existing.id));
  }

  // Create new conversation
  const [created] = await db.insert(conversations).values({
    tenantId,
    userId,
    channel,
    status: 'active',
    messageCount: 0,
  }).returning();

  return created;
}
