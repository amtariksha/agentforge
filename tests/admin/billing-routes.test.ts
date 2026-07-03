import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';
import { buildApp, bearer } from '../helpers/build-app.js';

const { holder, redisMock, queueMock } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  redisMock: { get: async () => null, setex: async () => 'OK', del: async () => 1 },
  queueMock: { enqueueBillingRollup: vi.fn(async () => {}), enqueueInvoicePdf: vi.fn(async () => {}) },
}));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/shared/redis.js', () => ({ redis: redisMock }));
vi.mock('../../src/shared/queue.js', () => queueMock);

import { analyticsRoutes } from '../../src/admin/analytics/routes.js';
import { billingRoutes } from '../../src/admin/billing/routes.js';

let mock: MockDb;
beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  queueMock.enqueueBillingRollup.mockClear();
});

describe('analytics route scoping', () => {
  it('403s a non-super-admin reading another tenant\'s costs', async () => {
    const app = await buildApp(analyticsRoutes);
    const res = await app.inject({ method: 'GET', url: '/admin/analytics/tenantB/costs', headers: { authorization: bearer('admin', 'tenantA') } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('403s a non-super-admin on the platform-wide system-overview', async () => {
    const app = await buildApp(analyticsRoutes);
    const res = await app.inject({ method: 'GET', url: '/admin/analytics/system-overview', headers: { authorization: bearer('admin', 'tenantA') } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows a super-admin on system-overview', async () => {
    mock.queueSelect('conversations', [{ totalConversations: 3, activeConversations: 1 }]);
    mock.queueSelect('llm_usage_logs', [{ totalCost: '1.5', totalCalls: 10 }]);
    const app = await buildApp(analyticsRoutes);
    const res = await app.inject({ method: 'GET', url: '/admin/analytics/system-overview', headers: { authorization: bearer('super_admin', 'tenantA') } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('billing route auth', () => {
  it('403s a non-super-admin on wallet adjust', async () => {
    const app = await buildApp(billingRoutes);
    const res = await app.inject({
      method: 'POST', url: '/admin/billing/wallet/adjust',
      headers: { authorization: bearer('admin', 't1') },
      payload: { type: 'credit_manual', amountUsd: 10, reason: 'x', idempotencyKey: 'k1' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('400s a super-admin sending an invalid adjust body', async () => {
    const app = await buildApp(billingRoutes);
    const res = await app.inject({
      method: 'POST', url: '/admin/billing/wallet/adjust',
      headers: { authorization: bearer('super_admin', 't1') },
      payload: { type: 'credit_manual', amountUsd: -5, reason: '', idempotencyKey: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('enqueues a rollup for a super-admin', async () => {
    const app = await buildApp(billingRoutes);
    const res = await app.inject({ method: 'POST', url: '/admin/billing/rollup/run', headers: { authorization: bearer('super_admin', 't1') } });
    expect(res.statusCode).toBe(200);
    expect(queueMock.enqueueBillingRollup).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('401s without a token', async () => {
    const app = await buildApp(billingRoutes);
    const res = await app.inject({ method: 'GET', url: '/admin/billing/summary' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
