import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { conversations, messages as messagesTable, users } from '../../shared/schema/index.js';
import { paginationSchema } from '../../shared/validators/index.js';
import { authMiddleware } from '../../shared/middleware/auth.js';

export async function conversationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List conversations (filterable by tenant, status, channel)
  app.get<{ Querystring: Record<string, string> }>(
    '/admin/conversations',
    async (request, reply) => {
      const { page, limit } = paginationSchema.parse(request.query);
      const tenantId = request.query['tenantId'];
      const status = request.query['status'];
      const channel = request.query['channel'];

      const conditions = [];
      if (tenantId) conditions.push(eq(conversations.tenantId, tenantId));
      if (status) conditions.push(eq(conversations.status, status));
      if (channel) conditions.push(eq(conversations.channel, channel));

      const result = await db
        .select({
          id: conversations.id,
          tenantId: conversations.tenantId,
          userId: conversations.userId,
          channel: conversations.channel,
          status: conversations.status,
          currentAgentType: conversations.currentAgentType,
          messageCount: conversations.messageCount,
          confidenceAvg: conversations.confidenceAvg,
          startedAt: conversations.startedAt,
          lastMessageAt: conversations.lastMessageAt,
        })
        .from(conversations)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(conversations.lastMessageAt))
        .limit(limit)
        .offset((page - 1) * limit);

      return reply.send({ conversations: result, page, limit });
    },
  );

  // Get conversation with messages
  app.get<{ Params: { id: string } }>(
    '/admin/conversations/:id',
    async (request, reply) => {
      const [convo] = await db.select().from(conversations)
        .where(eq(conversations.id, request.params.id))
        .limit(1);

      if (!convo) return reply.status(404).send({ error: 'Conversation not found' });

      const msgs = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, request.params.id))
        .orderBy(messagesTable.createdAt);

      // Get user info
      const [user] = await db.select({
        displayName: users.displayName,
        platformUserId: users.platformUserId,
        platform: users.platform,
      }).from(users).where(eq(users.id, convo.userId)).limit(1);

      return reply.send({ ...convo, user, messages: msgs });
    },
  );
}
