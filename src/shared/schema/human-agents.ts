import { pgTable, uuid, text, boolean, integer, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const humanAgents = pgTable('human_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  phone: text('phone'),
  role: text('role').default('operator').notNull(),
  status: text('status').default('offline').notNull(),
  maxConcurrentChats: integer('max_concurrent_chats').default(5),
  skills: text('skills').array(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('uq_human_agents_tenant_email').on(table.tenantId, table.email),
]);
