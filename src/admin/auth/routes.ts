import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../../shared/db.js';
import { humanAgents, tenants } from '../../shared/schema/index.js';
import { loginSchema, refreshTokenSchema } from '../../shared/validators/index.js';
import { signToken, signRefreshToken, verifyToken, authMiddleware } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/admin/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    // Resolve slug → tenantId for sub-portal deployments.
    let scopedTenantId = body.tenantId;
    if (body.tenantSlug && !scopedTenantId) {
      const [t] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, body.tenantSlug))
        .limit(1);
      if (!t) {
        return reply.status(401).send({ error: 'Invalid credentials' });
      }
      scopedTenantId = t.id;
    } else if (body.tenantSlug && scopedTenantId) {
      const [t] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, body.tenantSlug))
        .limit(1);
      if (!t || t.id !== scopedTenantId) {
        return reply.status(401).send({ error: 'Tenant mismatch' });
      }
    }

    const conditions = [eq(humanAgents.email, body.email), eq(humanAgents.isActive, true)];
    if (scopedTenantId) {
      conditions.push(eq(humanAgents.tenantId, scopedTenantId));
    }

    const [agent] = await db
      .select()
      .from(humanAgents)
      .where(and(...conditions))
      .limit(1);

    if (!agent) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(body.password, agent.passwordHash);
    if (!validPassword) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const payload: JwtPayload = {
      agentId: agent.id,
      tenantId: agent.tenantId,
      email: agent.email,
      role: agent.role,
    };

    const accessToken = signToken(payload);
    const refreshToken = signRefreshToken(payload);

    return reply.send({
      accessToken,
      refreshToken,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        role: agent.role,
        tenantId: agent.tenantId,
      },
    });
  });

  app.post('/admin/auth/refresh', async (request, reply) => {
    const body = refreshTokenSchema.parse(request.body);

    try {
      const payload = verifyToken(body.refreshToken);
      const accessToken = signToken({
        agentId: payload.agentId,
        tenantId: payload.tenantId,
        email: payload.email,
        role: payload.role,
      });
      return reply.send({ accessToken });
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }
  });

  app.get('/admin/auth/me', { preHandler: authMiddleware }, async (request, reply) => {
    const auth = (request as typeof request & { auth: JwtPayload }).auth;

    const [agent] = await db
      .select({
        id: humanAgents.id,
        name: humanAgents.name,
        email: humanAgents.email,
        role: humanAgents.role,
        tenantId: humanAgents.tenantId,
        status: humanAgents.status,
        skills: humanAgents.skills,
      })
      .from(humanAgents)
      .where(eq(humanAgents.id, auth.agentId))
      .limit(1);

    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    return reply.send(agent);
  });
}
