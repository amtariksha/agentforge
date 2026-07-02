import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder, getHandlerMock } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  getHandlerMock: vi.fn(),
}));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));

vi.mock('../../src/tools/tenant-gateway/registry.js', () => ({
  getHandler: getHandlerMock,
}));

import { executeTool } from '../../src/tools/executor.js';

let mock: MockDb;

function toolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool-1',
    tenantId: 't1',
    name: 'get_orders',
    description: 'Get orders',
    category: 'read',
    requiresHitl: false,
    requiresUserConfirm: false,
    parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    backendMapping: { type: 'internal', handler: 'swarg-food.getOrders' },
    executionConfig: { timeoutMs: 5000 },
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  };
}

const ctx = { tenantId: 't1', tenantSlug: 'swarg-food', userId: 'u1', conversationId: 'c1', agentTypeSlug: 'support' };

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  getHandlerMock.mockReset();
});

describe('internal gateway dispatch', () => {
  it('resolves the handler and passes tenant/user/conversation context', async () => {
    mock.queueSelect('tools', [toolRow()]);
    const handler = vi.fn().mockResolvedValue({ success: true, data: { orders: [] }, durationMs: 0 });
    getHandlerMock.mockReturnValue(handler);

    const res = await executeTool('get_orders', { order_id: '123' }, ctx);

    expect(res.success).toBe(true);
    expect(getHandlerMock).toHaveBeenCalledWith('swarg-food', 'getOrders');
    expect(handler).toHaveBeenCalledWith({ order_id: '123' }, { tenantId: 't1', userId: 'u1', conversationId: 'c1' });
  });

  it('returns TOOL_NOT_FOUND when the tenant-scoped tool lookup is empty', async () => {
    mock.queueSelect('tools', []);
    const res = await executeTool('nope', { order_id: '1' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('TOOL_NOT_FOUND');
  });
});

describe('gates before execution', () => {
  it('rejects malformed params with INVALID_PARAMS before any handler call', async () => {
    mock.queueSelect('tools', [toolRow()]);
    const handler = vi.fn();
    getHandlerMock.mockReturnValue(handler);

    const res = await executeTool('get_orders', {}, ctx); // missing required order_id
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_PARAMS');
    expect(handler).not.toHaveBeenCalled();
  });

  it('short-circuits write tools to a dry run in shadow mode', async () => {
    mock.queueSelect('tools', [toolRow({ category: 'write' })]);
    const handler = vi.fn();
    getHandlerMock.mockReturnValue(handler);

    const res = await executeTool('get_orders', { order_id: '1' }, { ...ctx, shadowMode: true });
    expect(res.success).toBe(true);
    expect((res.data as { dryRun?: boolean }).dryRun).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still executes read tools in shadow mode', async () => {
    mock.queueSelect('tools', [toolRow({ category: 'read' })]);
    const handler = vi.fn().mockResolvedValue({ success: true, data: {}, durationMs: 0 });
    getHandlerMock.mockReturnValue(handler);

    const res = await executeTool('get_orders', { order_id: '1' }, { ...ctx, shadowMode: true });
    expect(res.success).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it('gates HITL/confirm tools with HITL_REQUIRED and does not run the handler', async () => {
    mock.queueSelect('tools', [toolRow({ category: 'destructive', requiresHitl: true })]);
    const handler = vi.fn();
    getHandlerMock.mockReturnValue(handler);

    const res = await executeTool('get_orders', { order_id: '1' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('HITL_REQUIRED');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('timeout / retry / fallbackMessage', () => {
  it('times out a hanging handler', async () => {
    mock.queueSelect('tools', [toolRow({ executionConfig: { timeoutMs: 20 } })]);
    getHandlerMock.mockReturnValue(() => new Promise(() => { /* never resolves */ }));

    const res = await executeTool('get_orders', { order_id: '1' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('EXECUTION_ERROR');
    expect(res.error?.message).toMatch(/timed out/);
  });

  it('retries a failing handler up to retryCount and then succeeds', async () => {
    mock.queueSelect('tools', [toolRow({ executionConfig: { timeoutMs: 5000, retryCount: 2 } })]);
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce({ success: true, data: { ok: 1 }, durationMs: 0 });
    getHandlerMock.mockReturnValue(handler);

    const res = await executeTool('get_orders', { order_id: '1' }, ctx);
    expect(res.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('uses fallbackMessage when all attempts are exhausted', async () => {
    mock.queueSelect('tools', [toolRow({ executionConfig: { timeoutMs: 5000, retryCount: 1, fallbackMessage: 'Service unavailable, try later.' } })]);
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    getHandlerMock.mockReturnValue(handler);

    const res = await executeTool('get_orders', { order_id: '1' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('EXECUTION_ERROR');
    expect(res.error?.message).toBe('Service unavailable, try later.');
    expect(handler).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe('external HTTP path', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('substitutes path params and maps the response envelope', async () => {
    mock.queueSelect('tools', [toolRow({
      backendMapping: {
        type: 'external', method: 'GET', endpoint: 'https://api.test/orders/{order_id}',
        responseMapping: { successField: 'ok', dataField: 'data', errorField: 'err' },
      },
    })]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, data: { total: 5 } }) });

    const res = await executeTool('get_orders', { order_id: '42' }, ctx);

    expect(fetchMock).toHaveBeenCalledWith('https://api.test/orders/42', expect.objectContaining({ method: 'GET' }));
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ total: 5 });
  });

  it('maps a non-ok HTTP response to HTTP_<status>', async () => {
    mock.queueSelect('tools', [toolRow({
      backendMapping: { type: 'external', method: 'GET', endpoint: 'https://api.test/orders/{order_id}' },
    })]);
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });

    const res = await executeTool('get_orders', { order_id: '42' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('HTTP_503');
  });
});
