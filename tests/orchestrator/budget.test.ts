import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';
import type { TenantConfig } from '../../src/shared/types/index.js';

const { holder, redisStore, redisMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const mock = {
    calls: { get: 0, setex: 0, exists: 0, incrby: 0 },
    async get(k: string) { mock.calls.get++; return store.get(k) ?? null; },
    async setex(k: string, _ttl: number, v: string) { mock.calls.setex++; store.set(k, String(v)); return 'OK'; },
    async exists(k: string) { mock.calls.exists++; return store.has(k) ? 1 : 0; },
    async incrby(k: string, n: number) { mock.calls.incrby++; const cur = Number(store.get(k) ?? 0) + n; store.set(k, String(cur)); return cur; },
  };
  return { holder: { db: null as unknown }, redisStore: store, redisMock: mock };
});

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));

vi.mock('../../src/shared/redis.js', () => ({ redis: redisMock }));

import { checkBudget, incrementBudgetUsage } from '../../src/orchestrator/budget.js';

let mock: MockDb;

function config(monthlyTokenBudget: number): TenantConfig {
  return { ai: { monthlyTokenBudget } } as unknown as TenantConfig;
}

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  redisStore.clear();
  redisMock.calls = { get: 0, setex: 0, exists: 0, incrby: 0 };
});

describe('checkBudget', () => {
  it('is a no-op (no redis/db) when no monthly budget is configured', async () => {
    const res = await checkBudget('t1', config(0));
    expect(res.withinBudget).toBe(true);
    expect(redisMock.calls.get).toBe(0);
    expect(mock.updates.length + mock.inserts.length).toBe(0);
  });

  it('returns the cached value without querying the DB on a cache hit', async () => {
    redisStore.set('budget:usage:t1', '500');
    const res = await checkBudget('t1', config(1000));
    expect(res.used).toBe(500);
    expect(res.withinBudget).toBe(true);
    expect(res.percentUsed).toBeCloseTo(50, 5);
    expect(redisMock.calls.get).toBe(1);
  });

  it('queries the DB on a cache miss and caches the result', async () => {
    mock.queueSelect('llm_usage_logs', [{ totalTokens: 800 }]);
    const res = await checkBudget('t1', config(1000));
    expect(res.used).toBe(800);
    expect(res.withinBudget).toBe(true);
    expect(redisMock.calls.setex).toBe(1);
    expect(redisStore.get('budget:usage:t1')).toBe('800');
  });

  it('reports over-limit and a 100% crossing on a cache miss', async () => {
    mock.queueSelect('llm_usage_logs', [{ totalTokens: 1500 }]);
    const res = await checkBudget('t1', config(1000));
    expect(res.withinBudget).toBe(false);
    expect(res.thresholdCrossed).toBe(100);
  });

  it('signals an 80% crossing on a cache miss', async () => {
    mock.queueSelect('llm_usage_logs', [{ totalTokens: 850 }]);
    const res = await checkBudget('t1', config(1000));
    expect(res.withinBudget).toBe(true);
    expect(res.thresholdCrossed).toBe(80);
  });

  it('never signals a crossing on a cache hit (bounded to the miss path)', async () => {
    redisStore.set('budget:usage:t1', '1500');
    const res = await checkBudget('t1', config(1000));
    expect(res.withinBudget).toBe(false);
    expect(res.thresholdCrossed).toBeNull();
  });
});

describe('incrementBudgetUsage', () => {
  it('increments only when the counter key already exists', async () => {
    redisStore.set('budget:usage:t1', '100');
    await incrementBudgetUsage('t1', 25);
    expect(redisStore.get('budget:usage:t1')).toBe('125');
  });

  it('is a no-op when the counter key is absent (next checkBudget rebuilds it)', async () => {
    await incrementBudgetUsage('t1', 25);
    expect(redisStore.has('budget:usage:t1')).toBe(false);
    expect(redisMock.calls.incrby).toBe(0);
  });
});
