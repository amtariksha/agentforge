import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { tenantWallets, billingPeriods, ledgerEntries, invoices, notifications } from '../../shared/schema/index.js';
import { authMiddleware, getActiveTenantId, requireRole, requireSuperAdmin } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';
import { paginationSchema, walletAdjustSchema } from '../../shared/validators/index.js';
import { applyLedgerEntry, ensureWallet } from '../../billing/ledger.js';
import { clearPausedCache } from '../../billing/wallet-state.js';
import { toUsd } from '../../billing/money.js';
import { utcMonthStart } from '../../billing/period.js';
import { enqueueBillingRollup, enqueueInvoicePdf } from '../../shared/queue.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'billing-routes' });

export async function billingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // === Summary: wallet + current open period ===
  app.get('/admin/billing/summary', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    await ensureWallet(tenantId);
    const [wallet] = await db.select().from(tenantWallets).where(eq(tenantWallets.tenantId, tenantId)).limit(1);
    const [period] = await db
      .select()
      .from(billingPeriods)
      .where(and(eq(billingPeriods.tenantId, tenantId), eq(billingPeriods.periodStart, utcMonthStart(new Date()))))
      .limit(1);
    return reply.send({ wallet, currentPeriod: period ?? null });
  });

  // === Billing periods ===
  app.get('/admin/billing/periods', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const { page, limit } = paginationSchema.parse(request.query);
    const rows = await db
      .select()
      .from(billingPeriods)
      .where(eq(billingPeriods.tenantId, tenantId))
      .orderBy(desc(billingPeriods.periodStart))
      .limit(limit)
      .offset((page - 1) * limit);
    return reply.send({ periods: rows, page, limit });
  });

  app.get<{ Params: { id: string } }>('/admin/billing/periods/:id', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const [period] = await db
      .select()
      .from(billingPeriods)
      .where(and(eq(billingPeriods.id, request.params.id), eq(billingPeriods.tenantId, tenantId)))
      .limit(1);
    if (!period) return reply.status(404).send({ error: 'Period not found' });
    return reply.send(period);
  });

  // === Ledger (transaction list) ===
  app.get('/admin/billing/ledger', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const { page, limit } = paginationSchema.parse(request.query);
    const offset = (page - 1) * limit;
    const transactions = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, tenantId))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(limit)
      .offset(offset);
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, tenantId));
    return reply.send({ transactions, total: Number(total), limit, offset });
  });

  // === Invoices ===
  app.get('/admin/billing/invoices', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const { page, limit } = paginationSchema.parse(request.query);
    const rows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.tenantId, tenantId))
      .orderBy(desc(invoices.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);
    return reply.send({ invoices: rows, page, limit });
  });

  app.get<{ Params: { id: string } }>('/admin/billing/invoices/:id', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const invoice = await findInvoice(request.params.id, tenantId);
    if (!invoice) return reply.status(404).send({ error: 'Invoice not found' });
    return reply.send(invoice);
  });

  // PDF stream. The path comes from the DB row only — never from user input.
  app.get<{ Params: { id: string } }>('/admin/billing/invoices/:id/pdf', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const invoice = await findInvoice(request.params.id, tenantId);
    if (!invoice) return reply.status(404).send({ error: 'Invoice not found' });
    if (!invoice.pdfPath) return reply.status(404).send({ error: 'PDF not ready — still rendering' });
    try {
      await access(invoice.pdfPath);
    } catch {
      return reply.status(404).send({ error: 'PDF file missing' });
    }
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${invoice.invoiceNumber}.pdf"`);
    return reply.send(createReadStream(invoice.pdfPath));
  });

  app.post<{ Params: { id: string } }>(
    '/admin/billing/invoices/:id/issue',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const tenantId = getActiveTenantId(request);
      const invoice = await findInvoice(request.params.id, tenantId);
      if (!invoice) return reply.status(404).send({ error: 'Invoice not found' });
      if (invoice.status !== 'draft') return reply.status(409).send({ error: `Invoice is ${invoice.status}, not draft` });
      const [updated] = await db
        .update(invoices)
        .set({ status: 'issued', issuedAt: new Date() })
        .where(and(eq(invoices.id, invoice.id), eq(invoices.tenantId, tenantId)))
        .returning();
      log.info({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber }, 'Invoice issued');
      return reply.send(updated);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/billing/invoices/:id/regenerate-pdf',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const tenantId = getActiveTenantId(request);
      const invoice = await findInvoice(request.params.id, tenantId);
      if (!invoice) return reply.status(404).send({ error: 'Invoice not found' });
      await enqueueInvoicePdf(invoice.id);
      return reply.send({ enqueued: true });
    },
  );

  // === Wallet management (super-admin) ===
  app.post('/admin/billing/wallet/adjust', { preHandler: requireSuperAdmin() }, async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const auth = (request as typeof request & { auth: JwtPayload }).auth;
    const parsed = walletAdjustSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { type, amountUsd, reason, idempotencyKey } = parsed.data;
    const signed = type === 'debit_manual' ? -amountUsd : amountUsd;
    const result = await applyLedgerEntry({
      tenantId,
      type,
      amountUsd: toUsd(signed, 6),
      reference: `manual:${idempotencyKey}`,
      description: reason,
      createdBy: auth.agentId,
    });
    return reply.send({
      entry: result.entry,
      idempotentReplay: result.idempotentReplay,
      balanceUsd: result.balanceUsd,
    });
  });

  app.post('/admin/billing/wallet/pause', { preHandler: requireSuperAdmin() }, async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    await ensureWallet(tenantId);
    await db
      .update(tenantWallets)
      .set({ isPaused: true, pausedReason: 'manual', pausedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenantWallets.tenantId, tenantId));
    await clearPausedCache(tenantId);
    log.info({ tenantId }, 'Wallet manually paused');
    return reply.send({ paused: true });
  });

  app.post('/admin/billing/wallet/resume', { preHandler: requireSuperAdmin() }, async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    await ensureWallet(tenantId);
    await db
      .update(tenantWallets)
      .set({ isPaused: false, pausedReason: null, pausedAt: null, updatedAt: new Date() })
      .where(eq(tenantWallets.tenantId, tenantId));
    await clearPausedCache(tenantId);
    log.info({ tenantId }, 'Wallet resumed');
    return reply.send({ paused: false });
  });

  app.post('/admin/billing/rollup/run', { preHandler: requireSuperAdmin() }, async (_request, reply) => {
    await enqueueBillingRollup();
    return reply.send({ enqueued: true });
  });

  // === Notifications ===
  app.get<{ Querystring: { page?: string; limit?: string; unread?: string } }>(
    '/admin/notifications',
    async (request, reply) => {
      const tenantId = getActiveTenantId(request);
      const { page, limit } = paginationSchema.parse(request.query);
      const unreadOnly = request.query.unread === 'true';
      const where = unreadOnly
        ? and(eq(notifications.tenantId, tenantId), sql`${notifications.readAt} IS NULL`)
        : eq(notifications.tenantId, tenantId);
      const rows = await db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
        .offset((page - 1) * limit);
      const [{ unread }] = await db
        .select({ unread: sql<number>`count(*)` })
        .from(notifications)
        .where(and(eq(notifications.tenantId, tenantId), sql`${notifications.readAt} IS NULL`));
      return reply.send({ notifications: rows, unreadCount: Number(unread), page, limit });
    },
  );

  app.post<{ Params: { id: string } }>('/admin/notifications/:id/read', async (request, reply) => {
    const tenantId = getActiveTenantId(request);
    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, request.params.id), eq(notifications.tenantId, tenantId)))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Notification not found' });
    return reply.send(updated);
  });
}

async function findInvoice(id: string, tenantId: string) {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)))
    .limit(1);
  return invoice ?? null;
}
