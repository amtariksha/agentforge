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

  log.info('BullMQ workers started');

  return { consolidationWorker, slaWorker };
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
