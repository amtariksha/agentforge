import { pgTable, uuid, text, jsonb, integer, timestamp, unique } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { tenants } from './tenants.js';

export const memoryTopics = pgTable('memory_topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  topicKey: text('topic_key').notNull(),
  content: jsonb('content').notNull(),
  tokenCount: integer('token_count'),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  lastConsolidatedAt: timestamp('last_consolidated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('uq_memory_topics_user_tenant_topic').on(table.userId, table.tenantId, table.topicKey),
]);
