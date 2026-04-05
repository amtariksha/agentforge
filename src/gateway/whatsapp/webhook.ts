import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac } from 'node:crypto';
import { resolveTenantBySlug } from '../../admin/tenants/routes.js';
import { normalizeWhatsAppMessage } from '../normalizer.js';
import { processMessage } from '../../orchestrator/agent-loop.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'whatsapp-webhook' });

interface WebhookParams {
  tenantSlug: string;
}

export async function whatsappWebhookRoutes(app: FastifyInstance) {
  // Verification endpoint
  app.get<{ Params: WebhookParams; Querystring: Record<string, string> }>(
    '/webhooks/whatsapp/:tenantSlug',
    async (request, reply) => {
      const mode = request.query['hub.mode'];
      const token = request.query['hub.verify_token'];
      const challenge = request.query['hub.challenge'];

      const tenant = await resolveTenantBySlug(request.params.tenantSlug);
      if (!tenant) {
        return reply.status(404).send('Tenant not found');
      }

      const expectedToken = tenant.config.channels.whatsapp?.webhookVerifyToken;
      if (mode === 'subscribe' && token === expectedToken) {
        log.info({ tenantSlug: request.params.tenantSlug }, 'WhatsApp webhook verified');
        return reply.status(200).send(challenge);
      }

      return reply.status(403).send('Verification failed');
    },
  );

  // Receive messages
  app.post<{ Params: WebhookParams }>(
    '/webhooks/whatsapp/:tenantSlug',
    async (request, reply) => {
      // Always respond 200 quickly to WhatsApp
      reply.status(200).send('OK');

      const tenant = await resolveTenantBySlug(request.params.tenantSlug);
      if (!tenant) {
        log.warn({ tenantSlug: request.params.tenantSlug }, 'Webhook for unknown tenant');
        return;
      }

      // Verify signature
      const appSecret = tenant.config.channels.whatsapp?.appSecret;
      if (appSecret) {
        const signature = request.headers['x-hub-signature-256'] as string | undefined;
        if (!verifySignature(request.body, appSecret, signature)) {
          log.warn({ tenantSlug: request.params.tenantSlug }, 'Invalid webhook signature');
          return;
        }
      }

      const body = request.body as WhatsAppWebhookBody;

      // Process each entry
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== 'messages') continue;

          const value = change.value;
          if (!value.messages) continue;

          // Echo detection: skip messages from the business phone itself
          const metadata = value.metadata;
          for (const rawMsg of value.messages) {
            const msg = rawMsg as Record<string, unknown>;
            // Skip status updates (they come as messages with statuses)
            if (!msg['type']) continue;

            // Echo detection: if sender is the business phone number, skip
            if (msg['from'] === metadata?.display_phone_number?.replace(/\D/g, '')) {
              log.debug({ from: msg['from'] }, 'Skipping echo message from business number');
              continue;
            }

            const contact = value.contacts?.[0];
            // Cast to the normalizer's expected shape
            const unified = normalizeWhatsAppMessage(
              msg as unknown as Parameters<typeof normalizeWhatsAppMessage>[0],
              contact,
              tenant.id,
            );

            log.info({
              tenantId: tenant.id,
              messageId: unified.id,
              from: unified.sender.platformUserId,
              type: unified.content.type,
            }, 'Processing WhatsApp message');

            // Process asynchronously — don't block the webhook response
            processMessage(unified, tenant.id, tenant.config).catch((err) => {
              log.error({ err, messageId: unified.id }, 'Failed to process message');
            });
          }

          // Handle status updates
          for (const status of value.statuses ?? []) {
            log.debug({
              messageId: status.id,
              status: status.status,
              recipientId: status.recipient_id,
            }, 'WhatsApp status update');
          }
        }
      }
    },
  );
}

function verifySignature(body: unknown, appSecret: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expectedSignature = 'sha256=' + createHmac('sha256', appSecret)
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('hex');
  return signature === expectedSignature;
}

// WhatsApp webhook body types
interface WhatsAppWebhookBody {
  object: string;
  entry?: Array<{
    id: string;
    changes: Array<{
      field: string;
      value: {
        messaging_product: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: Array<Record<string, unknown>>;
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
    }>;
  }>;
}
