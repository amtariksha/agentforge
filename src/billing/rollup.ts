import { eq, and, sql } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { billingPeriods, tenants, tenantWallets } from '../shared/schema/index.js';
import type { AgentUsageRollup } from '../shared/schema/index.js';
import { applyLedgerEntry, ensureWallet } from './ledger.js';
import { generateInvoice } from './invoice.js';
import { raiseAlert } from './alerts.js';
import { toUsd, applyMargin } from './money.js';
import {
  utcMonthStart, utcNextMonthStart, utcMonthPrefix, utcDayString,
} from './period.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'billing-rollup' });

interface DayAgg {
  day: string; // YYYY-MM-DD (UTC)
  rawCost: number;
  llmCalls: number;
  unpricedRows: number;
  byAgent: AgentUsageRollup[];
}

interface PeriodAgg {
  totalCostUsd: string;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokensCacheWrite: number;
  totalTokensCacheRead: number;
  llmCalls: number;
  unpricedRows: number;
  byAgent: AgentUsageRollup[];
}

interface RollupFlags {
  pausedNow: boolean;
  lowBalanceCrossed: boolean;
}

/**
 * Nightly billing rollup (02:30 UTC). Per active tenant: close the previous UTC
 * month (re-aggregate → debit remaining days → invoice), self-heal debits for
 * every completed day of the current month, upsert the current period rollup,
 * and evaluate alerts. Every step is idempotent, so a missed run, a mid-month
 * deploy, or a multi-day outage all repair on the next successful run.
 */
export async function runBillingRollup(now: Date = new Date()): Promise<{ tenantsProcessed: number; errors: number }> {
  const active = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.isActive, true));
  let errors = 0;
  for (const t of active) {
    try {
      await rollupTenant(t.id, now);
    } catch (err) {
      errors++;
      log.error({ err, tenantId: t.id }, 'Tenant billing rollup failed (will retry next run)');
    }
  }
  log.info({ tenantsProcessed: active.length, errors }, 'Billing rollup complete');
  return { tenantsProcessed: active.length, errors };
}

async function rollupTenant(tenantId: string, now: Date): Promise<void> {
  await ensureWallet(tenantId);
  const [wallet] = await db.select().from(tenantWallets).where(eq(tenantWallets.tenantId, tenantId)).limit(1);
  if (!wallet) throw new Error(`wallet missing after ensureWallet: ${tenantId}`);
  const marginPct = Number(wallet.marginPct);

  const monthStart = utcMonthStart(now);
  const nextMonthStart = utcNextMonthStart(now);
  const flags: RollupFlags = { pausedNow: false, lowBalanceCrossed: false };

  // 1. Close EVERY prior month that isn't fully invoiced yet — heals gaps that
  //    span a month boundary (multi-week outage, first-ever run after signup
  //    month passed) and retries a period left 'closed' but not 'invoiced'.
  await closePriorMonths(tenantId, monthStart, marginPct, flags);

  // 2. Current month: aggregate all of it once; debit COMPLETED days only.
  const monthDays = await aggregateDays(tenantId, monthStart, nextMonthStart);
  const todayStr = utcDayString(now);
  const completedDays = monthDays.filter((d) => d.day < todayStr);
  await debitDays(tenantId, completedDays, marginPct, flags);

  // 3. Upsert the current period rollup (month-to-date, includes today).
  const agg = foldPeriod(monthDays);
  await upsertPeriod(tenantId, monthStart, nextMonthStart, agg);

  // 4. Alerts.
  await evaluateAlerts(tenantId, wallet, agg, monthStart, flags);
}

/**
 * Walk forward from the earliest prior month that still needs work (a
 * non-invoiced period row, or a month with usage but no period row at all) up to
 * the current month, closing+invoicing each. Bounded loop; already-invoiced
 * months are cheap early-returns.
 */
async function closePriorMonths(tenantId: string, currentMonthStart: Date, marginPct: number, flags: RollupFlags): Promise<void> {
  const start = await earliestPendingMonth(tenantId, currentMonthStart);
  if (!start) return;
  let m = start;
  let guard = 0;
  while (m.getTime() < currentMonthStart.getTime() && guard++ < 240) {
    await closeMonth(tenantId, m, utcNextMonthStart(m), marginPct, flags);
    m = utcNextMonthStart(m);
  }
}

/**
 * Earliest prior month (< current) that still needs closing: the min of the
 * earliest non-invoiced period start and the earliest usage month that has no
 * period row yet. Null when everything prior is already invoiced.
 */
async function earliestPendingMonth(tenantId: string, currentMonthStart: Date): Promise<Date | null> {
  const res = await db.execute(sql`
    SELECT min(m) AS m FROM (
      SELECT min(period_start) AS m FROM billing_periods
        WHERE tenant_id = ${tenantId} AND status <> 'invoiced' AND period_start < ${currentMonthStart}
      UNION ALL
      SELECT min(date_trunc('month', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS m
        FROM llm_usage_logs u
        WHERE u.tenant_id = ${tenantId} AND u.created_at < ${currentMonthStart}
          AND NOT EXISTS (
            SELECT 1 FROM billing_periods p
            WHERE p.tenant_id = ${tenantId}
              AND p.period_start = date_trunc('month', u.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
    ) x
  `);
  const rows = (res as unknown as { rows: { m: Date | string | null }[] }).rows ?? [];
  const m = rows[0]?.m;
  return m ? new Date(m) : null;
}

/**
 * Close and invoice a single month. Idempotent across every failure point:
 * creates the period row if missing (gap heal), re-aggregates and re-debits
 * (both idempotent), and retries invoicing whenever the period is not yet
 * 'invoiced' — so a crash between 'closed' and 'invoiced' self-heals. A
 * zero-charge month is finalized as 'invoiced' (nothing to bill) so it isn't
 * reprocessed forever.
 */
async function closeMonth(tenantId: string, monthStart: Date, monthEnd: Date, marginPct: number, flags: RollupFlags): Promise<void> {
  const [existing] = await db
    .select({ id: billingPeriods.id, status: billingPeriods.status })
    .from(billingPeriods)
    .where(and(eq(billingPeriods.tenantId, tenantId), eq(billingPeriods.periodStart, monthStart)))
    .limit(1);
  if (existing && existing.status === 'invoiced') return; // already finalized

  // Re-aggregate the FULL month and debit every day BEFORE invoicing.
  const days = await aggregateDays(tenantId, monthStart, monthEnd);
  const agg = foldPeriod(days);
  await debitDays(tenantId, days, marginPct, flags);

  if (existing) {
    await db
      .update(billingPeriods)
      .set({ ...periodColumns(agg), status: 'closed', closedAt: new Date(), updatedAt: new Date() })
      .where(eq(billingPeriods.id, existing.id));
  } else {
    await db
      .insert(billingPeriods)
      .values({ tenantId, periodStart: monthStart, periodEnd: monthEnd, status: 'closed', ...periodColumns(agg), closedAt: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [billingPeriods.tenantId, billingPeriods.periodStart],
        set: { ...periodColumns(agg), status: 'closed', closedAt: new Date(), updatedAt: new Date() },
      });
  }

  const [period] = await db
    .select({ id: billingPeriods.id })
    .from(billingPeriods)
    .where(and(eq(billingPeriods.tenantId, tenantId), eq(billingPeriods.periodStart, monthStart)))
    .limit(1);
  if (!period) return;

  const invoice = await generateInvoice(period.id);
  if (invoice || Number(agg.totalCostUsd) <= 0) {
    // Mark finalized — invoiced, or a zero-charge month with nothing to bill.
    await db.update(billingPeriods).set({ status: 'invoiced', updatedAt: new Date() }).where(eq(billingPeriods.id, period.id));
  }
  log.info({ tenantId, periodStart: monthStart, invoiced: !!invoice }, 'Month closed');
}

async function debitDays(tenantId: string, days: DayAgg[], marginPct: number, flags: RollupFlags): Promise<void> {
  for (const day of days) {
    if (day.rawCost <= 0) continue; // skip zero-cost days (incl. all-unpriced days)
    const charged = applyMargin(day.rawCost, marginPct);
    const res = await applyLedgerEntry({
      tenantId,
      type: 'debit_usage',
      amountUsd: toUsd(-charged, 6),
      reference: `usage:${tenantId}:${day.day}`,
      description: `LLM usage ${day.day}`,
      metadata: {
        date: day.day,
        llmCalls: day.llmCalls,
        unpricedRows: day.unpricedRows,
        marginPct: String(marginPct),
        rawCostUsd: toUsd(day.rawCost, 6),
        byAgent: day.byAgent,
      },
    });
    if (res.pausedNow) flags.pausedNow = true;
    if (res.lowBalanceCrossed) flags.lowBalanceCrossed = true;
  }
}

async function evaluateAlerts(
  tenantId: string,
  wallet: typeof tenantWallets.$inferSelect,
  agg: PeriodAgg,
  monthStart: Date,
  flags: RollupFlags,
): Promise<void> {
  const monthPrefix = utcMonthPrefix(monthStart);

  if (agg.unpricedRows > 0) {
    await raiseAlert({
      tenantId,
      type: 'billing.unpriced',
      severity: 'warning',
      title: 'Unpriced usage detected',
      body: `${agg.unpricedRows} usage record(s) this month have no model price and are excluded from cost totals.`,
      dedupeKey: `unpriced:${tenantId}:${monthPrefix}`,
      metadata: { unpricedRows: agg.unpricedRows },
    });
  }

  const budget = wallet.monthlyBudgetUsd != null ? Number(wallet.monthlyBudgetUsd) : null;
  if (budget && budget > 0) {
    const charged = Number(agg.totalCostUsd) * (1 + Number(wallet.marginPct) / 100);
    const pct = (charged / budget) * 100;
    if (pct >= 100) {
      await raiseAlert({
        tenantId,
        type: 'budget.usd',
        severity: 'critical',
        title: 'Monthly USD budget exceeded',
        body: `Charged $${charged.toFixed(2)} of $${budget.toFixed(2)} budget (${pct.toFixed(0)}%).`,
        dedupeKey: `budget-usd:${tenantId}:${monthPrefix}:100`,
        webhookEvent: 'budget.exceeded',
        webhookData: { charged: charged.toFixed(2), budget: budget.toFixed(2), pct: pct.toFixed(0) },
      });
    } else if (pct >= 80) {
      await raiseAlert({
        tenantId,
        type: 'budget.usd',
        severity: 'warning',
        title: 'Monthly USD budget at 80%',
        body: `Charged $${charged.toFixed(2)} of $${budget.toFixed(2)} budget (${pct.toFixed(0)}%).`,
        dedupeKey: `budget-usd:${tenantId}:${monthPrefix}:80`,
        webhookEvent: 'budget.threshold_reached',
        webhookData: { charged: charged.toFixed(2), budget: budget.toFixed(2), pct: pct.toFixed(0) },
      });
    }
  }

  if (flags.pausedNow) {
    await raiseAlert({
      tenantId,
      type: 'wallet.paused',
      severity: 'critical',
      title: 'Wallet paused (balance depleted)',
      body: 'Prepaid balance reached zero; agent responses are paused until top-up.',
      dedupeKey: `wallet:paused:${tenantId}:${utcDayString(new Date())}`,
      webhookEvent: 'wallet.paused',
      webhookData: {},
    });
  }
  if (flags.lowBalanceCrossed) {
    await raiseAlert({
      tenantId,
      type: 'wallet.low_balance',
      severity: 'warning',
      title: 'Wallet balance low',
      body: 'Prepaid balance dropped below the low-balance threshold.',
      dedupeKey: `wallet:low:${tenantId}:${utcDayString(new Date())}`,
      webhookEvent: 'wallet.low_balance',
      webhookData: {},
    });
  }
}

// === Aggregation ===

interface RawDayRow {
  day: string;
  slug: string | null;
  calls: string;
  cost: string;
  unpriced: string;
  ti: string;
  tokout: string;
  tcw: string;
  tcr: string;
}

/** Per (UTC day, agent) usage aggregation over [start, end). */
async function aggregateDays(tenantId: string, start: Date, end: Date): Promise<DayAgg[]> {
  const result = await db.execute(sql`
    SELECT
      to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      agent_type_slug AS slug,
      count(*)::text AS calls,
      coalesce(sum(cost_usd), 0)::text AS cost,
      count(*) FILTER (WHERE cost_usd IS NULL)::text AS unpriced,
      coalesce(sum(tokens_input), 0)::text AS ti,
      coalesce(sum(tokens_output), 0)::text AS tokout,
      coalesce(sum(tokens_cache_write), 0)::text AS tcw,
      coalesce(sum(coalesce(tokens_cache_read, tokens_cached)), 0)::text AS tcr
    FROM llm_usage_logs
    WHERE tenant_id = ${tenantId} AND created_at >= ${start} AND created_at < ${end}
    GROUP BY day, slug
    ORDER BY day
  `);
  const rows = (result as unknown as { rows: RawDayRow[] }).rows ?? [];

  const byDay = new Map<string, DayAgg>();
  for (const r of rows) {
    const entry = byDay.get(r.day) ?? { day: r.day, rawCost: 0, llmCalls: 0, unpricedRows: 0, byAgent: [] };
    const calls = Number(r.calls);
    const cost = Number(r.cost);
    entry.rawCost += cost;
    entry.llmCalls += calls;
    entry.unpricedRows += Number(r.unpriced);
    entry.byAgent.push({
      slug: r.slug,
      calls,
      tokensInput: Number(r.ti),
      tokensOutput: Number(r.tokout),
      tokensCacheWrite: Number(r.tcw),
      tokensCacheRead: Number(r.tcr),
      costUsd: cost.toString(),
    });
    byDay.set(r.day, entry);
  }
  return [...byDay.values()];
}

function foldPeriod(days: DayAgg[]): PeriodAgg {
  let rawCost = 0, calls = 0, unpriced = 0, ti = 0, to = 0, tcw = 0, tcr = 0;
  const agentMap = new Map<string, AgentUsageRollup>();
  for (const d of days) {
    rawCost += d.rawCost;
    calls += d.llmCalls;
    unpriced += d.unpricedRows;
    for (const a of d.byAgent) {
      ti += a.tokensInput; to += a.tokensOutput; tcw += a.tokensCacheWrite; tcr += a.tokensCacheRead;
      const key = a.slug ?? '(none)';
      const m = agentMap.get(key) ?? {
        slug: a.slug, calls: 0, tokensInput: 0, tokensOutput: 0, tokensCacheWrite: 0, tokensCacheRead: 0, costUsd: '0',
      };
      m.calls += a.calls;
      m.tokensInput += a.tokensInput;
      m.tokensOutput += a.tokensOutput;
      m.tokensCacheWrite += a.tokensCacheWrite;
      m.tokensCacheRead += a.tokensCacheRead;
      m.costUsd = (Number(m.costUsd) + Number(a.costUsd)).toString();
      agentMap.set(key, m);
    }
  }
  return {
    totalCostUsd: toUsd(rawCost, 6),
    totalTokensInput: ti,
    totalTokensOutput: to,
    totalTokensCacheWrite: tcw,
    totalTokensCacheRead: tcr,
    llmCalls: calls,
    unpricedRows: unpriced,
    byAgent: [...agentMap.values()],
  };
}

function periodColumns(agg: PeriodAgg) {
  return {
    totalCostUsd: agg.totalCostUsd,
    totalTokensInput: agg.totalTokensInput,
    totalTokensOutput: agg.totalTokensOutput,
    totalTokensCacheWrite: agg.totalTokensCacheWrite,
    totalTokensCacheRead: agg.totalTokensCacheRead,
    llmCalls: agg.llmCalls,
    unpricedRows: agg.unpricedRows,
    byAgent: agg.byAgent,
  };
}

async function upsertPeriod(tenantId: string, start: Date, end: Date, agg: PeriodAgg): Promise<void> {
  await db
    .insert(billingPeriods)
    .values({ tenantId, periodStart: start, periodEnd: end, status: 'open', ...periodColumns(agg), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [billingPeriods.tenantId, billingPeriods.periodStart],
      // status intentionally omitted — never reopen a closed/invoiced period.
      set: { ...periodColumns(agg), updatedAt: new Date() },
    });
}
