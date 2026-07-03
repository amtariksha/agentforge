import { db } from '../shared/db.js';
import { notifications } from '../shared/schema/index.js';
import { fireWebhooks } from '../gateway/outbound-webhooks.js';
import type { WebhookEvent } from '../gateway/outbound-webhooks.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'billing-alerts' });

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface RaiseAlertInput {
  tenantId: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
  /** Dedupe key: an insert conflict on (tenant, key) suppresses BOTH channels. */
  dedupeKey?: string;
  /** If set, also fire this webhook — but only when the notification was newly inserted. */
  webhookEvent?: WebhookEvent;
  /** Webhook payload; ids/numbers only — never message text or PII. */
  webhookData?: Record<string, unknown>;
}

/**
 * Raise an alert: insert an in-app notification (deduped on the tenant+key
 * unique index) and, only when that insert actually happened, enqueue the paired
 * webhook. The notification row is the single dedupe gate for both channels, so
 * a threshold fires exactly once per episode. A NULL dedupeKey never dedupes.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<{ raised: boolean }> {
  const inserted = await db
    .insert(notifications)
    .values({
      tenantId: input.tenantId,
      type: input.type,
      severity: input.severity,
      title: input.title,
      body: input.body ?? null,
      metadata: input.metadata ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: [notifications.tenantId, notifications.dedupeKey] })
    .returning({ id: notifications.id });

  if (inserted.length === 0) {
    return { raised: false }; // deduped — already alerted this episode
  }

  if (input.webhookEvent) {
    await fireWebhooks(input.tenantId, input.webhookEvent, input.webhookData ?? input.metadata ?? {}).catch((err) =>
      log.error({ err, event: input.webhookEvent }, 'Alert webhook enqueue failed'),
    );
  }
  return { raised: true };
}
