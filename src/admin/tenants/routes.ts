import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { tenants, humanAgents, agentTypes } from '../../shared/schema/index.js';
import { createTenantSchema, updateTenantSchema } from '../../shared/validators/index.js';
import { authMiddleware, requireSuperAdmin } from '../../shared/middleware/auth.js';
import { redis } from '../../shared/redis.js';
import type { TenantConfig } from '../../shared/types/index.js';

const bootstrapSchema = z.object({
  adminName: z.string().min(1),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  seedStarterAgent: z.boolean().default(true),
});

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

  // Create tenant — super-admin only (creating a tenant is platform-level)
  app.post('/admin/tenants', { preHandler: requireSuperAdmin() }, async (request, reply) => {
    const body = createTenantSchema.parse(request.body);
    const [tenant] = await db.insert(tenants).values({
      name: body.name,
      slug: body.slug,
      config: body.config,
    }).returning();
    return reply.status(201).send(tenant);
  });

  // Bootstrap a freshly-created tenant — seed a default admin human-agent and,
  // optionally, a starter "support" agent type. Super-admin only.
  // Idempotent: if the admin email already exists for this tenant, skips that step.
  app.post<{ Params: { id: string } }>('/admin/tenants/:id/bootstrap', { preHandler: requireSuperAdmin() }, async (request, reply) => {
    const { id } = request.params;
    const body = bootstrapSchema.parse(request.body);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    // 1. Create admin human-agent (skip if email exists in this tenant)
    const [existingAgent] = await db
      .select({ id: humanAgents.id })
      .from(humanAgents)
      .where(eq(humanAgents.tenantId, id))
      .limit(1);

    let adminAgentId: string | null = existingAgent?.id ?? null;
    if (!existingAgent) {
      const passwordHash = await bcrypt.hash(body.adminPassword, 10);
      const [created] = await db.insert(humanAgents).values({
        tenantId: id,
        name: body.adminName,
        email: body.adminEmail,
        passwordHash,
        role: 'admin',
      }).returning({ id: humanAgents.id });
      adminAgentId = created.id;
    }

    // 2. Optionally create a starter "support" agent type
    let starterAgentId: string | null = null;
    if (body.seedStarterAgent) {
      const [existing] = await db
        .select({ id: agentTypes.id })
        .from(agentTypes)
        .where(eq(agentTypes.tenantId, id))
        .limit(1);
      if (!existing) {
        const [created] = await db.insert(agentTypes).values({
          tenantId: id,
          name: 'Support',
          slug: 'support',
          avatarEmoji: '🛟',
          description: 'Default starter agent for this tenant. Customize the system prompt before going live.',
          systemPrompt:
            `You are the support agent for ${tenant.name}. Be helpful, polite, and accurate. ` +
            'Ask clarifying questions when needed. Escalate to a human if the user requests it or seems frustrated.',
          intentKeywords: [],
          intentExamples: [],
          priority: 50,
          confidenceThreshold: 0.7,
          isDefault: true,
        }).returning({ id: agentTypes.id });
        starterAgentId = created.id;
      } else {
        starterAgentId = existing.id;
      }
    }

    return reply.status(201).send({
      tenantId: id,
      adminAgentId,
      starterAgentId,
      adminCreated: !existingAgent,
    });
  });

  // Update tenant — super-admin only
  app.put<{ Params: { id: string } }>('/admin/tenants/:id', { preHandler: requireSuperAdmin() }, async (request, reply) => {
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

  // Import tenant config — super-admin only
  app.post<{ Params: { id: string } }>('/admin/tenants/:id/import', { preHandler: requireSuperAdmin() }, async (request, reply) => {
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
