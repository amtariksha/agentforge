import { pgTable, uuid, text, jsonb, real, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';
import { tenants } from './tenants.js';

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id).notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  senderType: text('sender_type').notNull(), // 'user' | 'agent' | 'operator' | 'system'
  content: jsonb('content').notNull(),
  metadata: jsonb('metadata'),
  confidenceScore: real('confidence_score'),
  wasCorrected: boolean('was_corrected').default(false),
  correction: jsonb('correction'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_messages_conversation').on(table.conversationId, table.createdAt),
]);
