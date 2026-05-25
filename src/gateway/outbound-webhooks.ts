import { createHmac } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { webhookConfigs } from '../shared/schema/index.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'outbound-webhooks' });

export type WebhookEvent =
  | 'conversation_started'
  | 'conversation_closed'
  | 'ticket_created'
  | 'handoff_triggered'
  | 'order_placed'
  | 'correction_applied'
  | 'lead_captured'
  | 'agent_run.completed';

interface WebhookPayload {
  event: WebhookEvent;
  tenantId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Fire outbound webhooks for a tenant event.
 * Non-blocking — failures are logged but don't affect the caller.
 */
export async function fireWebhooks(
  tenantId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const configs = await db
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.isActive, true)));

  const matching = configs.filter(c => c.events?.includes(event));
  if (matching.length === 0) return;

  const payload: WebhookPayload = {
    event,
    tenantId,
    timestamp: new Date().toISOString(),
    data,
  };

  const body = JSON.stringify(payload);

  for (const config of matching) {
    deliverWebhook(config.url, body, config.secret).catch((err) => {
      log.error({ err, url: config.url, event }, 'Outbound webhook delivery failed');
    });
  }
}

async function deliverWebhook(url: string, body: string, secret: string | null): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'AgentForge/1.0',
  };

  // Sign payload if secret is configured
  if (secret) {
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-AgentForge-Signature'] = `sha256=${signature}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10000), // 10s timeout
  });

  if (!response.ok) {
    log.warn({ url, status: response.status }, 'Outbound webhook non-200 response');
  } else {
    log.debug({ url }, 'Outbound webhook delivered');
  }
}
