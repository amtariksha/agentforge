import { pgTable, uuid, text, jsonb, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const correctionRules = pgTable('correction_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  pattern: text('pattern').notNull(),
  instruction: text('instruction').notNull(),
  examples: jsonb('examples'),
  appliesToAgents: text('applies_to_agents').array(),
  isActive: boolean('is_active').default(true),
  usageCount: integer('usage_count').default(0),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_corrections_tenant').on(table.tenantId, table.isActive),
]);

/**
 * Per-message operator corrections, embedded for similarity retrieval into the
 * dynamic prompt block ("Learned Corrections"). Kept OFF the hot `messages`
 * table so the vector column doesn't bloat message reads. The `embedding
 * vector(1536)` column + ivfflat cosine index + RLS policy are added by
 * drizzle/0001_message_corrections.sql (Drizzle has no native vector type;
 * same pattern as knowledge_chunks in 0000_init.sql).
 */
export const messageCorrections = pgTable('message_corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  agentTypeSlug: text('agent_type_slug'),          // conversations.currentAgentType at capture
  sourceMessageId: uuid('source_message_id'),
  userText: text('user_text'),                     // preceding user message — the retrieval context
  originalText: text('original_text'),
  correctedText: text('corrected_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_msg_corrections_tenant_agent').on(table.tenantId, table.agentTypeSlug),
]);
