import { pgTable, uuid, text, jsonb, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { conversations } from './conversations.js';
import { users } from './users.js';
import { humanAgents } from './human-agents.js';

export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  userId: uuid('user_id').references(() => users.id),
  source: text('source').notNull(),
  type: text('type').notNull(),
  priority: text('priority').default('medium').notNull(),
  status: text('status').default('open').notNull(),
  subject: text('subject').notNull(),
  description: text('description'),
  assignedTo: uuid('assigned_to').references(() => humanAgents.id),
  resolution: jsonb('resolution'),
  correction: jsonb('correction'),
  slaDeadline: timestamp('sla_deadline', { withTimezone: true }),
  slaBreached: boolean('sla_breached').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (table) => [
  index('idx_tickets_tenant').on(table.tenantId, table.status, table.priority),
]);
