import { pgTable, uuid, text, decimal, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Versioned model pricing — platform reference data, NOT tenant-scoped (no
 * tenant_id, no RLS). Rows are append-only: to change a price, close the active
 * version by setting `effectiveTo` and insert a new row with a new
 * `effectiveFrom`. `costUsd` on llm_usage_logs is computed at capture time by
 * joining the usage timestamp to the active row here, so historical costs stay
 * immutable even when prices change. Replaces the old hardcoded pricing dict in
 * agent-loop.ts (`estimateCost`).
 *
 * All per-MTok columns are USD per 1,000,000 tokens. For Anthropic, cache_write
 * is 1.25x input (5-min TTL) and cache_read is 0.1x input.
 */
export const modelPricing = pgTable('model_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),   // 'anthropic' | 'gemini' — matches llm_usage_logs.provider
  model: text('model').notNull(),         // exact string logged in llm_usage_logs.model
  inputPerMtok: decimal('input_per_mtok', { precision: 12, scale: 6 }).notNull(),
  outputPerMtok: decimal('output_per_mtok', { precision: 12, scale: 6 }).notNull(),
  cacheWritePerMtok: decimal('cache_write_per_mtok', { precision: 12, scale: 6 }).notNull(),
  cacheReadPerMtok: decimal('cache_read_per_mtok', { precision: 12, scale: 6 }).notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),  // NULL = currently active
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  // Uniqueness of a price version; doubles as the lookup index (provider, model, effective_from).
  uniqueIndex('uq_model_pricing_version').on(table.provider, table.model, table.effectiveFrom),
]);
