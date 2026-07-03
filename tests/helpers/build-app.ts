/**
 * Minimal Fastify test harness — the first route-level harness in the repo.
 * Builds an app, registers a route plugin, and exposes `app.inject` with signed
 * JWTs so route-level auth/scoping (403s, super-admin gates, Zod rejection) can
 * be asserted end-to-end. Mirrors server.ts's ZodError → 400 error handler for
 * routes that use `.parse()`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { signToken } from '../../src/shared/middleware/auth.js';

export async function buildApp(routes: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if ((err as { name?: string }).name === 'ZodError') {
      return reply.status(400).send({ error: 'Invalid request' });
    }
    return reply.status(500).send({ error: 'Internal error', message: (err as Error).message });
  });
  await app.register(routes);
  await app.ready();
  return app;
}

/** Authorization header value for a role + home tenant. */
export function bearer(role: string, tenantId: string): string {
  return `Bearer ${signToken({ agentId: 'agent-1', tenantId, email: 'test@example.com', role })}`;
}
