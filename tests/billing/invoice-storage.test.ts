import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(async (_url: string, _opts?: { method?: string }) => ({ ok: true, status: 200, body: null })),
}));
vi.mock('aws4fetch', () => ({ AwsClient: class { fetch = fetchMock; } }));

import { putInvoicePdf, isR2Configured } from '../../src/billing/invoice-storage.js';

const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
function clearR2() { for (const k of R2_VARS) delete process.env[k]; }
function setR2() {
  process.env.R2_ACCOUNT_ID = 'acct';
  process.env.R2_ACCESS_KEY_ID = 'ak';
  process.env.R2_SECRET_ACCESS_KEY = 'sk';
  process.env.R2_BUCKET = 'invoices-bucket';
}

let tmpDir: string;
beforeEach(() => {
  clearR2();
  fetchMock.mockClear();
  tmpDir = path.join(os.tmpdir(), `inv-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.INVOICE_PDF_DIR = tmpDir;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  clearR2();
});

describe('invoice-storage', () => {
  it('is not R2-configured unless all four env vars are set', () => {
    expect(isR2Configured()).toBe(false);
    process.env.R2_ACCOUNT_ID = 'acct'; // only one → still not configured
    expect(isR2Configured()).toBe(false);
  });

  it('writes to local disk and returns the file path when R2 is unset', async () => {
    const loc = await putInvoicePdf('AF-202607-acme', Buffer.from('%PDF-1.4 test'));
    expect(loc).toBe(path.join(tmpDir, 'AF-202607-acme.pdf'));
    expect(await fs.readFile(loc, 'utf8')).toContain('%PDF');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads to R2 (PUT) and returns an r2:// location when configured', async () => {
    setR2();
    expect(isR2Configured()).toBe(true);
    const loc = await putInvoicePdf('AF-202607-acme', Buffer.from('x'));
    expect(loc).toBe('r2://invoices/AF-202607-acme.pdf');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    const opts = fetchMock.mock.calls[0][1];
    expect(url).toContain('acct.r2.cloudflarestorage.com/invoices-bucket/invoices/AF-202607-acme.pdf');
    expect(opts?.method).toBe('PUT');
  });

  it('throws when the R2 PUT fails', async () => {
    setR2();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, body: null });
    await expect(putInvoicePdf('AF-1', Buffer.from('x'))).rejects.toThrow(/403/);
  });
});
