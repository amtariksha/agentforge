import { db } from '../../shared/db.js';
import { tickets, conversations } from '../../shared/schema/index.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '../../shared/utils/logger.js';
import type { IntentClassification, TenantConfig } from '../../shared/types/index.js';
import { redis } from '../../shared/redis.js';

const log = createChildLogger({ module: 'escalation' });

interface EscalationContext {
  tenantId: string;
  conversationId: string;
  userId: string;
  classification?: IntentClassification;
  messageText: string;
  messageCount: number;
  consecutiveToolFailures?: number;
}

export interface EscalationResult {
  shouldEscalate: boolean;
  reasons: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  ticketType: string;
}

/**
 * Evaluate all escalation triggers and determine if conversation should be escalated.
 */
export function evaluateEscalation(
  ctx: EscalationContext,
  config: TenantConfig,
): EscalationResult {
  const reasons: string[] = [];
  let priority: 'low' | 'medium' | 'high' | 'critical' = 'medium';

  const hitlConfig = config.hitl;
  const orchestratorConfig = config.orchestrator;

  // 1. Low confidence
  if (ctx.classification && ctx.classification.confidence < hitlConfig.autoEscalateConfidenceBelow) {
    reasons.push(`Low confidence: ${ctx.classification.confidence.toFixed(2)}`);
    priority = 'high';
  }

  // 2. Angry sentiment
  if (orchestratorConfig.handoffOnNegativeSentiment && ctx.classification?.sentiment === 'angry') {
    reasons.push('Angry sentiment detected');
    priority = 'critical';
  }

  // 3. User requests human
  if (orchestratorConfig.handoffOnUserRequest) {
    const text = ctx.messageText.toLowerCase();
    const keywords = orchestratorConfig.handoffKeywords ?? ['human', 'manager', 'representative'];
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        reasons.push(`User requested human: "${keyword}"`);
        priority = 'high';
        break;
      }
    }
  }

  // 4. Escalation topics
  if (ctx.classification?.intent) {
    for (const topic of hitlConfig.autoEscalateTopics ?? []) {
      if (ctx.classification.intent.includes(topic)) {
        reasons.push(`Escalation topic: ${topic}`);
        priority = 'high';
        break;
      }
    }
  }

  // 5. Consecutive tool failures
  if (ctx.consecutiveToolFailures && ctx.consecutiveToolFailures >= 3) {
    reasons.push(`${ctx.consecutiveToolFailures} consecutive tool failures`);
    priority = 'high';
  }

  // 6. Conversation too long without resolution
  const maxTurns = config.context?.maxConversationTurns ?? 50;
  if (ctx.messageCount > maxTurns * 0.8) {
    reasons.push(`Conversation nearing limit: ${ctx.messageCount}/${maxTurns} turns`);
    priority = 'medium';
  }

  // 7. Destructive action detected
  if (ctx.classification?.requiresHitl) {
    reasons.push('HITL required by classification');
  }

  const shouldEscalate = reasons.length > 0;
  const ticketType = ctx.classification?.sentiment === 'angry' ? 'complaint' : 'inquiry';

  if (shouldEscalate) {
    log.info({ conversationId: ctx.conversationId, reasons, priority }, 'Escalation triggered');
  }

  return { shouldEscalate, reasons, priority, ticketType };
}

/**
 * Create escalation ticket and optionally pause the agent.
 */
export async function executeEscalation(
  ctx: EscalationContext,
  result: EscalationResult,
): Promise<string> {
  // Create ticket
  const [ticket] = await db.insert(tickets).values({
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    source: 'auto_escalation',
    type: result.ticketType,
    priority: result.priority,
    subject: `Auto-escalation: ${result.reasons[0]}`,
    description: result.reasons.join('; '),
  }).returning();

  log.info({ ticketId: ticket.id, priority: result.priority }, 'Escalation ticket created');

  return ticket.id;
}
