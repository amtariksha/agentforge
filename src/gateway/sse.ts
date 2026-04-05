import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantBySlug } from '../admin/tenants/routes.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'sse' });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * SSE streaming endpoint for web widget and mobile app.
 * POST /api/v1/chat/:tenantSlug/stream
 * Body: { sessionId, message, userId? }
 * Returns: SSE stream of tokens
 */
export async function sseRoutes(app: FastifyInstance) {
  app.post<{
    Params: { tenantSlug: string };
    Body: { sessionId: string; message: string; userId?: string };
  }>('/api/v1/chat/:tenantSlug/stream', async (request, reply) => {
    const tenant = await resolveTenantBySlug(request.params.tenantSlug);
    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    if (!tenant.config.channels.web?.widgetConfig?.enableStreaming) {
      return reply.status(400).send({ error: 'Streaming not enabled for this tenant' });
    }

    const { message } = request.body;
    if (!message?.trim()) {
      return reply.status(400).send({ error: 'Message is required' });
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    try {
      // For Phase 2: simplified streaming — full integration with agent loop comes later
      const model = tenant.config.ai.primaryModel ?? 'claude-sonnet-4-6';

      const stream = anthropic.messages.stream({
        model,
        max_tokens: tenant.config.ai.maxTokensPerResponse ?? 1024,
        temperature: tenant.config.ai.temperature ?? 0.7,
        system: `You are ${tenant.config.persona.name}. ${tenant.config.persona.definition}`,
        messages: [{ role: 'user', content: message }],
      });

      // Stream tokens as SSE events
      stream.on('text', (text) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: text })}\n\n`);
      });

      stream.on('message', (msg) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'done', usage: msg.usage })}\n\n`);
        reply.raw.end();
      });

      stream.on('error', (err) => {
        log.error({ err }, 'SSE stream error');
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream error' })}\n\n`);
        reply.raw.end();
      });

      // Handle client disconnect
      request.raw.on('close', () => {
        stream.abort();
      });

    } catch (err) {
      log.error({ err }, 'SSE endpoint error');
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal error' })}\n\n`);
      reply.raw.end();
    }
  });
}
