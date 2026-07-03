import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { db } from '../shared/db.js';
import { invoices, tenants, billingPeriods } from '../shared/schema/index.js';
import type { InvoiceLineItem } from '../shared/schema/index.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'invoice-pdf' });
const INVOICE_PDF_DIR = process.env.INVOICE_PDF_DIR ?? './data/invoices';

/**
 * Render an invoice to a PDF under INVOICE_PDF_DIR and store the path on the
 * invoice row. Idempotent-ish: overwrites the same file (named by invoice
 * number) on retry. Throws so BullMQ retries a failed render.
 */
export async function renderInvoicePdf(invoiceId: string): Promise<string> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!invoice) throw new Error(`invoice not found: ${invoiceId}`);

  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, invoice.tenantId)).limit(1);
  const [period] = await db
    .select({ unpriced: billingPeriods.unpricedRows })
    .from(billingPeriods)
    .where(eq(billingPeriods.id, invoice.billingPeriodId))
    .limit(1);

  await fs.mkdir(INVOICE_PDF_DIR, { recursive: true });
  const filePath = path.join(INVOICE_PDF_DIR, `${invoice.invoiceNumber}.pdf`);

  await writePdf(filePath, (doc) => {
    doc.fontSize(20).fillColor('#000').text('AgentForge');
    doc.fontSize(10).fillColor('#666').text('Usage Invoice');
    doc.moveDown();

    doc.fillColor('#000').fontSize(12).text(`Invoice: ${invoice.invoiceNumber}`);
    doc.text(`Tenant: ${tenant?.name ?? invoice.tenantId}`);
    doc.text(`Period: ${fmtDate(invoice.periodStart)} → ${fmtDate(invoice.periodEnd)}`);
    doc.text(`Status: ${invoice.status}`);
    doc.moveDown();

    doc.fontSize(11).text('Usage by agent', { underline: true });
    doc.moveDown(0.3);
    const items = (invoice.lineItems as InvoiceLineItem[] | null) ?? [];
    for (const li of items) {
      const tokens = li.tokensInput + li.tokensOutput;
      doc.fontSize(10).text(
        `${li.agentSlug ?? '(unattributed)'} — ${li.calls} calls, ${tokens} tokens — $${Number(li.costUsd).toFixed(4)}`,
      );
    }
    doc.moveDown();

    doc.fontSize(11);
    doc.text(`Subtotal (cost): $${Number(invoice.subtotalUsd).toFixed(2)}`);
    doc.text(`Margin (${Number(invoice.marginPct).toFixed(2)}%): $${Number(invoice.marginUsd).toFixed(2)}`);
    doc.fontSize(13).fillColor('#000').text(`Total: $${Number(invoice.totalUsd).toFixed(2)} ${invoice.currency}`);

    if (period && period.unpriced > 0) {
      doc.moveDown();
      doc.fontSize(8).fillColor('#a00').text(
        `Note: ${period.unpriced} usage record(s) were unpriced (unknown model) and are not reflected in the totals above.`,
      );
    }
  });

  await db.update(invoices).set({ pdfPath: filePath }).where(eq(invoices.id, invoiceId));
  log.info({ invoiceId, filePath }, 'Invoice PDF rendered');
  return filePath;
}

function writePdf(filePath: string, build: (doc: PDFKit.PDFDocument) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = createWriteStream(filePath);
    stream.on('finish', () => resolve());
    stream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(stream);
    build(doc);
    doc.end();
  });
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
