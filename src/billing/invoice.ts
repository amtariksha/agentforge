import { eq, and, ne, like, desc } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { billingPeriods, invoices, ledgerEntries, tenants } from '../shared/schema/index.js';
import type { InvoiceLineItem, AgentUsageRollup, LedgerUsageMeta } from '../shared/schema/index.js';
import { roundHalfUp } from './money.js';
import { utcMonthPrefix, utcMonthCompact } from './period.js';
import { raiseAlert } from './alerts.js';
import { enqueueInvoicePdf } from '../shared/queue.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'invoice' });

type Invoice = typeof invoices.$inferSelect;
type Period = typeof billingPeriods.$inferSelect;

/**
 * Generate an invoice for a billing period from its usage debits. The ledger is
 * the source of truth: `totalUsd` is the sum of the period's `debit_usage`
 * entries, so the invoice always reconciles with the ledger by construction.
 * `subtotalUsd` (raw cost) and per-agent line items come from each debit's
 * metadata; `marginUsd` is the difference. Idempotent: an existing live invoice
 * is returned (its PDF re-enqueued if missing); a $0 period yields no invoice.
 */
export async function generateInvoice(billingPeriodId: string): Promise<Invoice | null> {
  const [period] = await db.select().from(billingPeriods).where(eq(billingPeriods.id, billingPeriodId)).limit(1);
  if (!period) {
    log.warn({ billingPeriodId }, 'generateInvoice: period not found');
    return null;
  }

  const monthPrefix = utcMonthPrefix(period.periodStart);
  const refPrefix = `usage:${period.tenantId}:${monthPrefix}-`;
  const debits = await db
    .select()
    .from(ledgerEntries)
    .where(and(
      eq(ledgerEntries.tenantId, period.tenantId),
      eq(ledgerEntries.type, 'debit_usage'),
      like(ledgerEntries.reference, `${refPrefix}%`),
    ));

  const totalCharged = debits.reduce((sum, d) => sum + Math.abs(Number(d.amountUsd)), 0);
  if (totalCharged <= 0) {
    log.info({ tenantId: period.tenantId, periodStart: period.periodStart }, 'Zero-charge period — no invoice');
    return null;
  }

  // Raw subtotal + per-agent line items from debit metadata.
  const agentMap = new Map<string, InvoiceLineItem>();
  let rawSubtotal = 0;
  for (const d of debits) {
    const meta = d.metadata as LedgerUsageMeta | null;
    rawSubtotal += Number(meta?.rawCostUsd ?? 0);
    for (const a of meta?.byAgent ?? []) {
      accumulateLineItem(agentMap, a);
    }
  }
  const lineItems: InvoiceLineItem[] = [...agentMap.values()].map((li) => ({
    ...li,
    costUsd: roundHalfUp(Number(li.costUsd), 6).toFixed(6),
  }));

  const subtotalUsd = roundHalfUp(rawSubtotal, 2);
  const totalUsd = roundHalfUp(totalCharged, 2);
  const marginUsd = roundHalfUp(totalUsd - subtotalUsd, 2);
  const marginPct = subtotalUsd > 0 ? roundHalfUp((marginUsd / subtotalUsd) * 100, 2) : 0;

  // Cross-check: ledger-derived raw subtotal vs the re-aggregated period rollup.
  const periodRaw = Number(period.totalCostUsd);
  if (Math.abs(periodRaw - rawSubtotal) > 0.01) {
    await raiseAlert({
      tenantId: period.tenantId,
      type: 'billing.drift',
      severity: 'warning',
      title: 'Billing drift detected',
      body: `Invoice raw subtotal $${rawSubtotal.toFixed(6)} differs from period rollup $${periodRaw.toFixed(6)}`,
      dedupeKey: `billing.drift:${period.tenantId}:${monthPrefix}`,
      metadata: { periodRaw, rawSubtotal, billingPeriodId: period.id },
    });
  }

  const invoiceNumber = await nextInvoiceNumber(period);
  const [invoice] = await db
    .insert(invoices)
    .values({
      tenantId: period.tenantId,
      billingPeriodId: period.id,
      invoiceNumber,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      lineItems,
      subtotalUsd: subtotalUsd.toFixed(2),
      marginPct: marginPct.toFixed(2),
      marginUsd: marginUsd.toFixed(2),
      totalUsd: totalUsd.toFixed(2),
      status: 'draft',
    })
    .onConflictDoNothing()
    .returning();

  if (!invoice) {
    // A live invoice already exists for this period. Re-enqueue its PDF if it
    // never rendered (recovers from an exhausted PDF job).
    const [existing] = await db
      .select()
      .from(invoices)
      .where(and(
        eq(invoices.tenantId, period.tenantId),
        eq(invoices.billingPeriodId, period.id),
        ne(invoices.status, 'void'),
      ))
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    if (existing && !existing.pdfPath) {
      await enqueueInvoicePdf(existing.id);
    }
    return existing ?? null;
  }

  await enqueueInvoicePdf(invoice.id);
  await raiseAlert({
    tenantId: period.tenantId,
    type: 'invoice.generated',
    severity: 'info',
    title: `Invoice ${invoiceNumber}`,
    body: `Invoice for ${monthPrefix}: $${totalUsd.toFixed(2)}`,
    dedupeKey: `invoice:${invoiceNumber}`,
    webhookEvent: 'invoice.generated',
    webhookData: {
      invoiceNumber,
      totalUsd: totalUsd.toFixed(2),
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
    },
  });

  log.info({ tenantId: period.tenantId, invoiceNumber, totalUsd }, 'Invoice generated');
  return invoice;
}

function accumulateLineItem(map: Map<string, InvoiceLineItem>, a: AgentUsageRollup): void {
  const key = a.slug ?? '(none)';
  const li = map.get(key) ?? { agentSlug: a.slug, calls: 0, tokensInput: 0, tokensOutput: 0, costUsd: '0' };
  li.calls += a.calls;
  li.tokensInput += a.tokensInput;
  li.tokensOutput += a.tokensOutput;
  li.costUsd = (Number(li.costUsd) + Number(a.costUsd)).toString();
  map.set(key, li);
}

/**
 * Deterministic invoice number `AF-{YYYYMM}-{slug}`, with an `-r{n}` suffix if a
 * prior invoice (e.g. a voided one) already exists for this period.
 */
async function nextInvoiceNumber(period: Period): Promise<string> {
  const [tenant] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, period.tenantId)).limit(1);
  const base = `AF-${utcMonthCompact(period.periodStart)}-${tenant?.slug ?? period.tenantId.slice(0, 8)}`;
  const prior = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.tenantId, period.tenantId), eq(invoices.billingPeriodId, period.id)));
  return prior.length === 0 ? base : `${base}-r${prior.length + 1}`;
}
