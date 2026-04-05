import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { tickets } from '../../shared/schema/index.js';
import { createTicketSchema, updateTicketSchema, paginationSchema } from '../../shared/validators/index.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'tickets' });

// Default SLA config (per tenant override in tenant config)
const DEFAULT_SLA: Record<string, { firstResponseMin: number; resolutionHours: number }> = {
  critical: { firstResponseMin: 5, resolutionHours: 1 },
  high: { firstResponseMin: 15, resolutionHours: 4 },
  medium: { firstResponseMin: 60, resolutionHours: 24 },
  low: { firstResponseMin: 240, resolutionHours: 72 },
};

function calculateSlaDeadline(priority: string): Date {
  const sla = DEFAULT_SLA[priority] ?? DEFAULT_SLA['medium'];
  return new Date(Date.now() + sla.resolutionHours * 60 * 60 * 1000);
}

export async function ticketRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List tickets for tenant
  app.get<{ Params: { tenantId: string }; Querystring: Record<string, string> }>(
    '/admin/tickets/:tenantId',
    async (request, reply) => {
      const { tenantId } = request.params;
      const { page, limit } = paginationSchema.parse(request.query);
      const status = request.query['status'];

      const conditions = [eq(tickets.tenantId, tenantId)];
      if (status) {
        conditions.push(eq(tickets.status, status));
      }

      const result = await db
        .select()
        .from(tickets)
        .where(and(...conditions))
        .orderBy(desc(tickets.createdAt))
        .limit(limit)
        .offset((page - 1) * limit);

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tickets)
        .where(and(...conditions));

      return reply.send({ tickets: result, total: count, page, limit });
    },
  );

  // Get single ticket
  app.get<{ Params: { tenantId: string; id: string } }>(
    '/admin/tickets/:tenantId/:id',
    async (request, reply) => {
      const [ticket] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.tenantId, request.params.tenantId), eq(tickets.id, request.params.id)))
        .limit(1);

      if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
      return reply.send(ticket);
    },
  );

  // Create ticket
  app.post<{ Params: { tenantId: string } }>(
    '/admin/tickets/:tenantId',
    async (request, reply) => {
      const body = createTicketSchema.parse(request.body);

      const [ticket] = await db.insert(tickets).values({
        tenantId: request.params.tenantId,
        conversationId: body.conversationId,
        userId: body.userId,
        source: body.source,
        type: body.type,
        priority: body.priority,
        subject: body.subject,
        description: body.description,
        slaDeadline: calculateSlaDeadline(body.priority),
      }).returning();

      return reply.status(201).send(ticket);
    },
  );

  // Update ticket
  app.put<{ Params: { tenantId: string; id: string } }>(
    '/admin/tickets/:tenantId/:id',
    async (request, reply) => {
      const body = updateTicketSchema.parse(request.body);

      const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };

      // Track first response
      if (body.status === 'in_progress') {
        const [existing] = await db.select({ firstResponseAt: tickets.firstResponseAt })
          .from(tickets).where(eq(tickets.id, request.params.id)).limit(1);
        if (!existing?.firstResponseAt) {
          updateData['firstResponseAt'] = new Date();
        }
      }

      // Track resolution
      if (body.status === 'resolved' || body.status === 'closed') {
        updateData['resolvedAt'] = new Date();
      }

      const [updated] = await db.update(tickets)
        .set(updateData)
        .where(and(eq(tickets.tenantId, request.params.tenantId), eq(tickets.id, request.params.id)))
        .returning();

      if (!updated) return reply.status(404).send({ error: 'Ticket not found' });
      return reply.send(updated);
    },
  );

  // Assign ticket
  app.post<{ Params: { tenantId: string; id: string }; Body: { operatorId: string } }>(
    '/admin/tickets/:tenantId/:id/assign',
    async (request, reply) => {
      const [updated] = await db.update(tickets)
        .set({
          assignedTo: request.body.operatorId,
          status: 'in_progress',
          updatedAt: new Date(),
          firstResponseAt: new Date(),
        })
        .where(and(eq(tickets.tenantId, request.params.tenantId), eq(tickets.id, request.params.id)))
        .returning();

      if (!updated) return reply.status(404).send({ error: 'Ticket not found' });
      return reply.send(updated);
    },
  );

  // Resolve ticket
  app.post<{ Params: { tenantId: string; id: string }; Body: { type: string; notes: string; actionsTaken: string[] } }>(
    '/admin/tickets/:tenantId/:id/resolve',
    async (request, reply) => {
      const [updated] = await db.update(tickets)
        .set({
          status: 'resolved',
          resolution: request.body,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(tickets.tenantId, request.params.tenantId), eq(tickets.id, request.params.id)))
        .returning();

      if (!updated) return reply.status(404).send({ error: 'Ticket not found' });
      return reply.send(updated);
    },
  );
}

/**
 * Auto-create ticket from system events (escalation, guardrail flag, etc.)
 */
export async function autoCreateTicket(params: {
  tenantId: string;
  conversationId?: string;
  userId?: string;
  source: string;
  type: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  subject: string;
  description?: string;
}): Promise<string> {
  const [ticket] = await db.insert(tickets).values({
    tenantId: params.tenantId,
    conversationId: params.conversationId,
    userId: params.userId,
    source: params.source,
    type: params.type,
    priority: params.priority,
    subject: params.subject,
    description: params.description,
    slaDeadline: calculateSlaDeadline(params.priority),
  }).returning();

  log.info({ ticketId: ticket.id, source: params.source, priority: params.priority }, 'Auto-created ticket');
  return ticket.id;
}
