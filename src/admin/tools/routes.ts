import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { tools } from '../../shared/schema/index.js';
import { createToolSchema } from '../../shared/validators/index.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { executeTool } from '../../tools/executor.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';

export async function toolRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List tools for tenant
  app.get<{ Params: { id: string } }>(
    '/admin/tenants/:id/tools',
    async (request, reply) => {
      const result = await db.select().from(tools)
        .where(eq(tools.tenantId, request.params.id));
      return reply.send(result);
    },
  );

  // Get single tool
  app.get<{ Params: { id: string; toolId: string } }>(
    '/admin/tenants/:id/tools/:toolId',
    async (request, reply) => {
      const [tool] = await db.select().from(tools)
        .where(and(eq(tools.tenantId, request.params.id), eq(tools.id, request.params.toolId)))
        .limit(1);
      if (!tool) return reply.status(404).send({ error: 'Tool not found' });
      return reply.send(tool);
    },
  );

  // Create tool
  app.post<{ Params: { id: string } }>(
    '/admin/tenants/:id/tools',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = createToolSchema.parse(request.body);
      const [created] = await db.insert(tools).values({
        tenantId: request.params.id,
        name: body.name,
        description: body.description,
        category: body.category,
        requiresHitl: body.requiresHitl,
        requiresUserConfirm: body.requiresUserConfirm,
        parameters: body.parameters,
        backendMapping: body.backendMapping,
        executionConfig: body.executionConfig,
      }).returning();
      return reply.status(201).send(created);
    },
  );

  // Update tool
  app.put<{ Params: { id: string; toolId: string } }>(
    '/admin/tenants/:id/tools/:toolId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const [updated] = await db.update(tools)
        .set(body)
        .where(and(eq(tools.tenantId, request.params.id), eq(tools.id, request.params.toolId)))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'Tool not found' });
      return reply.send(updated);
    },
  );

  // Delete tool
  app.delete<{ Params: { id: string; toolId: string } }>(
    '/admin/tenants/:id/tools/:toolId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      await db.delete(tools)
        .where(and(eq(tools.tenantId, request.params.id), eq(tools.id, request.params.toolId)));
      return reply.send({ deleted: true });
    },
  );

  // Test tool against backend
  app.post<{ Params: { id: string; toolId: string }; Body: { params: Record<string, unknown> } }>(
    '/admin/tenants/:id/tools/:toolId/test',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;
      const [tool] = await db.select().from(tools)
        .where(and(eq(tools.tenantId, request.params.id), eq(tools.id, request.params.toolId)))
        .limit(1);

      if (!tool) return reply.status(404).send({ error: 'Tool not found' });

      // Execute tool with test params
      const result = await executeTool(tool.name, request.body.params, {
        tenantId: request.params.id,
        tenantSlug: '', // Will be resolved by executor
        userId: undefined,
        conversationId: undefined,
      });

      return reply.send({ testResult: result });
    },
  );
}
