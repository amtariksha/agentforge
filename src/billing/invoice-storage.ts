import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AwsClient } from 'aws4fetch';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'invoice-storage' });

const R2_PREFIX = 'r2://';

/** Local-disk directory, read at call time so it can be reconfigured/tested. */
function invoiceDir(): string {
  return process.env.INVOICE_PDF_DIR ?? './data/invoices';
}

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** R2 config from env, or null → fall back to local disk. All four vars required. */
function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (accountId && accessKeyId && secretAccessKey && bucket) {
    return { accountId, accessKeyId, secretAccessKey, bucket };
  }
  return null;
}

export function isR2Configured(): boolean {
  return r2Config() !== null;
}

function r2Url(cfg: R2Config, key: string): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`;
}

function r2Client(cfg: R2Config): AwsClient {
  return new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: 'auto', service: 's3' });
}

function objectKey(invoiceNumber: string): string {
  return `invoices/${invoiceNumber}.pdf`;
}

/**
 * Store a rendered invoice PDF and return the location persisted on
 * invoices.pdfPath. When R2 is configured the location is `r2://<key>`
 * (durable object storage, survives container/host loss); otherwise it's a
 * local absolute path. The reader (openInvoicePdf) dispatches on the scheme, so
 * both can coexist during a cutover.
 */
export async function putInvoicePdf(invoiceNumber: string, body: Buffer): Promise<string> {
  const cfg = r2Config();
  if (cfg) {
    const key = objectKey(invoiceNumber);
    const res = await r2Client(cfg).fetch(r2Url(cfg, key), {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/pdf' },
    });
    if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status}`);
    log.info({ invoiceNumber, key, bucket: cfg.bucket }, 'Invoice PDF stored in R2');
    return `${R2_PREFIX}${key}`;
  }

  const dir = invoiceDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${invoiceNumber}.pdf`);
  await fs.writeFile(filePath, body);
  log.info({ invoiceNumber, filePath }, 'Invoice PDF stored on local disk');
  return filePath;
}

/** Open a stored PDF for streaming, from R2 or local disk based on its location. */
export async function openInvoicePdf(location: string): Promise<Readable> {
  if (location.startsWith(R2_PREFIX)) {
    const cfg = r2Config();
    if (!cfg) throw new Error('invoice is stored in R2 but R2 is not configured');
    const key = location.slice(R2_PREFIX.length);
    const res = await r2Client(cfg).fetch(r2Url(cfg, key));
    if (!res.ok || !res.body) throw new Error(`R2 GET ${key} failed: ${res.status}`);
    return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  }
  return createReadStream(location);
}
