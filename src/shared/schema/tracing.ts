import { pgTable, uuid, text, jsonb, integer, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';
import { tenants } from './tenants.js';

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
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  tokensCached: integer('tokens_cached'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_llm_usage_tenant').on(table.tenantId, table.createdAt),
]);
