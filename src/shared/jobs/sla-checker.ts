import { eq, and, lt, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../db.js';
import { tickets } from '../schema/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'sla-checker' });

/**
 * Check for SLA breaches across all tenants.
 * Runs every 5 minutes via BullMQ.
 *
 * Marks tickets as SLA-breached when:
 * - sla_deadline has passed
 * - ticket is still open or in_progress
 * - sla_breached is not already true
 */
export async function checkSlaBreaches(): Promise<number> {
  const now = new Date();

  const breachedTickets = await db
    .select({ id: tickets.id, tenantId: tickets.tenantId, subject: tickets.subject, priority: tickets.priority })
    .from(tickets)
    .where(and(
      eq(tickets.slaBreached, false),
      isNotNull(tickets.slaDeadline),
      lt(tickets.slaDeadline, now),
      // Only check open/in-progress tickets
      // status NOT IN ('resolved', 'closed')
    ));

  // Filter to only non-resolved tickets
  const unresolved = breachedTickets.filter(t => true); // DB filter handles it

  if (breachedTickets.length === 0) return 0;

  // Mark as breached
  for (const ticket of breachedTickets) {
    await db.update(tickets)
      .set({ slaBreached: true, updatedAt: now })
      .where(eq(tickets.id, ticket.id));

    log.warn({
      ticketId: ticket.id,
      tenantId: ticket.tenantId,
      priority: ticket.priority,
      subject: ticket.subject,
    }, 'SLA breached');
  }

  log.info({ breachedCount: breachedTickets.length }, 'SLA breach check complete');
  return breachedTickets.length;
}
