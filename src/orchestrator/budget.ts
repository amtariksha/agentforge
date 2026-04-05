import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { llmUsageLogs, tenants } from '../shared/schema/index.js';
import { redis } from '../shared/redis.js';
import { createChildLogger } from '../shared/utils/logger.js';
import type { TenantConfig } from '../shared/types/index.js';

const log = createChildLogger({ module: 'budget' });

const BUDGET_CACHE_KEY_PREFIX = 'budget:usage:';
const BUDGET_CACHE_TTL = 300; // 5 minutes

/**
 * Check if a tenant has exceeded their monthly token budget.
 * Returns true if under budget, false if over.
 */
export async function checkBudget(tenantId: string, config: TenantConfig): Promise<{
  withinBudget: boolean;
  used: number;
  limit: number;
  percentUsed: number;
}> {
  const limit = config.ai.monthlyTokenBudget;
  if (!limit || limit <= 0) {
    return { withinBudget: true, used: 0, limit: 0, percentUsed: 0 };
  }

  // Check cache first
  const cacheKey = `${BUDGET_CACHE_KEY_PREFIX}${tenantId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    const used = parseInt(cached, 10);
    const percentUsed = (used / limit) * 100;
    return { withinBudget: used < limit, used, limit, percentUsed };
  }

  // Query actual usage for current month
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);

  const [result] = await db.select({
    totalTokens: sql<number>`coalesce(sum(tokens_input + tokens_output), 0)`,
  }).from(llmUsageLogs)
    .where(and(
      eq(llmUsageLogs.tenantId, tenantId),
      gte(llmUsageLogs.createdAt, firstOfMonth),
    ));

  const used = Number(result.totalTokens);

  // Cache the result
  await redis.setex(cacheKey, BUDGET_CACHE_TTL, String(used));

  const percentUsed = (used / limit) * 100;

  if (used >= limit) {
    log.warn({ tenantId, used, limit, percentUsed: percentUsed.toFixed(1) }, 'Tenant budget exceeded');
  } else if (percentUsed >= 80) {
    log.info({ tenantId, percentUsed: percentUsed.toFixed(1) }, 'Tenant budget nearing limit');
  }

  return { withinBudget: used < limit, used, limit, percentUsed };
}

/**
 * Increment budget usage after an LLM call.
 * Updates the cached counter so we don't need to query DB every time.
 */
export async function incrementBudgetUsage(tenantId: string, tokensUsed: number): Promise<void> {
  const cacheKey = `${BUDGET_CACHE_KEY_PREFIX}${tenantId}`;
  const exists = await redis.exists(cacheKey);

  if (exists) {
    await redis.incrby(cacheKey, tokensUsed);
  }
  // If not cached, next checkBudget call will query fresh from DB
}
