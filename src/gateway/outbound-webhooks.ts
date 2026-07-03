import { createHmac } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { webhookConfigs } from '../shared/schema/index.js';
import { webhookDeliveryQueue } from '../shared/queue.js';
import { createChildLogger } from '../shared/utils/logger.js';
import type { WebhookEvent } from './webhook-events.js';

const log = createChildLogger({ module: 'outbound-webhooks' });

export type { WebhookEvent } from './webhook-events.js';
export { WEBHOOK_EVENTS } from './webhook-events.js';

export interface WebhookEnvelope {
  event: WebhookEvent;
  tenantId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Enqueue outbound webhooks for a tenant event. Delivery is durable (BullMQ,
 * retried) rather than fire-and-forget: matching configs are resolved here, but
 * only { webhookConfigId, envelope } is put on the queue — the worker re-fetches
 * url/secret at delivery time, so secrets never live in Redis job data and
 * secret rotation applies between retries. Non-blocking for the caller.
 */
export async function fireWebhooks(
  tenantId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const configs = await db
    .select({ id: webhookConfigs.id, events: webhookConfigs.events })
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.isActive, true)));

  const matching = configs.filter((c) => c.events?.includes(event));
  if (matching.length === 0) return;

  const envelope: WebhookEnvelope = {
    event,
    tenantId,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const config of matching) {
    await webhookDeliveryQueue
      .add(
        'deliver',
        { webhookConfigId: config.id, envelope },
        { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: 100 },
      )
      .catch((err) => log.error({ err, event }, 'Failed to enqueue webhook delivery'));
  }
}

/**
 * Deliver one webhook. Called by the webhook-delivery worker. Re-fetches the
 * config so a deactivated/removed endpoint is dropped and secret rotations take
 * effect. Throws on a non-2xx response so BullMQ retries.
 */
export async function deliverWebhookById(webhookConfigId: string, envelope: WebhookEnvelope): Promise<void> {
  const [config] = await db
    .select()
    .from(webhookConfigs)
    .where(eq(webhookConfigs.id, webhookConfigId))
    .limit(1);

  if (!config || !config.isActive) {
    log.debug({ webhookConfigId }, 'Webhook config missing/inactive — dropping delivery');
    return;
  }

  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'AgentForge/1.0',
  };
  if (config.secret) {
    const signature = createHmac('sha256', config.secret).update(body).digest('hex');
    headers['X-AgentForge-Signature'] = `sha256=${signature}`;
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    // Throw so BullMQ retries with backoff.
    throw new Error(`Webhook ${config.url} returned ${response.status}`);
  }
  log.debug({ url: config.url, event: envelope.event }, 'Outbound webhook delivered');
}
