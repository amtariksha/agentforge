/**
 * Cost computation from the versioned `model_pricing` table.
 *
 * Replaces the old hardcoded `estimateCost` dict in agent-loop.ts. costUsd is
 * computed at capture time by joining the usage timestamp to the active price
 * row, so historical costs are immutable when prices change. Unknown models get
 * a structured warn + NULL cost (never a silent 0) so unpriced usage is visible
 * rather than under-reported.
 *
 * Token accounting is pure addition: Anthropic's `usage.input_tokens` already
 * EXCLUDES both cache tiers, so total billed input = input + cacheWrite +
 * cacheRead (this fixes the old double-subtraction bug).
 */
import { and, eq, lte, or, isNull, gt, desc } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { modelPricing } from '../shared/schema/index.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'pricing' });

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matching budget.ts precedent

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface PriceRow {
  id: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWritePerMtok: number;
  cacheReadPerMtok: number;
}

interface CacheEntry {
  row: PriceRow | null;
  expiresAt: number;
}

// Keyed by `${provider}:${model}`. Serves the "current" price (capture-time
// `at` ≈ now). Negative results are cached too so unknown models don't hit the
// DB on every call.
const cache = new Map<string, CacheEntry>();

/** Test hook — drops the in-memory price cache. */
export function clearPricingCache(): void {
  cache.clear();
}

/**
 * Look up the price version active at `at` for (provider, model).
 * Returns null when no version covers that timestamp.
 */
export async function lookupPricing(
  provider: string,
  model: string,
  at: Date,
  now: number = Date.now(),
): Promise<PriceRow | null> {
  const key = `${provider}:${model}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.row;
  }

  const [row] = await db
    .select()
    .from(modelPricing)
    .where(and(
      eq(modelPricing.provider, provider),
      eq(modelPricing.model, model),
      lte(modelPricing.effectiveFrom, at),
      or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, at)),
    ))
    .orderBy(desc(modelPricing.effectiveFrom))
    .limit(1);

  const priceRow: PriceRow | null = row
    ? {
        id: row.id,
        inputPerMtok: Number(row.inputPerMtok),
        outputPerMtok: Number(row.outputPerMtok),
        cacheWritePerMtok: Number(row.cacheWritePerMtok),
        cacheReadPerMtok: Number(row.cacheReadPerMtok),
      }
    : null;

  cache.set(key, { row: priceRow, expiresAt: now + CACHE_TTL_MS });
  return priceRow;
}

/**
 * Compute USD cost for a token breakdown. Returns `{ costUsd: null, pricingId:
 * null }` for unknown models (with a structured warn) so callers store NULL
 * rather than a fabricated 0.
 */
export async function computeCostUsd(
  provider: string,
  model: string,
  tokens: TokenBreakdown,
  at: Date = new Date(),
): Promise<{ costUsd: number | null; pricingId: string | null }> {
  const price = await lookupPricing(provider, model, at);
  if (!price) {
    log.warn({ event: 'model_pricing_missing', provider, model }, 'No active model_pricing row; storing null cost');
    return { costUsd: null, pricingId: null };
  }

  const costUsd =
    (tokens.input * price.inputPerMtok
      + tokens.output * price.outputPerMtok
      + tokens.cacheWrite * price.cacheWritePerMtok
      + tokens.cacheRead * price.cacheReadPerMtok) / 1_000_000;

  return { costUsd, pricingId: price.id };
}
