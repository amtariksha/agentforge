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
import { sendWhatsAppText } from '../gateway/whatsapp/sender.js';
import { createChildLogger } from '../shared/utils/logger.js';
import type { UnifiedMessage, TenantConfig, ConversationTrace, IntentClassification } from '../shared/types/index.js';

const log = createChildLogger({ module: 'agent-loop' });

const MAX_TOOL_ITERATIONS = 10;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function processMessage(
  message: UnifiedMessage,
  tenantId: string,
  tenantConfig: TenantConfig,
): Promise<void> {
  const traceId = uuidv4();
  const startTime = Date.now();

  const childLog = log.child({ traceId, tenantId, channel: message.channel });
  childLog.info({ messageType: message.content.type }, 'Processing message');

  try {
    // 1. Resolve or create user
    const user = await resolveUser(tenantId, message);
    childLog.info({ userId: user.id }, 'User resolved');

    // 2. Find or create conversation
    const conversation = await resolveConversation(tenantId, user.id, message.channel);
    childLog.info({ conversationId: conversation.id }, 'Conversation resolved');

    // 3. Store inbound message
    await db.insert(messagesTable).values({
      conversationId: conversation.id,
      tenantId,
      senderType: 'user',
      content: { text: message.content.text, mediaUrl: message.content.mediaUrl, contentType: message.content.type },
      metadata: message.metadata,
    });

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

    // 7. Load memory index (Layer 1)
    const memoryIndex = await getMemoryIndex(user.id, tenantId);

    // 8. Load tools for agent
    const toolDefs = await loadToolsForAgent(tenantId, agentSlug);
    const anthropicTools = toAnthropicTools(toolDefs.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    })));

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
      .map(row => {
        const content = row.content as { text?: string; type?: string };
        return {
          role: row.senderType === 'user' ? 'user' as const : 'assistant' as const,
          content: content.text ?? '[media message]',
        };
      });

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
      conversationHistory: compactedHistory,
      language: detectedLanguage !== 'en' ? detectedLanguage : (user.languagePreferred ?? undefined),
    });

    // 12. LLM call with tool loop
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let finalText = '';
    const toolsCalled: ConversationTrace['toolsCalled'] = [];

    let currentMessages = prompt.messages;
    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const llmStart = Date.now();
      const response = await anthropic.messages.create({
        model,
        max_tokens: tenantConfig.ai.maxTokensPerResponse ?? 1024,
        temperature: tenantConfig.ai.temperature ?? 0.7,
        system: prompt.system,
        messages: currentMessages,
        tools: prompt.tools.length > 0 ? prompt.tools : undefined,
      });

      const llmMs = Date.now() - llmStart;

      // Track token usage
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      const usage = response.usage as unknown as Record<string, number>;
      if ('cache_read_input_tokens' in usage) {
        totalCachedTokens += usage['cache_read_input_tokens'] ?? 0;
      }

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

      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
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
        });
        const toolMs = Date.now() - toolStart;

        toolsCalled.push({ name: toolUse.name, status: result.success ? 'success' : 'error', durationMs: toolMs });

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

    // 14. Store agent response
    await db.insert(messagesTable).values({
      conversationId: conversation.id,
      tenantId,
      senderType: 'agent',
      content: { type: 'text', text: finalText },
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

    // 11. Send response via channel
    if (message.channel === 'whatsapp' && finalText) {
      await sendWhatsAppText(tenantConfig, {
        to: message.sender.platformUserId,
        text: finalText,
      });
    }

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
        modelUsed: model,
        tokensInput: totalInputTokens,
        tokensOutput: totalOutputTokens,
        tokensCached: totalCachedTokens,
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

    // Log LLM usage
    const costUsd = estimateCost(model, totalInputTokens, totalOutputTokens, totalCachedTokens);
    await db.insert(llmUsageLogs).values({
      tenantId,
      conversationId: conversation.id,
      model,
      provider: 'anthropic',
      tokensInput: totalInputTokens,
      tokensOutput: totalOutputTokens,
      tokensCached: totalCachedTokens,
      costUsd: costUsd.toFixed(6),
    });

    childLog.info({
      totalMs,
      model,
      tokensIn: totalInputTokens,
      tokensOut: totalOutputTokens,
      tokensCached: totalCachedTokens,
      costUsd: costUsd.toFixed(6),
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

function estimateCost(model: string, inputTokens: number, outputTokens: number, cachedTokens: number): number {
  // Pricing per million tokens (approximate as of 2026)
  const pricing: Record<string, { input: number; output: number; cached: number }> = {
    'claude-sonnet-4-6':  { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-opus-4-6':    { input: 15.0, output: 75.0, cached: 1.5 },
    'claude-haiku-4-5':   { input: 0.8, output: 4.0, cached: 0.08 },
  };

  const p = pricing[model] ?? pricing['claude-sonnet-4-6'];
  const uncachedInput = inputTokens - cachedTokens;

  return (
    (uncachedInput / 1_000_000) * p.input +
    (cachedTokens / 1_000_000) * p.cached +
    (outputTokens / 1_000_000) * p.output
  );
}
