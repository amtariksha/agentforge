import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../../shared/db.js';
import { humanAgents } from '../../shared/schema/index.js';
import { createHumanAgentSchema, paginationSchema } from '../../shared/validators/index.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';
import { redis } from '../../shared/redis.js';

export async function humanAgentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List human agents for tenant
  app.get<{ Params: { tenantId: string } }>(
    '/admin/agents/:tenantId',
    async (request, reply) => {
      const agents = await db
        .select({
          id: humanAgents.id,
          name: humanAgents.name,
          email: humanAgents.email,
          phone: humanAgents.phone,
          role: humanAgents.role,
          status: humanAgents.status,
          maxConcurrentChats: humanAgents.maxConcurrentChats,
          skills: humanAgents.skills,
          isActive: humanAgents.isActive,
          createdAt: humanAgents.createdAt,
        })
        .from(humanAgents)
        .where(eq(humanAgents.tenantId, request.params.tenantId));

      // Enrich with active chat count from Redis
      const enriched = await Promise.all(agents.map(async (agent) => {
        const activeChats = parseInt(await redis.get(`operator:${agent.id}:active_chats`) ?? '0', 10);
        return { ...agent, activeChats };
      }));

      return reply.send(enriched);
    },
  );

  // Get single agent
  app.get<{ Params: { tenantId: string; id: string } }>(
    '/admin/agents/:tenantId/:id',
    async (request, reply) => {
      const [agent] = await db
        .select({
          id: humanAgents.id,
          name: humanAgents.name,
          email: humanAgents.email,
          phone: humanAgents.phone,
          role: humanAgents.role,
          status: humanAgents.status,
          maxConcurrentChats: humanAgents.maxConcurrentChats,
          skills: humanAgents.skills,
          isActive: humanAgents.isActive,
          createdAt: humanAgents.createdAt,
        })
        .from(humanAgents)
        .where(and(
          eq(humanAgents.tenantId, request.params.tenantId),
          eq(humanAgents.id, request.params.id),
        ))
        .limit(1);

      if (!agent) return reply.status(404).send({ error: 'Agent not found' });
      return reply.send(agent);
    },
  );

  // Create human agent
  app.post<{ Params: { tenantId: string } }>(
    '/admin/agents/:tenantId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = createHumanAgentSchema.parse(request.body);
      const passwordHash = await bcrypt.hash(body.password, 10);

      const [agent] = await db.insert(humanAgents).values({
        tenantId: request.params.tenantId,
        name: body.name,
        email: body.email,
        passwordHash,
        phone: body.phone,
        role: body.role,
        maxConcurrentChats: body.maxConcurrentChats,
        skills: body.skills,
      }).returning({
        id: humanAgents.id,
        name: humanAgents.name,
        email: humanAgents.email,
        role: humanAgents.role,
      });

      return reply.status(201).send(agent);
    },
  );

  // Update human agent
  app.put<{
    Params: { tenantId: string; id: string };
    Body: {
      name?: string;
      phone?: string;
      role?: string;
      maxConcurrentChats?: number;
      skills?: string[];
      isActive?: boolean;
    };
  }>(
    '/admin/agents/:tenantId/:id',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = request.body;

      const [updated] = await db.update(humanAgents)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.phone !== undefined && { phone: body.phone }),
          ...(body.role !== undefined && { role: body.role }),
          ...(body.maxConcurrentChats !== undefined && { maxConcurrentChats: body.maxConcurrentChats }),
          ...(body.skills !== undefined && { skills: body.skills }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        })
        .where(and(
          eq(humanAgents.tenantId, request.params.tenantId),
          eq(humanAgents.id, request.params.id),
        ))
        .returning({
          id: humanAgents.id,
          name: humanAgents.name,
          email: humanAgents.email,
          role: humanAgents.role,
          status: humanAgents.status,
        });

      if (!updated) return reply.status(404).send({ error: 'Agent not found' });
      return reply.send(updated);
    },
  );

  // Delete human agent
  app.delete<{ Params: { tenantId: string; id: string } }>(
    '/admin/agents/:tenantId/:id',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      await db.update(humanAgents)
        .set({ isActive: false })
        .where(and(
          eq(humanAgents.tenantId, request.params.tenantId),
          eq(humanAgents.id, request.params.id),
        ));

      return reply.send({ deactivated: true });
    },
  );

  // Update status
  app.put<{ Params: { tenantId: string; id: string }; Body: { status: string } }>(
    '/admin/agents/:tenantId/:id/status',
    async (request, reply) => {
      const { status } = request.body;
      if (!['online', 'busy', 'offline'].includes(status)) {
        return reply.status(400).send({ error: 'Invalid status' });
      }

      const [updated] = await db.update(humanAgents)
        .set({ status })
        .where(and(
          eq(humanAgents.tenantId, request.params.tenantId),
          eq(humanAgents.id, request.params.id),
        ))
        .returning({ id: humanAgents.id, status: humanAgents.status });

      if (!updated) return reply.status(404).send({ error: 'Agent not found' });

      // If going offline, reset active chats count
      if (status === 'offline') {
        await redis.del(`operator:${request.params.id}:active_chats`);
      }

      return reply.send(updated);
    },
  );
}
