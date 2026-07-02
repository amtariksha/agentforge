import type { FastifyInstance, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { resolveTenantBySlug } from '../admin/tenants/routes.js';
import { processMessage } from '../orchestrator/agent-loop.js';
import { createChildLogger } from '../shared/utils/logger.js';
import type { UnifiedMessage } from '../shared/types/index.js';

const log = createChildLogger({ module: 'websocket' });

interface WsMessage {
  type: 'message' | 'ping';
  text?: string;
  userId?: string;
}

// WebSocket interface (from @fastify/websocket)
interface WsSocket {
  send(data: string): void;
  close(): void;
  on(event: 'message', handler: (data: Buffer | ArrayBuffer | Buffer[]) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

/**
 * WebSocket handler for web widget real-time chat.
 * Endpoint: WS /ws/chat/:tenantSlug
 */
export async function websocketRoutes(app: FastifyInstance) {
  // Register websocket route using type assertion for the websocket option
  (app as unknown as {
    get(path: string, opts: { websocket: true }, handler: (socket: WsSocket, request: FastifyRequest) => void): void;
  }).get(
    '/ws/chat/:tenantSlug',
    { websocket: true },
    async (socket: WsSocket, request: FastifyRequest) => {
      const tenantSlug = (request.params as { tenantSlug: string }).tenantSlug;
      const tenant = await resolveTenantBySlug(tenantSlug);

      if (!tenant) {
        socket.send(JSON.stringify({ type: 'error', message: 'Tenant not found' }));
        socket.close();
        return;
      }

      let userId = `ws_${uuidv4().slice(0, 8)}`;
      const sessionId = uuidv4();

      log.info({ tenantId: tenant.id, sessionId }, 'WebSocket connection opened');

      socket.send(JSON.stringify({
        type: 'greeting',
        text: tenant.config.persona.introduction,
        sessionId,
      }));

      socket.on('message', async (raw) => {
        try {
          const data = JSON.parse(raw.toString()) as WsMessage;

          if (data.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          if (data.type === 'message' && data.text?.trim()) {
            if (data.userId) userId = data.userId;

            const unified: UnifiedMessage = {
              id: uuidv4(),
              tenantId: tenant.id,
              channel: 'web',
              channelMessageId: uuidv4(),
              sender: { platformUserId: userId },
              content: { type: 'text', text: data.text },
              metadata: { timestamp: new Date() },
            };

            socket.send(JSON.stringify({ type: 'typing', isTyping: true }));
            // Sink pushes the agent's reply back to the widget. Without it the
            // web channel has no delivery path (WhatsApp/Telegram use senders).
            await processMessage(unified, tenant.id, tenant.config, (evt) => {
              if (evt.type === 'ui') {
                socket.send(JSON.stringify({ type: 'ui', blocks: evt.blocks }));
              } else {
                socket.send(JSON.stringify({ type: 'response', text: evt.text }));
              }
            });
            socket.send(JSON.stringify({ type: 'typing', isTyping: false }));
          }
        } catch (err) {
          log.error({ err }, 'WebSocket message processing error');
          socket.send(JSON.stringify({ type: 'error', message: 'Processing error' }));
        }
      });

      socket.on('close', () => {
        log.info({ sessionId }, 'WebSocket connection closed');
      });

      socket.on('error', (err: Error) => {
        log.error({ err, sessionId }, 'WebSocket error');
      });
    },
  );
}
