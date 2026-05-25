import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'service-token' });

const SERVICE_TOKEN = process.env.AGENT_FORCE_SERVICE_TOKEN ?? '';

if (!SERVICE_TOKEN) {
  log.warn(
    'AGENT_FORCE_SERVICE_TOKEN is not set — service-token-gated routes will refuse all requests',
  );
}

export interface ServiceTokenContext {
  principal: 'agent-force';
}

/**
 * Fastify preHandler that validates a static bearer token issued for
 * service-to-service calls from swarg-admin-nextjs to chatagent.
 *
 * Compares with `crypto.timingSafeEqual` to avoid timing leaks. Returns
 * 403 (not 401) on mismatch — there's no "login" flow to retry with.
 * On success, attaches `request.service = { principal: 'agent-force' }`.
 */
export async function serviceTokenMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing bearer token' });
  }

  const presented = authHeader.slice(7);

  if (!SERVICE_TOKEN || !constantTimeEqual(presented, SERVICE_TOKEN)) {
    log.warn(
      { ip: request.ip, url: request.url },
      'Service token mismatch — rejecting request',
    );
    return reply.status(403).send({ error: 'Forbidden' });
  }

  (request as FastifyRequest & { service: ServiceTokenContext }).service = {
    principal: 'agent-force',
  };
}

/**
 * Compare two strings in constant time. Falls back to length check first
 * because timingSafeEqual throws on length mismatch; doing the length
 * compare ahead of the buffer alloc keeps the cost bounded for bogus
 * inputs (e.g. an attacker sending a 1MB token).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  return timingSafeEqual(aBuf, bBuf);
}
