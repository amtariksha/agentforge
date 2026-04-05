import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { tenants } from '../../shared/schema/index.js';
import { createTenantSchema, updateTenantSchema } from '../../shared/validators/index.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { redis } from '../../shared/redis.js';
import type { TenantConfig } from '../../shared/types/index.js';

const TENANT_CACHE_TTL = 60; // seconds

export async function tenantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List tenants
  app.get('/admin/tenants', async (_request, reply) => {
    const result = await db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, isActive: tenants.isActive, createdAt: tenants.createdAt })
      .from(tenants)
      .orderBy(tenants.name);
    return reply.send(result);
  });

  // Get tenant
  app.get<{ Params: { id: string } }>('/admin/tenants/:id', async (request, reply) => {
    const { id } = request.params;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });
    return reply.send(tenant);
  });

  // Create tenant
  app.post('/admin/tenants', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = createTenantSchema.parse(request.body);
    const [tenant] = await db.insert(tenants).values({
      name: body.name,
      slug: body.slug,
      config: body.config,
    }).returning();
    return reply.status(201).send(tenant);
  });

  // Update tenant
  app.put<{ Params: { id: string } }>('/admin/tenants/:id', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params;
    const body = updateTenantSchema.parse(request.body);

    const [updated] = await db.update(tenants)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning();

    if (!updated) return reply.status(404).send({ error: 'Tenant not found' });

    // Invalidate cache
    await redis.del(`tenant:${id}:config`);
    return reply.send(updated);
  });

  // Export tenant config
  app.get<{ Params: { id: string } }>('/admin/tenants/:id/export', async (request, reply) => {
    const { id } = request.params;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });
    return reply.send(tenant);
  });

  // Import tenant config
  app.post<{ Params: { id: string } }>('/admin/tenants/:id/import', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params;
    const body = request.body as { config: Record<string, unknown> };

    const [updated] = await db.update(tenants)
      .set({ config: body.config, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning();

    if (!updated) return reply.status(404).send({ error: 'Tenant not found' });

    await redis.del(`tenant:${id}:config`);
    return reply.send(updated);
  });
}

// Helper: load tenant config with caching
export async function loadTenantConfig(tenantId: string): Promise<TenantConfig | null> {
  const cacheKey = `tenant:${tenantId}:config`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as TenantConfig;
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return null;

  const config = tenant.config as TenantConfig;
  await redis.setex(cacheKey, TENANT_CACHE_TTL, JSON.stringify(config));
  return config;
}

// Helper: resolve tenant ID from slug
export async function resolveTenantBySlug(slug: string): Promise<{ id: string; config: TenantConfig } | null> {
  const [tenant] = await db
    .select({ id: tenants.id, config: tenants.config })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);

  if (!tenant) return null;
  return { id: tenant.id, config: tenant.config as TenantConfig };
}
