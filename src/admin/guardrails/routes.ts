import type { FastifyInstance } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { guardrails } from '../../shared/schema/index.js';
import { createGuardrailSchema } from '../../shared/validators/index.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';

export async function guardrailRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List global guardrails
  app.get('/admin/guardrails/global', async (_request, reply) => {
    const result = await db.select().from(guardrails)
      .where(isNull(guardrails.tenantId))
      .orderBy(guardrails.priority);
    return reply.send(result);
  });

  // Create global guardrail
  app.post('/admin/guardrails/global', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = createGuardrailSchema.parse(request.body);
    const [created] = await db.insert(guardrails).values({
      tenantId: null, // global
      ...body,
    }).returning();
    return reply.status(201).send(created);
  });

  // List tenant guardrails
  app.get<{ Params: { tenantId: string } }>(
    '/admin/guardrails/:tenantId',
    async (request, reply) => {
      const result = await db.select().from(guardrails)
        .where(eq(guardrails.tenantId, request.params.tenantId))
        .orderBy(guardrails.priority);
      return reply.send(result);
    },
  );

  // Create tenant guardrail
  app.post<{ Params: { tenantId: string } }>(
    '/admin/guardrails/:tenantId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = createGuardrailSchema.parse(request.body);
      const [created] = await db.insert(guardrails).values({
        tenantId: request.params.tenantId,
        ...body,
      }).returning();
      return reply.status(201).send(created);
    },
  );

  // Update tenant guardrail
  app.put<{ Params: { tenantId: string; id: string } }>(
    '/admin/guardrails/:tenantId/:id',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const [updated] = await db.update(guardrails)
        .set(body)
        .where(and(eq(guardrails.tenantId, request.params.tenantId), eq(guardrails.id, request.params.id)))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'Guardrail not found' });
      return reply.send(updated);
    },
  );

  // Delete tenant guardrail
  app.delete<{ Params: { tenantId: string; id: string } }>(
    '/admin/guardrails/:tenantId/:id',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      await db.delete(guardrails)
        .where(and(eq(guardrails.tenantId, request.params.tenantId), eq(guardrails.id, request.params.id)));
      return reply.send({ deleted: true });
    },
  );
}
