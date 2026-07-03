import { Queue, Worker } from 'bullmq';
import { redis } from './redis.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger({ module: 'queue' });

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
  password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
  username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
};

// === Queues ===

export const consolidationQueue = new Queue('memory-consolidation', { connection });
export const slaCheckQueue = new Queue('sla-check', { connection });
export const webhookDeliveryQueue = new Queue('webhook-delivery', { connection });
export const billingQueue = new Queue('billing', { connection });

// === Workers ===

export function startWorkers() {
  // Memory consolidation worker
  const consolidationWorker = new Worker(
    'memory-consolidation',
    async (job) => {
      const { runTenantConsolidation } = await import('../memory/consolidation.js');
      const { tenantId } = job.data as { tenantId: string };
      log.info({ tenantId, jobId: job.id }, 'Running memory consolidation');
      await runTenantConsolidation(tenantId);
    },
    { connection, concurrency: 1 },
  );

  consolidationWorker.on('completed', (job) => {
    log.info({ jobId: job?.id }, 'Consolidation job completed');
  });

  consolidationWorker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Consolidation job failed');
  });

  // SLA breach check worker
  const slaWorker = new Worker(
    'sla-check',
    async (job) => {
      const { checkSlaBreaches } = await import('./jobs/sla-checker.js');
      await checkSlaBreaches();
    },
    { connection, concurrency: 1 },
  );

  slaWorker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'SLA check job failed');
  });

  // Durable outbound-webhook delivery. The producer (fireWebhooks) enqueues
  // { webhookConfigId, envelope }; the worker re-fetches url/secret and posts.
  const webhookWorker = new Worker(
    'webhook-delivery',
    async (job) => {
      const { deliverWebhookById } = await import('../gateway/outbound-webhooks.js');
      const { webhookConfigId, envelope } = job.data as {
        webhookConfigId: string;
        envelope: import('../gateway/outbound-webhooks.js').WebhookEnvelope;
      };
      await deliverWebhookById(webhookConfigId, envelope);
    },
    { connection, concurrency: 5 },
  );

  webhookWorker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, attempts: job?.attemptsMade, err }, 'Webhook delivery job failed');
  });

  // Billing: nightly rollup + on-demand invoice PDF rendering.
  const billingWorker = new Worker(
    'billing',
    async (job) => {
      if (job.name === 'invoice-pdf') {
        const { renderInvoicePdf } = await import('../billing/invoice-pdf.js');
        const { invoiceId } = job.data as { invoiceId: string };
        log.info({ invoiceId, jobId: job.id }, 'Rendering invoice PDF');
        await renderInvoicePdf(invoiceId);
        return;
      }
      const { runBillingRollup } = await import('../billing/rollup.js');
      log.info({ jobId: job.id }, 'Running billing rollup');
      await runBillingRollup();
    },
    { connection, concurrency: 1 },
  );

  billingWorker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, name: job?.name, err }, 'Billing job failed');
  });

  log.info('BullMQ workers started');

  return { consolidationWorker, slaWorker, webhookWorker, billingWorker };
}

// === Schedulers ===

export async function setupRecurringJobs() {
  // Memory consolidation: daily at 3 AM
  await consolidationQueue.upsertJobScheduler(
    'daily-consolidation',
    { pattern: '0 3 * * *' },
    {
      name: 'daily-consolidation',
      data: { tenantId: 'all' },
    },
  );

  // SLA breach check: every 5 minutes
  await slaCheckQueue.upsertJobScheduler(
    'sla-breach-check',
    { pattern: '*/5 * * * *' },
    {
      name: 'sla-breach-check',
      data: {},
    },
  );

  // Billing rollup: daily at 02:30 UTC (before the 03:00 consolidation). Retry
  // opts MUST live in the jobTemplate — scheduler-spawned jobs otherwise get
  // BullMQ's default of zero retries. `tz` pins the schedule to UTC to match
  // the UTC-month billing_periods.
  await billingQueue.upsertJobScheduler(
    'daily-billing-rollup',
    { pattern: '30 2 * * *', tz: 'UTC' },
    {
      name: 'daily-billing-rollup',
      data: {},
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 60000 } },
    },
  );

  log.info('Recurring jobs scheduled');
}

// === Job creators ===

export async function scheduleConsolidation(tenantId: string, delay?: number) {
  await consolidationQueue.add('consolidate-tenant', { tenantId }, {
    delay: delay ?? 0,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
  });
}

/** Enqueue the billing rollup on demand (testing/backfill, first-ever prod run). */
export async function enqueueBillingRollup() {
  await billingQueue.add('daily-billing-rollup', {}, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
  });
}

/** Enqueue an invoice PDF render. */
export async function enqueueInvoicePdf(invoiceId: string) {
  await billingQueue.add('invoice-pdf', { invoiceId }, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
  });
}
