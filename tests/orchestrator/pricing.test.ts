import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));

import { computeCostUsd, lookupPricing, clearPricingCache } from '../../src/orchestrator/pricing.js';

let mock: MockDb;

function priceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price-1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputPerMtok: '3.000000',
    outputPerMtok: '15.000000',
    cacheWritePerMtok: '3.750000',
    cacheReadPerMtok: '0.300000',
    effectiveFrom: new Date('2025-01-01T00:00:00Z'),
    effectiveTo: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  clearPricingCache();
});

describe('computeCostUsd', () => {
  it('sums input + output + both cache tiers (pure addition, no double-subtract)', async () => {
    mock.queueSelect('model_pricing', [priceRow()]);
    const { costUsd, pricingId } = await computeCostUsd('anthropic', 'claude-sonnet-4-6', {
      input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000,
    });
    // 3 + 15 + 3.75 + 0.30 = 22.05
    expect(costUsd).toBeCloseTo(22.05, 6);
    expect(pricingId).toBe('price-1');
  });

  it('does not subtract cache tokens from input (input_tokens already excludes them)', async () => {
    mock.queueSelect('model_pricing', [priceRow()]);
    const { costUsd } = await computeCostUsd('anthropic', 'claude-sonnet-4-6', {
      input: 500_000, output: 0, cacheWrite: 0, cacheRead: 500_000,
    });
    // 0.5*3 + 0.5*0.30 = 1.65  (old buggy code would have done (500k-500k)/1e6*3 = 0)
    expect(costUsd).toBeCloseTo(1.65, 6);
  });

  it('returns null cost + null pricingId for an unknown model (never silent 0)', async () => {
    mock.queueSelect('model_pricing', []); // no active row
    const { costUsd, pricingId } = await computeCostUsd('anthropic', 'claude-unknown-9', {
      input: 100, output: 50, cacheWrite: 0, cacheRead: 0,
    });
    expect(costUsd).toBeNull();
    expect(pricingId).toBeNull();
  });
});

describe('lookupPricing cache', () => {
  it('caches the resolved price row and does not re-query within the TTL', async () => {
    mock.queueSelect('model_pricing', [priceRow()]);
    const at = new Date('2026-07-01T00:00:00Z');
    const first = await lookupPricing('anthropic', 'claude-sonnet-4-6', at);
    const second = await lookupPricing('anthropic', 'claude-sonnet-4-6', at);
    expect(first?.id).toBe('price-1');
    expect(second?.id).toBe('price-1');
    // Only one row was queued; a second DB hit would have resolved to [] → null.
    expect(second).not.toBeNull();
  });

  it('caches negative results (unknown model) so misses do not re-query', async () => {
    mock.queueSelect('model_pricing', []);
    const at = new Date('2026-07-01T00:00:00Z');
    const first = await lookupPricing('anthropic', 'nope', at);
    const second = await lookupPricing('anthropic', 'nope', at);
    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
