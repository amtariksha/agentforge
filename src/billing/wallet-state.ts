import { eq, and, gte, like, sql } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { tenantWallets, ledgerEntries, llmUsageLogs } from '../shared/schema/index.js';
import { redis } from '../shared/redis.js';
import { createChildLogger } from '../shared/utils/logger.js';
import { utcMonthStart, utcMonthPrefix } from './period.js';

const log = createChildLogger({ module: 'wallet-state' });

const PAUSE_CACHE_PREFIX = 'wallet:paused:';
const PAUSE_CACHE_TTL = 60; // seconds — pause must bite fast, so shorter than the 300s budget cache

/**
 * Whether the tenant is currently blocked from spending. Redis-cached 60s and
 * checked on BOTH hot paths (agent-loop, agent-stream). Postpaid tenants and
 * healthy-balance prepaid tenants short-circuit cheaply; only sub-threshold
 * prepaid tenants pay the extra uncached SUM that bounds nightly-debit overshoot
 * to ~cache-TTL by pausing on *effective* balance (stored balance minus the
 * un-debited month-to-date charge).
 */
export async function isTenantPaused(tenantId: string): Promise<boolean> {
  const cacheKey = `${PAUSE_CACHE_PREFIX}${tenantId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return cached === '1';

    const paused = await computePaused(tenantId);
    await redis.setex(cacheKey, PAUSE_CACHE_TTL, paused ? '1' : '0');
    return paused;
  } catch (err) {
    // FAIL OPEN. A billing-infra hiccup — Redis down, or the wallet tables not
    // migrated yet during a rolling deploy — must never break customer chat.
    // Worst case a depleted prepaid tenant gets a few extra messages until the
    // gate recovers; that is far preferable to blocking every turn.
    log.warn({ err, tenantId }, 'isTenantPaused failed — failing open (treating as not paused)');
    return false;
  }
}

export async function clearPausedCache(tenantId: string): Promise<void> {
  await redis.del(`${PAUSE_CACHE_PREFIX}${tenantId}`);
}

async function computePaused(tenantId: string): Promise<boolean> {
  const [wallet] = await db
    .select()
    .from(tenantWallets)
    .where(eq(tenantWallets.tenantId, tenantId))
    .limit(1);

  if (!wallet) return false;              // no wallet yet → nothing to enforce
  if (wallet.isPaused) return true;       // hard pause (auto_balance or manual) — honored for any mode
  if (wallet.billingMode !== 'prepaid') return false;   // postpaid never soft-pauses

  const balance = Number(wallet.balanceUsd);
  const threshold = Number(wallet.lowBalanceThresholdUsd);
  if (balance >= threshold) return false; // healthy → skip the expensive query

  const undebited = await undebitedMonthToDateCharge(tenantId, Number(wallet.marginPct));
  return balance - undebited <= 0;
}

/**
 * The charge a prepaid tenant has incurred this UTC month but not yet had
 * debited by the nightly rollup: monthRawCost*(1+margin) minus the sum of usage
 * debits already posted for the month. Approximate (margin snapshot may vary
 * per day) — it exists only to bound overshoot, not to bill.
 */
async function undebitedMonthToDateCharge(tenantId: string, marginPct: number): Promise<number> {
  const now = new Date();
  const monthStart = utcMonthStart(now);
  const [rawRow] = await db
    .select({ raw: sql<string>`coalesce(sum(cost_usd), 0)` })
    .from(llmUsageLogs)
    .where(and(eq(llmUsageLogs.tenantId, tenantId), gte(llmUsageLogs.createdAt, monthStart)));
  const monthRaw = Number(rawRow?.raw ?? 0);

  const prefix = `usage:${tenantId}:${utcMonthPrefix(now)}-`;
  const [debRow] = await db
    .select({ charged: sql<string>`coalesce(sum(-amount_usd), 0)` })
    .from(ledgerEntries)
    .where(and(
      eq(ledgerEntries.tenantId, tenantId),
      eq(ledgerEntries.type, 'debit_usage'),
      like(ledgerEntries.reference, `${prefix}%`),
    ));
  const alreadyDebited = Number(debRow?.charged ?? 0);

  const undebited = monthRaw * (1 + marginPct / 100) - alreadyDebited;
  if (undebited < 0) {
    log.debug({ tenantId, monthRaw, alreadyDebited }, 'Negative undebited charge (over-debited?) — clamping to 0');
  }
  return Math.max(0, undebited);
}
