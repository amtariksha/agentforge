import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder, queueMock } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  queueMock: { webhookDeliveryQueue: { add: vi.fn(async (_name: string, _payload: unknown, _opts?: unknown) => ({})) } },
}));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/shared/queue.js', () => queueMock);

import { fireWebhooks, deliverWebhookById } from '../../src/gateway/outbound-webhooks.js';

let mock: MockDb;

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  queueMock.webhookDeliveryQueue.add.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('fireWebhooks', () => {
  it('enqueues { webhookConfigId, envelope } — no url/secret in the job payload', async () => {
    mock.queueSelect('webhook_configs', [{ id: 'wc1', events: ['invoice.generated'] }]);
    await fireWebhooks('t1', 'invoice.generated', { invoiceNumber: 'AF-1' });

    expect(queueMock.webhookDeliveryQueue.add).toHaveBeenCalledTimes(1);
    const payload = queueMock.webhookDeliveryQueue.add.mock.calls[0][1] as { webhookConfigId: string; envelope: { event: string } };
    expect(payload).toMatchObject({ webhookConfigId: 'wc1' });
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(payload.envelope.event).toBe('invoice.generated');
  });

  it('does not enqueue when no config subscribes to the event', async () => {
    mock.queueSelect('webhook_configs', [{ id: 'wc1', events: ['conversation_started'] }]);
    await fireWebhooks('t1', 'invoice.generated', {});
    expect(queueMock.webhookDeliveryQueue.add).not.toHaveBeenCalled();
  });
});

describe('deliverWebhookById', () => {
  it('re-fetches the config, signs, and POSTs the envelope', async () => {
    mock.queueSelect('webhook_configs', [{ id: 'wc1', url: 'https://hook.example/x', secret: 'sekret', isActive: true }]);
    const fetchMock = vi.fn(async (_url: string, _opts: { headers: Record<string, string> }) => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await deliverWebhookById('wc1', { event: 'invoice.generated', tenantId: 't1', timestamp: 'now', data: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    const opts = fetchMock.mock.calls[0][1];
    expect(url).toBe('https://hook.example/x');
    expect(opts.headers['X-AgentForge-Signature']).toMatch(/^sha256=/);
  });

  it('throws on a non-2xx response so BullMQ retries', async () => {
    mock.queueSelect('webhook_configs', [{ id: 'wc1', url: 'https://hook.example/x', secret: null, isActive: true }]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(deliverWebhookById('wc1', { event: 'invoice.generated', tenantId: 't1', timestamp: 'now', data: {} })).rejects.toThrow(/500/);
  });

  it('drops delivery (no fetch) when the config is missing or inactive', async () => {
    mock.queueSelect('webhook_configs', []); // config removed
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await deliverWebhookById('wc1', { event: 'invoice.generated', tenantId: 't1', timestamp: 'now', data: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
