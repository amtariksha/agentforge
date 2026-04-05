import type { FastifyInstance } from 'fastify';
import { eq, sql, and, gte } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { conversations, messages, tickets, llmUsageLogs, conversationTraces } from '../../shared/schema/index.js';
import { authMiddleware } from '../../shared/middleware/auth.js';

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // Overview dashboard
  app.get<{ Params: { tenantId: string }; Querystring: { days?: string } }>(
    '/admin/analytics/:tenantId/overview',
    async (request, reply) => {
      const { tenantId } = request.params;
      const days = parseInt(request.query.days ?? '30', 10);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [convStats] = await db.select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where status = 'active')`,
        avgMessages: sql<number>`avg(message_count)`,
      }).from(conversations).where(and(eq(conversations.tenantId, tenantId), gte(conversations.startedAt, since)));

      const [ticketStats] = await db.select({
        total: sql<number>`count(*)`,
        open: sql<number>`count(*) filter (where status = 'open' or status = 'in_progress')`,
        resolved: sql<number>`count(*) filter (where status = 'resolved' or status = 'closed')`,
        slaBreached: sql<number>`count(*) filter (where sla_breached = true)`,
      }).from(tickets).where(and(eq(tickets.tenantId, tenantId), gte(tickets.createdAt, since)));

      return reply.send({
        period: { days, since: since.toISOString() },
        conversations: convStats,
        tickets: ticketStats,
      });
    },
  );

  // Cost analytics
  app.get<{ Params: { tenantId: string }; Querystring: { days?: string } }>(
    '/admin/analytics/:tenantId/costs',
    async (request, reply) => {
      const { tenantId } = request.params;
      const days = parseInt(request.query.days ?? '30', 10);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [totals] = await db.select({
        totalCost: sql<string>`coalesce(sum(cost_usd), 0)`,
        totalInputTokens: sql<number>`coalesce(sum(tokens_input), 0)`,
        totalOutputTokens: sql<number>`coalesce(sum(tokens_output), 0)`,
        totalCachedTokens: sql<number>`coalesce(sum(tokens_cached), 0)`,
        callCount: sql<number>`count(*)`,
      }).from(llmUsageLogs).where(and(eq(llmUsageLogs.tenantId, tenantId), gte(llmUsageLogs.createdAt, since)));

      const byModel = await db.select({
        model: llmUsageLogs.model,
        cost: sql<string>`coalesce(sum(cost_usd), 0)`,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(tokens_input), 0)`,
        outputTokens: sql<number>`coalesce(sum(tokens_output), 0)`,
        cachedTokens: sql<number>`coalesce(sum(tokens_cached), 0)`,
      }).from(llmUsageLogs)
        .where(and(eq(llmUsageLogs.tenantId, tenantId), gte(llmUsageLogs.createdAt, since)))
        .groupBy(llmUsageLogs.model);

      const cacheHitRate = totals && Number(totals.totalInputTokens) > 0
        ? (Number(totals.totalCachedTokens) / Number(totals.totalInputTokens) * 100).toFixed(1)
        : '0';

      return reply.send({
        period: { days, since: since.toISOString() },
        totals: { ...totals, cacheHitRate: `${cacheHitRate}%` },
        byModel,
      });
    },
  );

  // Conversation analytics
  app.get<{ Params: { tenantId: string }; Querystring: { days?: string } }>(
    '/admin/analytics/:tenantId/conversations',
    async (request, reply) => {
      const { tenantId } = request.params;
      const days = parseInt(request.query.days ?? '30', 10);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const byChannel = await db.select({
        channel: conversations.channel,
        count: sql<number>`count(*)`,
      }).from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), gte(conversations.startedAt, since)))
        .groupBy(conversations.channel);

      const byAgentType = await db.select({
        agentType: conversations.currentAgentType,
        count: sql<number>`count(*)`,
      }).from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), gte(conversations.startedAt, since)))
        .groupBy(conversations.currentAgentType);

      return reply.send({
        period: { days, since: since.toISOString() },
        byChannel,
        byAgentType,
      });
    },
  );

  // HITL analytics
  app.get<{ Params: { tenantId: string }; Querystring: { days?: string } }>(
    '/admin/analytics/:tenantId/hitl',
    async (request, reply) => {
      const { tenantId } = request.params;
      const days = parseInt(request.query.days ?? '30', 10);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [escalationStats] = await db.select({
        total: sql<number>`count(*)`,
        autoEscalation: sql<number>`count(*) filter (where source = 'auto_escalation')`,
        userRequest: sql<number>`count(*) filter (where source = 'user_request')`,
        guardrailFlag: sql<number>`count(*) filter (where source = 'guardrail_flag')`,
      }).from(tickets).where(and(eq(tickets.tenantId, tenantId), gte(tickets.createdAt, since)));

      return reply.send({
        period: { days, since: since.toISOString() },
        escalations: escalationStats,
      });
    },
  );

  // System-wide overview (super admin)
  app.get('/admin/analytics/system-overview', async (_request, reply) => {
    const [totals] = await db.select({
      totalConversations: sql<number>`count(*)`,
      activeConversations: sql<number>`count(*) filter (where status = 'active')`,
    }).from(conversations);

    const [costTotals] = await db.select({
      totalCost: sql<string>`coalesce(sum(cost_usd), 0)`,
      totalCalls: sql<number>`count(*)`,
    }).from(llmUsageLogs);

    return reply.send({ conversations: totals, costs: costTotals });
  });
}
