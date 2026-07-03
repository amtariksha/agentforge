import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/gateway/outbound-webhooks.js', () => ({ fireWebhooks: vi.fn(async () => {}) }));

import { raiseAlert } from '../../src/billing/alerts.js';
import { fireWebhooks } from '../../src/gateway/outbound-webhooks.js';

let mock: MockDb;

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  vi.mocked(fireWebhooks).mockClear();
});

describe('raiseAlert', () => {
  it('inserts a notification and fires the paired webhook when newly raised', async () => {
    mock.queueReturning([{ id: 'n1' }]); // insert succeeded (not deduped)
    const res = await raiseAlert({
      tenantId: 't1', type: 'wallet.paused', severity: 'critical', title: 'Paused',
      dedupeKey: 'wallet:paused:t1:2026-07-02', webhookEvent: 'wallet.paused', webhookData: { x: 1 },
    });
    expect(res.raised).toBe(true);
    expect(vi.mocked(fireWebhooks)).toHaveBeenCalledWith('t1', 'wallet.paused', { x: 1 });
  });

  it('is deduped (no webhook) when the notification conflicts', async () => {
    mock.queueReturning([]); // onConflictDoNothing → nothing inserted
    const res = await raiseAlert({
      tenantId: 't1', type: 'wallet.paused', severity: 'critical', title: 'Paused',
      dedupeKey: 'wallet:paused:t1:2026-07-02', webhookEvent: 'wallet.paused',
    });
    expect(res.raised).toBe(false);
    expect(vi.mocked(fireWebhooks)).not.toHaveBeenCalled();
  });

  it('raises without a webhook when no webhookEvent is given', async () => {
    mock.queueReturning([{ id: 'n2' }]);
    const res = await raiseAlert({ tenantId: 't1', type: 'billing.unpriced', severity: 'warning', title: 'Unpriced' });
    expect(res.raised).toBe(true);
    expect(vi.mocked(fireWebhooks)).not.toHaveBeenCalled();
  });
});
