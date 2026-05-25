import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveTenantBySlug } from '../admin/tenants/routes.js';
import { serviceTokenMiddleware } from '../shared/middleware/service-token.js';
import { streamAgentBySlug, type StreamEvent } from '../orchestrator/agent-stream.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'sse' });

const StreamBodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  agentSlug: z.string().min(1),
  userId: z.string().optional(),
  requestId: z.string().optional(),
});

/**
 * SSE streaming endpoint for direct-by-slug agent invocation.
 *
 * POST /api/v1/chat/:tenantSlug/stream
 * Headers: Authorization: Bearer <AGENT_FORCE_SERVICE_TOKEN>
 * Body: { sessionId, message, agentSlug, userId?, requestId? }
 *
 * Emits SSE events with shapes defined in agent-stream.ts StreamEvent.
 */
export async function sseRoutes(app: FastifyInstance) {
  app.post<{ Params: { tenantSlug: string } }>(
    '/api/v1/chat/:tenantSlug/stream',
    { preHandler: serviceTokenMiddleware },
    async (request, reply) => {
      const tenant = await resolveTenantBySlug(request.params.tenantSlug);
      if (!tenant) {
        return reply.status(404).send({ error: 'Tenant not found' });
      }

      const parsed = StreamBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
      }
      const { sessionId, message, agentSlug, userId, requestId } = parsed.data;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const writeEvent = (event: StreamEvent) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (err) {
          log.warn({ err }, 'Failed to write SSE event');
        }
      };

      let clientClosed = false;
      request.raw.on('close', () => {
        clientClosed = true;
      });

      try {
        await streamAgentBySlug({
          tenantId: tenant.id,
          agentSlug,
          sessionId,
          userMessage: message,
          userId,
          requestId,
          onEvent: (event) => {
            if (!clientClosed) writeEvent(event);
          },
        });
      } catch (err) {
        log.error({ err, agentSlug, tenant: request.params.tenantSlug }, 'streamAgentBySlug threw');
        if (!clientClosed) {
          writeEvent({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        }
      } finally {
        if (!clientClosed) reply.raw.end();
      }
    },
  );
}
