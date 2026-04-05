import { pgTable, uuid, text, jsonb, integer, real, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  channel: text('channel').notNull(),
  status: text('status').default('active').notNull(),
  currentAgentType: text('current_agent_type'),
  currentOperatorId: uuid('current_operator_id'),
  sessionState: jsonb('session_state'),
  summary: text('summary'),
  messageCount: integer('message_count').default(0),
  confidenceAvg: real('confidence_avg'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (table) => [
  index('idx_conversations_tenant').on(table.tenantId, table.status),
]);
