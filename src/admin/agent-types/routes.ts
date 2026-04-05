import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { agentTypes, agentTools, tools } from '../../shared/schema/index.js';
import { createAgentTypeSchema } from '../../shared/validators/index.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';

export async function agentTypeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List agent types for tenant
  app.get<{ Params: { id: string } }>(
    '/admin/tenants/:id/agents',
    async (request, reply) => {
      const result = await db.select().from(agentTypes)
        .where(eq(agentTypes.tenantId, request.params.id))
        .orderBy(agentTypes.priority);
      return reply.send(result);
    },
  );

  // Get single agent type
  app.get<{ Params: { id: string; agentId: string } }>(
    '/admin/tenants/:id/agents/:agentId',
    async (request, reply) => {
      const [agent] = await db.select().from(agentTypes)
        .where(and(eq(agentTypes.tenantId, request.params.id), eq(agentTypes.id, request.params.agentId)))
        .limit(1);
      if (!agent) return reply.status(404).send({ error: 'Agent type not found' });

      // Get assigned tools
      const assignedTools = await db.select({ toolId: agentTools.toolId, name: tools.name })
        .from(agentTools)
        .innerJoin(tools, eq(tools.id, agentTools.toolId))
        .where(eq(agentTools.agentTypeId, agent.id));

      return reply.send({ ...agent, tools: assignedTools });
    },
  );

  // Create agent type
  app.post<{ Params: { id: string } }>(
    '/admin/tenants/:id/agents',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = createAgentTypeSchema.parse(request.body);
      const [created] = await db.insert(agentTypes).values({
        tenantId: request.params.id,
        ...body,
      }).returning();
      return reply.status(201).send(created);
    },
  );

  // Update agent type
  app.put<{ Params: { id: string; agentId: string } }>(
    '/admin/tenants/:id/agents/:agentId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const [updated] = await db.update(agentTypes)
        .set(body)
        .where(and(eq(agentTypes.tenantId, request.params.id), eq(agentTypes.id, request.params.agentId)))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'Agent type not found' });
      return reply.send(updated);
    },
  );

  // Delete agent type
  app.delete<{ Params: { id: string; agentId: string } }>(
    '/admin/tenants/:id/agents/:agentId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      await db.delete(agentTypes)
        .where(and(eq(agentTypes.tenantId, request.params.id), eq(agentTypes.id, request.params.agentId)));
      return reply.send({ deleted: true });
    },
  );

  // Assign tools to agent type
  app.post<{ Params: { id: string; agentId: string }; Body: { toolIds: string[] } }>(
    '/admin/tenants/:id/agents/:agentId/tools',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { toolIds } = request.body;

      // Remove existing assignments
      await db.delete(agentTools).where(eq(agentTools.agentTypeId, request.params.agentId));

      // Add new assignments
      if (toolIds.length > 0) {
        await db.insert(agentTools).values(
          toolIds.map(toolId => ({ agentTypeId: request.params.agentId, toolId })),
        );
      }

      return reply.send({ assigned: toolIds.length });
    },
  );
}
