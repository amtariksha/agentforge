import type { FastifyInstance } from 'fastify';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { conversations, humanAgents, messages as messagesTable } from '../../shared/schema/index.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';
import { redis } from '../../shared/redis.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'live-chat' });

// WebSocket connections tracked in Redis
const WS_CONNECTIONS = new Map<string, Set<WebSocket>>();

/**
 * Assign conversation to an operator.
 * Uses skill-based routing: match ticket/conversation type to agent skills.
 * Falls back to least-loaded agent.
 */
export async function assignToOperator(
  tenantId: string,
  conversationId: string,
  requiredSkill?: string,
): Promise<string | null> {
  // Find online operators with capacity
  const operators = await db
    .select()
    .from(humanAgents)
    .where(and(
      eq(humanAgents.tenantId, tenantId),
      eq(humanAgents.isActive, true),
      eq(humanAgents.status, 'online'),
    ));

  if (operators.length === 0) return null;

  // Filter by skill if required
  let candidates = operators;
  if (requiredSkill) {
    const skilled = operators.filter(op => op.skills?.includes(requiredSkill));
    if (skilled.length > 0) candidates = skilled;
  }

  // Find least-loaded operator under their max concurrent limit
  // Count active assignments from Redis
  let bestOperator = null;
  let lowestLoad = Infinity;

  for (const op of candidates) {
    const activeCount = parseInt(await redis.get(`operator:${op.id}:active_chats`) ?? '0', 10);
    if (activeCount < (op.maxConcurrentChats ?? 5) && activeCount < lowestLoad) {
      bestOperator = op;
      lowestLoad = activeCount;
    }
  }

  if (!bestOperator) return null;

  // Assign
  await db.update(conversations)
    .set({ currentOperatorId: bestOperator.id, status: 'handoff' })
    .where(eq(conversations.id, conversationId));

  await redis.incr(`operator:${bestOperator.id}:active_chats`);

  log.info({ operatorId: bestOperator.id, conversationId }, 'Conversation assigned to operator');
  return bestOperator.id;
}

/**
 * Release operator from conversation.
 */
export async function releaseOperator(operatorId: string, conversationId: string) {
  await redis.decr(`operator:${operatorId}:active_chats`);

  await db.update(conversations)
    .set({ currentOperatorId: null, status: 'active' })
    .where(eq(conversations.id, conversationId));
}

export async function liveChatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // Get handoff queue for tenant
  app.get<{ Params: { tenantId: string } }>(
    '/admin/live-chat/queue/:tenantId',
    async (request, reply) => {
      const queue = await db
        .select({
          id: conversations.id,
          userId: conversations.userId,
          channel: conversations.channel,
          currentAgentType: conversations.currentAgentType,
          messageCount: conversations.messageCount,
          lastMessageAt: conversations.lastMessageAt,
        })
        .from(conversations)
        .where(and(
          eq(conversations.tenantId, request.params.tenantId),
          eq(conversations.status, 'handoff'),
        ))
        .orderBy(asc(conversations.lastMessageAt));

      return reply.send(queue);
    },
  );

  // Assign conversation to operator
  app.post<{ Params: { conversationId: string }; Body: { operatorId?: string } }>(
    '/admin/live-chat/:conversationId/assign',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;
      const operatorId = request.body.operatorId ?? auth.agentId;

      await db.update(conversations)
        .set({ currentOperatorId: operatorId, status: 'handoff' })
        .where(eq(conversations.id, request.params.conversationId));

      await redis.incr(`operator:${operatorId}:active_chats`);

      return reply.send({ assigned: true, operatorId });
    },
  );

  // Resolve / close handoff — agent resumes
  app.post<{ Params: { conversationId: string } }>(
    '/admin/live-chat/:conversationId/resolve',
    async (request, reply) => {
      const [convo] = await db
        .select({ currentOperatorId: conversations.currentOperatorId })
        .from(conversations)
        .where(eq(conversations.id, request.params.conversationId))
        .limit(1);

      if (convo?.currentOperatorId) {
        await redis.decr(`operator:${convo.currentOperatorId}:active_chats`);
      }

      await db.update(conversations)
        .set({ currentOperatorId: null, status: 'active' })
        .where(eq(conversations.id, request.params.conversationId));

      return reply.send({ resolved: true });
    },
  );

  // Operator takeover
  app.post<{ Params: { id: string } }>(
    '/admin/conversations/:id/takeover',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;

      await db.update(conversations)
        .set({ currentOperatorId: auth.agentId, status: 'handoff' })
        .where(eq(conversations.id, request.params.id));

      await redis.incr(`operator:${auth.agentId}:active_chats`);

      return reply.send({ takenOver: true, operatorId: auth.agentId });
    },
  );

  // Whisper: send hidden instruction to agent (injected into next prompt)
  app.post<{ Params: { id: string }; Body: { instruction: string } }>(
    '/admin/conversations/:id/whisper',
    async (request, reply) => {
      const { instruction } = request.body;

      // Store whisper in session state
      const [convo] = await db.select({ sessionState: conversations.sessionState })
        .from(conversations)
        .where(eq(conversations.id, request.params.id))
        .limit(1);

      const state = (convo?.sessionState as Record<string, unknown>) ?? {};
      const whispers = (state['whispers'] as string[]) ?? [];
      whispers.push(instruction);

      await db.update(conversations)
        .set({ sessionState: { ...state, whispers } })
        .where(eq(conversations.id, request.params.id));

      return reply.send({ whispered: true });
    },
  );

  // Operator sends message directly
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/admin/conversations/:id/send',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;
      const { text } = request.body;

      await db.insert(messagesTable).values({
        conversationId: request.params.id,
        tenantId: auth.tenantId,
        senderType: 'operator',
        content: { type: 'text', text },
        metadata: { operatorId: auth.agentId },
      });

      // TODO: Send via channel adapter (WhatsApp, etc.)

      return reply.send({ sent: true });
    },
  );

  // Close conversation
  app.post<{ Params: { id: string } }>(
    '/admin/conversations/:id/close',
    async (request, reply) => {
      const [convo] = await db
        .select({ currentOperatorId: conversations.currentOperatorId })
        .from(conversations)
        .where(eq(conversations.id, request.params.id))
        .limit(1);

      if (convo?.currentOperatorId) {
        await redis.decr(`operator:${convo.currentOperatorId}:active_chats`);
      }

      await db.update(conversations)
        .set({ status: 'closed', closedAt: new Date(), currentOperatorId: null })
        .where(eq(conversations.id, request.params.id));

      return reply.send({ closed: true });
    },
  );
}
