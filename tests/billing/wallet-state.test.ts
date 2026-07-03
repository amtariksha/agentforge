import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder, redisState } = vi.hoisted(() => {
  const state = { value: null as string | null, throwOnGet: false };
  const mock = {
    async get(_k: string) { if (state.throwOnGet) throw new Error('redis down'); return state.value; },
    async setex() { return 'OK'; },
    async del() { return 1; },
  };
  return { holder: { db: null as unknown, redis: mock }, redisState: state };
});

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/shared/redis.js', () => ({ redis: holder.redis }));

import { isTenantPaused } from '../../src/billing/wallet-state.js';

let mock: MockDb;
beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  redisState.value = null;
  redisState.throwOnGet = false;
});

describe('isTenantPaused', () => {
  it('returns the cached decision without touching the DB', async () => {
    redisState.value = '1';
    expect(await isTenantPaused('t1')).toBe(true);
    redisState.value = '0';
    expect(await isTenantPaused('t1')).toBe(false);
  });

  it('is not paused when no wallet exists', async () => {
    mock.queueSelect('tenant_wallets', []); // no wallet row
    expect(await isTenantPaused('t1')).toBe(false);
  });

  it('reports a hard pause regardless of billing mode', async () => {
    mock.queueSelect('tenant_wallets', [{ tenantId: 't1', isPaused: true, billingMode: 'postpaid', balanceUsd: '5', lowBalanceThresholdUsd: '10', marginPct: '0' }]);
    expect(await isTenantPaused('t1')).toBe(true);
  });

  it('FAILS OPEN (not paused) when the store throws — never breaks chat', async () => {
    redisState.throwOnGet = true;
    expect(await isTenantPaused('t1')).toBe(false);
  });
});
