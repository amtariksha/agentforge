import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder, redisMock } = vi.hoisted(() => {
  const mock = {
    calls: { del: 0 },
    async del(_k: string) { mock.calls.del++; return 1; },
    async get() { return null; },
    async setex() { return 'OK'; },
  };
  return { holder: { db: null as unknown }, redisMock: mock };
});

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/shared/redis.js', () => ({ redis: redisMock }));

import { applyLedgerEntry } from '../../src/billing/ledger.js';

let mock: MockDb;

interface WalletOpts {
  billingMode?: string;
  balanceUsd?: string;
  isPaused?: boolean;
  pausedReason?: string | null;
  lowBalanceThresholdUsd?: string;
  lowBalanceNotifiedAt?: Date | null;
}
function wallet(o: WalletOpts = {}) {
  return {
    id: 'w1', tenantId: 't1',
    balanceUsd: o.balanceUsd ?? '100.000000',
    billingMode: o.billingMode ?? 'postpaid',
    marginPct: '0',
    monthlyBudgetUsd: null,
    lowBalanceThresholdUsd: o.lowBalanceThresholdUsd ?? '10',
    isPaused: o.isPaused ?? false,
    pausedReason: o.pausedReason ?? null,
    pausedAt: null,
    lowBalanceNotifiedAt: o.lowBalanceNotifiedAt ?? null,
    currency: 'USD',
    createdAt: new Date(), updatedAt: new Date(),
  };
}

/** Queue the select/returning sequence a non-replay applyLedgerEntry consumes. */
function queueApply(prior: ReturnType<typeof wallet>, newBalance: string) {
  mock.queueSelect('ledger_entries', []);          // pre-check: not already recorded
  mock.queueSelect('tenant_wallets', [prior]);     // FOR UPDATE read of prior state
  mock.queueReturning([{ balanceUsd: newBalance }]); // balance update RETURNING
  mock.queueReturning([{ id: 'entry1', tenantId: 't1', balanceAfterUsd: newBalance }]); // ledger insert RETURNING
}

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  redisMock.calls = { del: 0 };
});

describe('applyLedgerEntry', () => {
  it('applies a credit atomically and records the ledger row', async () => {
    queueApply(wallet({ balanceUsd: '100' }), '150.000000');
    const res = await applyLedgerEntry({ tenantId: 't1', type: 'credit_manual', amountUsd: '50.000000', reference: 'manual:k1' });

    expect(res.idempotentReplay).toBe(false);
    expect(res.balanceUsd).toBe('150.000000');
    expect(mock.transactions).toBe(1); // ran inside a transaction
    const ledgerInsert = mock.inserts.find((i) => i.table === 'ledger_entries');
    expect(ledgerInsert).toBeTruthy();
    expect((ledgerInsert!.values as { amountUsd: string }).amountUsd).toBe('50.000000');
    expect(redisMock.calls.del).toBe(1); // pause cache cleared
  });

  it('is an idempotent no-op when the reference already exists', async () => {
    mock.queueSelect('ledger_entries', [{ id: 'existing', balanceAfterUsd: '42.000000' }]);
    const res = await applyLedgerEntry({ tenantId: 't1', type: 'debit_usage', amountUsd: '-5', reference: 'usage:t1:2026-07-01' });

    expect(res.idempotentReplay).toBe(true);
    expect(res.entry.id).toBe('existing');
    // No balance mutation on replay.
    expect(mock.updates.find((u) => u.table === 'tenant_wallets')).toBeUndefined();
    expect(redisMock.calls.del).toBe(0);
  });

  it('auto-pauses a prepaid wallet at balance <= 0', async () => {
    queueApply(wallet({ billingMode: 'prepaid', balanceUsd: '1' }), '0.000000');
    const res = await applyLedgerEntry({ tenantId: 't1', type: 'debit_usage', amountUsd: '-1', reference: 'usage:t1:2026-07-02' });

    expect(res.pausedNow).toBe(true);
    const stateUpdate = mock.updates.filter((u) => u.table === 'tenant_wallets').map((u) => u.set as Record<string, unknown>);
    expect(stateUpdate.some((s) => s.isPaused === true && s.pausedReason === 'auto_balance')).toBe(true);
  });

  it('auto-resumes only an auto_balance pause on credit', async () => {
    queueApply(wallet({ billingMode: 'prepaid', balanceUsd: '-5', isPaused: true, pausedReason: 'auto_balance' }), '20.000000');
    const res = await applyLedgerEntry({ tenantId: 't1', type: 'credit_manual', amountUsd: '25', reference: 'manual:k2' });

    expect(res.resumedNow).toBe(true);
    const sets = mock.updates.filter((u) => u.table === 'tenant_wallets').map((u) => u.set as Record<string, unknown>);
    expect(sets.some((s) => s.isPaused === false && s.pausedReason === null)).toBe(true);
  });

  it('does NOT auto-resume a manual pause on credit', async () => {
    queueApply(wallet({ billingMode: 'prepaid', balanceUsd: '-5', isPaused: true, pausedReason: 'manual' }), '20.000000');
    const res = await applyLedgerEntry({ tenantId: 't1', type: 'credit_manual', amountUsd: '25', reference: 'manual:k3' });

    expect(res.resumedNow).toBe(false);
    const sets = mock.updates.filter((u) => u.table === 'tenant_wallets').map((u) => u.set as Record<string, unknown>);
    expect(sets.some((s) => s.isPaused === false)).toBe(false);
  });

  it('never auto-pauses a postpaid wallet even when negative', async () => {
    queueApply(wallet({ billingMode: 'postpaid', balanceUsd: '0' }), '-30.000000');
    const res = await applyLedgerEntry({ tenantId: 't1', type: 'debit_usage', amountUsd: '-30', reference: 'usage:t1:2026-07-03' });

    expect(res.pausedNow).toBe(false);
    const sets = mock.updates.filter((u) => u.table === 'tenant_wallets').map((u) => u.set as Record<string, unknown>);
    expect(sets.some((s) => s.isPaused === true)).toBe(false);
  });

  it('flags a low-balance crossing (prepaid, below threshold, not yet notified)', async () => {
    queueApply(wallet({ billingMode: 'prepaid', balanceUsd: '15', lowBalanceThresholdUsd: '10', lowBalanceNotifiedAt: null }), '5.000000');
    const res = await applyLedgerEntry({ tenantId: 't1', type: 'debit_usage', amountUsd: '-10', reference: 'usage:t1:2026-07-04' });

    expect(res.lowBalanceCrossed).toBe(true);
  });
});
