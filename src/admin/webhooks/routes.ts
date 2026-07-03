import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { webhookConfigs } from '../../shared/schema/index.js';
import { createWebhookConfigSchema, updateWebhookConfigSchema } from '../../shared/validators/index.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';

export async function webhookAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List webhook configs for tenant
  app.get<{ Params: { tenantId: string } }>(
    '/admin/webhooks/:tenantId',
    async (request, reply) => {
      const result = await db.select().from(webhookConfigs)
        .where(eq(webhookConfigs.tenantId, request.params.tenantId));
      return reply.send(result);
    },
  );

  // Create webhook config
  app.post<{ Params: { tenantId: string } }>(
    '/admin/webhooks/:tenantId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = createWebhookConfigSchema.parse(request.body);
      const [created] = await db.insert(webhookConfigs).values({
        tenantId: request.params.tenantId,
        ...body,
      }).returning();
      return reply.status(201).send(created);
    },
  );

  // Update webhook config
  app.put<{ Params: { tenantId: string; id: string } }>(
    '/admin/webhooks/:tenantId/:id',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const parsed = updateWebhookConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
      }
      const body = parsed.data;
      const [updated] = await db.update(webhookConfigs)
        .set({
          ...(body.url !== undefined && { url: body.url }),
          ...(body.events !== undefined && { events: body.events }),
          ...(body.secret !== undefined && { secret: body.secret }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        })
        .where(and(eq(webhookConfigs.tenantId, request.params.tenantId), eq(webhookConfigs.id, request.params.id)))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'Webhook config not found' });
      return reply.send(updated);
    },
  );

  // Delete webhook config
  app.delete<{ Params: { tenantId: string; id: string } }>(
    '/admin/webhooks/:tenantId/:id',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      await db.delete(webhookConfigs)
        .where(and(eq(webhookConfigs.tenantId, request.params.tenantId), eq(webhookConfigs.id, request.params.id)));
      return reply.send({ deleted: true });
    },
  );
}
