/**
 * One-time backfill after the tokensCached → tokensCacheWrite/tokensCacheRead
 * split.
 *
 * Legacy rows stored only cache-READ tokens in `tokens_cached`. Copy that into
 * `tokens_cache_read`; leave `tokens_cache_write` NULL — old code never captured
 * `cache_creation_input_tokens`, so the write-tier count is genuinely unknown
 * and must NOT be fabricated as 0. Do NOT recompute historical `cost_usd`: those
 * numbers came from the old (buggy) formula and lack write-tier data;
 * `pricing_id IS NULL` marks them as legacy.
 *
 * Idempotent: only touches rows where tokens_cached is set and
 * tokens_cache_read is still NULL. Safe to re-run.
 *
 * Run:  npx tsx scripts/backfill-cache-token-split.ts
 */
import { and, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, pool } from '../src/shared/db.js';
import { llmUsageLogs } from '../src/shared/schema/index.js';

async function main() {
  console.log('=== Backfill cache-token split ===');
  const result = await db.update(llmUsageLogs)
    .set({ tokensCacheRead: sql`${llmUsageLogs.tokensCached}` })
    .where(and(
      isNotNull(llmUsageLogs.tokensCached),
      isNull(llmUsageLogs.tokensCacheRead),
    ))
    .returning({ id: llmUsageLogs.id });

  console.log(`Backfilled tokens_cache_read on ${result.length} legacy row(s). tokens_cache_write left NULL.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
