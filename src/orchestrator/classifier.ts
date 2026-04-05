import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '../shared/utils/logger.js';
import type { IntentClassification, TenantConfig } from '../shared/types/index.js';

const log = createChildLogger({ module: 'classifier' });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ClassifierInput {
  userMessage: string;
  conversationContext?: string;
  agentTypes: Array<{
    slug: string;
    name: string;
    description: string;
    intentKeywords: string[];
    intentExamples: string[];
  }>;
  tenantConfig: TenantConfig;
}

export async function classifyIntent(input: ClassifierInput): Promise<IntentClassification> {
  const startTime = Date.now();
  const routingModel = input.tenantConfig.ai.routingModel ?? 'claude-haiku-4-5';

  const agentDescriptions = input.agentTypes.map(a =>
    `- "${a.slug}" (${a.name}): ${a.description}. Keywords: ${a.intentKeywords.join(', ')}. Examples: ${a.intentExamples.slice(0, 3).join('; ')}`
  ).join('\n');

  const systemPrompt = `You are an intent classifier. Analyze the user message and return a JSON object with these fields:
- intent: string (e.g., "order_status", "complaint", "greeting", "product_inquiry")
- agent_type: string (one of the agent slugs below)
- complexity: "simple" | "medium" | "complex"
- confidence: number 0-1
- requires_backend_data: boolean
- requires_hitl: boolean
- requires_rag: boolean
- suggested_tools: string[] (tool names the agent might need)
- language_detected: string (ISO 639-1 code, e.g., "en", "hi", "kn")
- sentiment: "positive" | "neutral" | "negative" | "angry"

Available agent types:
${agentDescriptions}

Rules:
- Simple: greetings, FAQs, single-fact lookups
- Medium: multi-step operations, order tracking, subscription changes
- Complex: complaints with emotional content, multi-issue messages, ambiguous requests
- Set requires_hitl=true for: angry sentiment, destructive requests, low confidence (<0.4)
- Set requires_rag=true when the question seems like a knowledge base query (policies, how-to, product info not in tools)

Return ONLY valid JSON, no markdown fences.`;

  try {
    const response = await anthropic.messages.create({
      model: routingModel,
      max_tokens: 300,
      temperature: 0,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: input.conversationContext
            ? `Recent context: ${input.conversationContext}\n\nNew message: ${input.userMessage}`
            : input.userMessage,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const parsed = JSON.parse(text);
    const classificationMs = Date.now() - startTime;

    const classification: IntentClassification = {
      intent: parsed.intent ?? 'general',
      agentType: parsed.agent_type ?? input.agentTypes.find(a => a.slug === 'support')?.slug ?? input.agentTypes[0]?.slug ?? 'support',
      complexity: parsed.complexity ?? 'medium',
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      requiresBackendData: parsed.requires_backend_data ?? false,
      requiresHitl: parsed.requires_hitl ?? false,
      requiresRag: parsed.requires_rag ?? false,
      suggestedTools: parsed.suggested_tools ?? [],
      languageDetected: parsed.language_detected ?? 'en',
      sentiment: parsed.sentiment ?? 'neutral',
    };

    log.info({
      intent: classification.intent,
      agentType: classification.agentType,
      complexity: classification.complexity,
      confidence: classification.confidence,
      sentiment: classification.sentiment,
      classificationMs,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    }, 'Intent classified');

    return classification;
  } catch (err) {
    log.error({ err }, 'Classification failed, using defaults');

    // Fallback: default agent, medium complexity
    return {
      intent: 'general',
      agentType: input.agentTypes.find(a => a.slug === 'support')?.slug ?? input.agentTypes[0]?.slug ?? 'support',
      complexity: 'medium',
      confidence: 0.3,
      requiresBackendData: false,
      requiresHitl: false,
      requiresRag: false,
      suggestedTools: [],
      languageDetected: 'en',
      sentiment: 'neutral',
    };
  }
}

/**
 * Select model based on classification complexity + sentiment
 * Haiku: simple queries, greetings
 * Sonnet: standard operations
 * Opus: complex/angry/low-confidence
 */
export function selectModel(
  classification: IntentClassification,
  tenantConfig: TenantConfig,
  agentModelOverride?: string | null,
): string {
  // Agent-level override takes precedence
  if (agentModelOverride) return agentModelOverride;

  const { complexity, sentiment, confidence } = classification;

  // Opus for complex, angry, or low-confidence
  if (
    complexity === 'complex' ||
    sentiment === 'angry' ||
    confidence < (tenantConfig.orchestrator.confidenceThreshold ?? 0.4)
  ) {
    return tenantConfig.ai.premiumModel ?? 'claude-opus-4-6';
  }

  // Haiku for simple, positive/neutral
  if (complexity === 'simple' && (sentiment === 'positive' || sentiment === 'neutral')) {
    return tenantConfig.ai.routingModel ?? 'claude-haiku-4-5';
  }

  // Sonnet for everything else
  return tenantConfig.ai.primaryModel ?? 'claude-sonnet-4-6';
}
