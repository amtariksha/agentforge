import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/shared/queue.js', () => ({ enqueueInvoicePdf: vi.fn(async () => {}) }));
vi.mock('../../src/billing/alerts.js', () => ({ raiseAlert: vi.fn(async () => ({ raised: true })) }));

import { generateInvoice } from '../../src/billing/invoice.js';
import { raiseAlert } from '../../src/billing/alerts.js';

let mock: MockDb;

function period(totalCostUsd: string) {
  return {
    id: 'p1', tenantId: 't1',
    periodStart: new Date(Date.UTC(2026, 6, 1)), periodEnd: new Date(Date.UTC(2026, 7, 1)),
    status: 'closed', totalCostUsd,
    totalTokensInput: 0, totalTokensOutput: 0, totalTokensCacheWrite: 0, totalTokensCacheRead: 0,
    llmCalls: 7, unpricedRows: 0, byAgent: [], closedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  };
}
function debit(amountUsd: string, rawCostUsd: string, slug: string, cost: string) {
  return {
    id: `led-${slug}`, tenantId: 't1', type: 'debit_usage', amountUsd, balanceAfterUsd: '0',
    reference: `usage:t1:2026-07-0X`, description: null,
    metadata: { rawCostUsd, byAgent: [{ slug, calls: 3, tokensInput: 100, tokensOutput: 50, tokensCacheWrite: 0, tokensCacheRead: 0, costUsd: cost }] },
    createdBy: null, createdAt: new Date(),
  };
}

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  vi.mocked(raiseAlert).mockClear();
});

describe('generateInvoice', () => {
  it('derives total from ledger debits and splits subtotal/margin', async () => {
    mock.queueSelect('billing_periods', [period('15.000000')]);
    mock.queueSelect('ledger_entries', [debit('-11.000000', '10.000000', 'support', '10.000000'), debit('-5.500000', '5.000000', 'sales', '5.000000')]);
    mock.queueSelect('tenants', [{ slug: 'acme' }]);
    mock.queueSelect('invoices', []);
    mock.queueReturning([{ id: 'inv1', invoiceNumber: 'AF-202607-acme' }]);

    await generateInvoice('p1');

    const ins = mock.inserts.find((i) => i.table === 'invoices');
    expect(ins).toBeTruthy();
    const v = ins!.values as Record<string, string>;
    expect(v.totalUsd).toBe('16.50');      // sum of |debits|
    expect(v.subtotalUsd).toBe('15.00');   // sum of raw costs
    expect(v.marginUsd).toBe('1.50');      // total - subtotal
    expect(v.invoiceNumber).toBe('AF-202607-acme');
  });

  it('returns null (no invoice) for a zero-charge period', async () => {
    mock.queueSelect('billing_periods', [period('0.000000')]);
    mock.queueSelect('ledger_entries', []);

    const result = await generateInvoice('p1');
    expect(result).toBeNull();
    expect(mock.inserts.find((i) => i.table === 'invoices')).toBeUndefined();
  });

  it('raises a drift alert when ledger subtotal disagrees with the period rollup', async () => {
    mock.queueSelect('billing_periods', [period('20.000000')]);   // rollup says 20, ledger says 15
    mock.queueSelect('ledger_entries', [debit('-11.000000', '10.000000', 'support', '10.000000'), debit('-5.500000', '5.000000', 'sales', '5.000000')]);
    mock.queueSelect('tenants', [{ slug: 'acme' }]);
    mock.queueSelect('invoices', []);
    mock.queueReturning([{ id: 'inv1', invoiceNumber: 'AF-202607-acme' }]);

    await generateInvoice('p1');
    expect(vi.mocked(raiseAlert)).toHaveBeenCalledWith(expect.objectContaining({ type: 'billing.drift' }));
  });

  it('suffixes the invoice number when a prior invoice exists for the period', async () => {
    mock.queueSelect('billing_periods', [period('15.000000')]);
    mock.queueSelect('ledger_entries', [debit('-11.000000', '10.000000', 'support', '10.000000')]);
    mock.queueSelect('tenants', [{ slug: 'acme' }]);
    mock.queueSelect('invoices', [{ id: 'old-voided' }]);          // a prior (e.g. voided) invoice exists
    mock.queueReturning([{ id: 'inv2', invoiceNumber: 'AF-202607-acme-r2' }]);

    await generateInvoice('p1');
    const ins = mock.inserts.find((i) => i.table === 'invoices');
    expect((ins!.values as Record<string, string>).invoiceNumber).toBe('AF-202607-acme-r2');
  });
});
