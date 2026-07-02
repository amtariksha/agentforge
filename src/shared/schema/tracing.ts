import { pgTable, uuid, text, jsonb, integer, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';
import { tenants } from './tenants.js';
import { modelPricing } from './pricing.js';

export const conversationTraces = pgTable('conversation_traces', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id).notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  turnNumber: integer('turn_number'),
  traceData: jsonb('trace_data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_traces_conversation').on(table.conversationId),
]);

export const llmUsageLogs = pgTable('llm_usage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  conversationId: uuid('conversation_id'),
  // Slug of the agent that drove this LLM call. Nullable for legacy rows and
  // for calls outside the agent loop (e.g. classification probes). Indexed
  // with tenantId+createdAt for daily per-agent cost rollups.
  agentTypeSlug: text('agent_type_slug'),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  /**
   * @deprecated Pre-split cache-read count. Kept read-only for legacy rows; new
   * code writes tokensCacheWrite/tokensCacheRead instead. Readers should use
   * COALESCE(tokens_cache_read, tokens_cached).
   */
  tokensCached: integer('tokens_cached'),
  tokensCacheWrite: integer('tokens_cache_write'),  // Anthropic cache_creation_input_tokens (5-min TTL writes, 1.25x)
  tokensCacheRead: integer('tokens_cache_read'),    // Anthropic cache_read_input_tokens (0.1x)
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  // Price version that produced costUsd; NULL = legacy row or unpriced (unknown model).
  pricingId: uuid('pricing_id').references(() => modelPricing.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_llm_usage_tenant').on(table.tenantId, table.createdAt),
  index('idx_llm_usage_tenant_agent_date').on(table.tenantId, table.agentTypeSlug, table.createdAt),
]);
