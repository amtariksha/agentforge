import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/billing/ledger.js', () => ({
  applyLedgerEntry: vi.fn(async () => ({ entry: {}, idempotentReplay: false, pausedNow: false, resumedNow: false, lowBalanceCrossed: false, balanceUsd: '0' })),
  ensureWallet: vi.fn(async () => {}),
}));
vi.mock('../../src/billing/invoice.js', () => ({ generateInvoice: vi.fn(async () => ({ id: 'inv1' })) }));
vi.mock('../../src/billing/alerts.js', () => ({ raiseAlert: vi.fn(async () => ({ raised: true })) }));

import { runBillingRollup } from '../../src/billing/rollup.js';
import { applyLedgerEntry } from '../../src/billing/ledger.js';
import { generateInvoice } from '../../src/billing/invoice.js';
import { raiseAlert } from '../../src/billing/alerts.js';

let mock: MockDb;

function wallet() {
  return { id: 'w1', tenantId: 't1', balanceUsd: '0', billingMode: 'postpaid', marginPct: '0', monthlyBudgetUsd: null, lowBalanceThresholdUsd: '10', isPaused: false, pausedReason: null, pausedAt: null, lowBalanceNotifiedAt: null, currency: 'USD', createdAt: new Date(), updatedAt: new Date() };
}
function dayRow(day: string, cost: string, unpriced = '0', slug: string | null = 'support') {
  return { day, slug, calls: '2', cost, unpriced, ti: '100', tokout: '50', tcw: '0', tcr: '0' };
}

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  vi.mocked(applyLedgerEntry).mockClear();
  vi.mocked(generateInvoice).mockClear();
  vi.mocked(raiseAlert).mockClear();
});

describe('runBillingRollup — self-healing debits (cold start, mid-month)', () => {
  it('debits completed cost-bearing days, skips zero-cost days, and flags unpriced', async () => {
    const now = new Date(Date.UTC(2026, 6, 15, 3, 0, 0)); // 2026-07-15 02:30ish UTC
    mock.queueSelect('tenants', [{ id: 't1' }]);
    mock.queueSelect('tenant_wallets', [wallet()]);
    mock.queueExecute({ rows: [{ m: null }] });         // earliestPendingMonth → nothing prior
    mock.queueExecute({ rows: [dayRow('2026-07-10', '10.000000'), dayRow('2026-07-11', '0', '1', null)] });

    const res = await runBillingRollup(now);

    expect(res.tenantsProcessed).toBe(1);
    // Only the cost-bearing, completed day is debited.
    expect(vi.mocked(applyLedgerEntry)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(applyLedgerEntry).mock.calls[0][0];
    expect(arg.reference).toBe('usage:t1:2026-07-10');
    expect(arg.type).toBe('debit_usage');
    // Period upserted, unpriced counted, unpriced alert raised.
    expect(mock.inserts.some((i) => i.table === 'billing_periods')).toBe(true);
    expect(vi.mocked(raiseAlert)).toHaveBeenCalledWith(expect.objectContaining({ type: 'billing.unpriced' }));
  });
});

describe('runBillingRollup — month close', () => {
  it('re-aggregates, debits, invoices, and marks the prior period invoiced', async () => {
    const now = new Date(Date.UTC(2026, 7, 1, 3, 0, 0)); // 2026-08-01 — closes July
    mock.queueSelect('tenants', [{ id: 't1' }]);
    mock.queueSelect('tenant_wallets', [wallet()]);
    mock.queueExecute({ rows: [{ m: new Date(Date.UTC(2026, 6, 1)) }] });  // earliestPendingMonth → July
    mock.queueSelect('billing_periods', [{ id: 'pp', status: 'open' }]);   // closeMonth: existing period
    mock.queueExecute({ rows: [dayRow('2026-07-20', '30.000000')] });      // July re-aggregation
    mock.queueSelect('billing_periods', [{ id: 'pp' }]);                   // closeMonth: id fetch after update
    mock.queueExecute({ rows: [] });                                       // current (Aug) month, empty

    await runBillingRollup(now);

    expect(vi.mocked(applyLedgerEntry)).toHaveBeenCalledWith(expect.objectContaining({ reference: 'usage:t1:2026-07-20' }));
    expect(vi.mocked(generateInvoice)).toHaveBeenCalledWith('pp');
    const periodSets = mock.updates.filter((u) => u.table === 'billing_periods').map((u) => (u.set as Record<string, unknown>).status);
    expect(periodSets).toContain('closed');
    expect(periodSets).toContain('invoiced');
  });

  it('retries invoicing a period left "closed" (crash between close and invoice)', async () => {
    const now = new Date(Date.UTC(2026, 7, 1, 3, 0, 0));
    mock.queueSelect('tenants', [{ id: 't1' }]);
    mock.queueSelect('tenant_wallets', [wallet()]);
    mock.queueExecute({ rows: [{ m: new Date(Date.UTC(2026, 6, 1)) }] });  // July still pending
    mock.queueSelect('billing_periods', [{ id: 'pp', status: 'closed' }]); // already closed, never invoiced
    mock.queueExecute({ rows: [dayRow('2026-07-20', '30.000000')] });
    mock.queueSelect('billing_periods', [{ id: 'pp' }]);
    mock.queueExecute({ rows: [] });

    await runBillingRollup(now);

    // A 'closed' (not 'invoiced') period is retried, not skipped.
    expect(vi.mocked(generateInvoice)).toHaveBeenCalledWith('pp');
  });
});
