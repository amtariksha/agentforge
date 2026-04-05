import { redis } from '../../shared/redis.js';
import { createChildLogger } from '../../shared/utils/logger.js';
import type { TenantConfig } from '../../shared/types/index.js';

const log = createChildLogger({ module: 'wa-coexistence' });

const OPERATOR_PAUSE_KEY_PREFIX = 'wa:operator_pause:';

/**
 * WhatsApp Coexistence: Cloud API (agent) + Business App (operator) on the same number.
 *
 * When an operator sends a message via the WhatsApp Business App:
 * 1. The webhook receives the message with metadata indicating it's from the business
 * 2. We detect this as an "echo" and skip agent processing
 * 3. We pause the agent for that user for N minutes (operator_pause_minutes)
 *
 * During the pause window, incoming user messages are NOT processed by the agent —
 * the operator is handling the conversation manually.
 */

/**
 * Check if agent is paused for a user (operator took over via Business App).
 */
export async function isAgentPaused(tenantId: string, userPhone: string): Promise<boolean> {
  const key = `${OPERATOR_PAUSE_KEY_PREFIX}${tenantId}:${userPhone}`;
  const paused = await redis.exists(key);
  return paused === 1;
}

/**
 * Pause agent for a user after operator sends via Business App.
 */
export async function pauseAgent(
  tenantId: string,
  userPhone: string,
  config: TenantConfig,
): Promise<void> {
  const pauseMinutes = config.channels.whatsapp?.operatorPauseMinutes ?? 30;
  const key = `${OPERATOR_PAUSE_KEY_PREFIX}${tenantId}:${userPhone}`;

  await redis.setex(key, pauseMinutes * 60, '1');
  log.info({ tenantId, userPhone, pauseMinutes }, 'Agent paused — operator took over');
}

/**
 * Resume agent for a user (manual override).
 */
export async function resumeAgent(tenantId: string, userPhone: string): Promise<void> {
  const key = `${OPERATOR_PAUSE_KEY_PREFIX}${tenantId}:${userPhone}`;
  await redis.del(key);
  log.info({ tenantId, userPhone }, 'Agent resumed');
}

/**
 * Detect if a webhook message is an echo from the business number itself.
 * When coexistence is enabled, messages sent via the Business App appear as
 * incoming webhook events but with specific metadata indicating they're outbound.
 */
export function isEchoMessage(
  webhookValue: Record<string, unknown>,
  config: TenantConfig,
): boolean {
  if (!config.channels.whatsapp?.coexistenceEnabled) return false;

  // Check statuses array — operator messages appear as status updates
  const statuses = webhookValue['statuses'] as Array<Record<string, unknown>> | undefined;
  if (statuses && statuses.length > 0) {
    // Status updates from outbound messages are normal, not echoes
    return false;
  }

  // Check if the message is from the business phone number itself
  const metadata = webhookValue['metadata'] as Record<string, string> | undefined;
  const messages = webhookValue['messages'] as Array<Record<string, unknown>> | undefined;

  if (metadata && messages) {
    const businessPhone = metadata['display_phone_number']?.replace(/\D/g, '');
    for (const msg of messages) {
      const from = String(msg['from'] ?? '').replace(/\D/g, '');
      if (from && businessPhone && from === businessPhone) {
        return true;
      }
    }
  }

  return false;
}
