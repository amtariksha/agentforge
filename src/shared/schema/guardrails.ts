import { pgTable, uuid, text, jsonb, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';

export const guardrails = pgTable('guardrails', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'), // null = global guardrail
  name: text('name').notNull(),
  ruleType: text('rule_type').notNull(),
  config: jsonb('config').notNull(),
  action: text('action').default('block').notNull(),
  triggerResponse: text('trigger_response'),
  appliesTo: text('applies_to').default('input').notNull(), // 'input' | 'output' | 'both'
  priority: integer('priority').default(0),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_guardrails_tenant').on(table.tenantId, table.isActive, table.priority),
]);
