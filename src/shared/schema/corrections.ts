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
