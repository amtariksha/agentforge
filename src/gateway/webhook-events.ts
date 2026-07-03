/**
 * Canonical outbound-webhook event names. Kept dependency-free (no queue/db) so
 * both the dispatcher (outbound-webhooks.ts) and the subscription validator
 * (shared/validators) can import it without pulling in BullMQ.
 */
export type WebhookEvent =
  | 'conversation_started'
  | 'conversation_closed'
  | 'ticket_created'
  | 'handoff_triggered'
  | 'order_placed'
  | 'correction_applied'
  | 'lead_captured'
  | 'agent_run.completed'
  // Billing (M3)
  | 'budget.threshold_reached'
  | 'budget.exceeded'
  | 'wallet.low_balance'
  | 'wallet.paused'
  | 'invoice.generated';

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  'conversation_started',
  'conversation_closed',
  'ticket_created',
  'handoff_triggered',
  'order_placed',
  'correction_applied',
  'lead_captured',
  'agent_run.completed',
  'budget.threshold_reached',
  'budget.exceeded',
  'wallet.low_balance',
  'wallet.paused',
  'invoice.generated',
];
