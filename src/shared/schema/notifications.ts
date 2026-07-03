import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * In-app notifications (budget/wallet/billing alerts surfaced to tenant admins).
 * `dedupeKey` is the once-per-episode guard: an insert with `onConflictDoNothing`
 * on (tenant_id, dedupe_key) means the same threshold fires exactly once, and
 * gates the paired outbound webhook too (raiseAlert fires the webhook only when
 * the notification row was actually inserted). NULL dedupeKey → never deduped
 * (Postgres treats NULLs as distinct in a unique index).
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  type: text('type').notNull(),
  severity: text('severity').notNull().default('info'),   // info | warning | critical
  title: text('title').notNull(),
  body: text('body'),
  metadata: jsonb('metadata'),
  dedupeKey: text('dedupe_key'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('uq_notifications_dedupe').on(table.tenantId, table.dedupeKey),
  index('idx_notifications_tenant_created').on(table.tenantId, table.createdAt),
]);
