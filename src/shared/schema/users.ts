import { pgTable, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  platformUserId: text('platform_user_id').notNull(),
  platform: text('platform').notNull(),
  backendUserId: text('backend_user_id'),
  displayName: text('display_name'),
  profileData: jsonb('profile_data'),
  memoryIndex: jsonb('memory_index'),
  languagePreferred: text('language_preferred'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('uq_users_tenant_platform').on(table.tenantId, table.platformUserId, table.platform),
]);
