import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { tickets } from '../../shared/schema/index.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';
import { createChildLogger } from '../../shared/utils/logger.js';
import { redis } from '../../shared/redis.js';

const log = createChildLogger({ module: 'hitl-approval' });

// Pending HITL approvals stored in Redis for fast access
const APPROVAL_KEY_PREFIX = 'hitl:approval:';

export interface HitlApproval {
  id: string;
  tenantId: string;
  conversationId: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'modified';
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  modifiedParams?: Record<string, unknown>;
}

export async function createApproval(approval: Omit<HitlApproval, 'status' | 'createdAt'>): Promise<HitlApproval> {
  const full: HitlApproval = {
    ...approval,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await redis.setex(
    `${APPROVAL_KEY_PREFIX}${approval.id}`,
    86400, // 24h TTL
    JSON.stringify(full),
  );

  // Add to tenant's pending list
  await redis.lpush(`hitl:pending:${approval.tenantId}`, approval.id);

  log.info({ approvalId: approval.id, tool: approval.toolName }, 'HITL approval created');
  return full;
}

export async function getApproval(id: string): Promise<HitlApproval | null> {
  const data = await redis.get(`${APPROVAL_KEY_PREFIX}${id}`);
  return data ? JSON.parse(data) as HitlApproval : null;
}

export async function resolveApproval(
  id: string,
  action: 'approved' | 'rejected' | 'modified',
  resolvedBy: string,
  modifiedParams?: Record<string, unknown>,
): Promise<HitlApproval | null> {
  const approval = await getApproval(id);
  if (!approval) return null;

  approval.status = action;
  approval.resolvedBy = resolvedBy;
  approval.resolvedAt = new Date().toISOString();
  if (modifiedParams) approval.modifiedParams = modifiedParams;

  await redis.setex(`${APPROVAL_KEY_PREFIX}${id}`, 86400, JSON.stringify(approval));

  // Remove from pending list
  await redis.lrem(`hitl:pending:${approval.tenantId}`, 1, id);

  log.info({ approvalId: id, action, resolvedBy }, 'HITL approval resolved');
  return approval;
}

export async function hitlRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List pending approvals for tenant
  app.get<{ Params: { tenantId: string } }>(
    '/admin/approvals/:tenantId',
    async (request, reply) => {
      const { tenantId } = request.params;
      const ids = await redis.lrange(`hitl:pending:${tenantId}`, 0, -1);

      const approvals: HitlApproval[] = [];
      for (const id of ids) {
        const approval = await getApproval(id);
        if (approval && approval.status === 'pending') {
          approvals.push(approval);
        }
      }

      return reply.send(approvals);
    },
  );

  // Approve
  app.post<{ Params: { id: string } }>(
    '/admin/approvals/:id/approve',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;
      const result = await resolveApproval(request.params.id, 'approved', auth.agentId);
      if (!result) return reply.status(404).send({ error: 'Approval not found' });
      return reply.send(result);
    },
  );

  // Reject
  app.post<{ Params: { id: string } }>(
    '/admin/approvals/:id/reject',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;
      const result = await resolveApproval(request.params.id, 'rejected', auth.agentId);
      if (!result) return reply.status(404).send({ error: 'Approval not found' });
      return reply.send(result);
    },
  );

  // Modify (approve with changed params)
  app.post<{ Params: { id: string }; Body: { params: Record<string, unknown> } }>(
    '/admin/approvals/:id/modify',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;
      const body = request.body;
      const result = await resolveApproval(request.params.id, 'modified', auth.agentId, body.params);
      if (!result) return reply.status(404).send({ error: 'Approval not found' });
      return reply.send(result);
    },
  );
}
