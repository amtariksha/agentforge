import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, desc } from 'drizzle-orm';
import { resolveTenantBySlug } from '../../admin/tenants/routes.js';
import { processMessage } from '../../orchestrator/agent-loop.js';
import { db } from '../../shared/db.js';
import { conversations, messages as messagesTable } from '../../shared/schema/index.js';
import { createChildLogger } from '../../shared/utils/logger.js';
import type { UnifiedMessage } from '../../shared/types/index.js';

const log = createChildLogger({ module: 'mobile-api' });

export async function mobileApiRoutes(app: FastifyInstance) {
  // Send message (synchronous — wait for response)
  app.post<{
    Params: { tenantSlug: string };
    Body: { userId: string; text: string; sessionId?: string };
  }>('/api/v1/chat/:tenantSlug', async (request, reply) => {
    const tenant = await resolveTenantBySlug(request.params.tenantSlug);
    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    const { userId, text, sessionId } = request.body;
    if (!userId || !text?.trim()) {
      return reply.status(400).send({ error: 'userId and text are required' });
    }

    const unified: UnifiedMessage = {
      id: uuidv4(),
      tenantId: tenant.id,
      channel: 'app',
      channelMessageId: uuidv4(),
      sender: { platformUserId: userId },
      content: { type: 'text', text },
      metadata: { timestamp: new Date() },
    };

    // Process synchronously for mobile API
    try {
      await processMessage(unified, tenant.id, tenant.config);

      // Fetch the last agent message from the conversation
      const [lastAgentMsg] = await db
        .select({ content: messagesTable.content, createdAt: messagesTable.createdAt })
        .from(messagesTable)
        .innerJoin(conversations, eq(conversations.id, messagesTable.conversationId))
        .where(and(
          eq(conversations.tenantId, tenant.id),
          eq(messagesTable.senderType, 'agent'),
        ))
        .orderBy(desc(messagesTable.createdAt))
        .limit(1);

      const responseText = (lastAgentMsg?.content as { text?: string })?.text ?? '';

      return reply.send({
        success: true,
        data: { text: responseText, timestamp: new Date().toISOString() },
      });
    } catch (err) {
      log.error({ err }, 'Mobile API processing failed');
      return reply.status(500).send({
        success: false,
        error: { code: 'PROCESSING_ERROR', message: 'Failed to process message' },
      });
    }
  });

  // Get conversation history
  app.get<{
    Params: { tenantSlug: string };
    Querystring: { userId: string; limit?: string };
  }>('/api/v1/chat/:tenantSlug/history', async (request, reply) => {
    const tenant = await resolveTenantBySlug(request.params.tenantSlug);
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    const { userId } = request.query;
    const limit = parseInt(request.query.limit ?? '50', 10);

    if (!userId) return reply.status(400).send({ error: 'userId is required' });

    const msgs = await db
      .select({
        id: messagesTable.id,
        senderType: messagesTable.senderType,
        content: messagesTable.content,
        createdAt: messagesTable.createdAt,
      })
      .from(messagesTable)
      .innerJoin(conversations, eq(conversations.id, messagesTable.conversationId))
      .where(and(
        eq(conversations.tenantId, tenant.id),
        eq(conversations.status, 'active'),
      ))
      .orderBy(desc(messagesTable.createdAt))
      .limit(limit);

    return reply.send({
      success: true,
      data: { messages: msgs.reverse() },
    });
  });
}
