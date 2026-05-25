import { pgTable, uuid, text, jsonb, integer, real, boolean, timestamp, numeric, unique, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const agentTypes = pgTable('agent_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  avatarEmoji: text('avatar_emoji'),
  description: text('description'),
  systemPrompt: text('system_prompt').notNull(),
  intentKeywords: text('intent_keywords').array(),
  intentExamples: text('intent_examples').array(),
  priority: integer('priority').default(0),
  confidenceThreshold: real('confidence_threshold').default(0.7),
  isDefault: boolean('is_default').default(false),
  modelOverride: text('model_override'),
  isActive: boolean('is_active').default(true),
  // Shadow mode — when true, write-category tools return { success: true, dryRun: true }
  // without side effects. Read tools still execute. Used for 14-day eval window per
  // integration plan §3 before promoting an agent to live.
  shadowMode: boolean('shadow_mode').default(false).notNull(),
  // Per-agent daily USD spend cap. NULL = unlimited. Enforced in agent loop;
  // hits 429 agent_disabled_budget when day's llmUsageLogs sum >= cap.
  dailySpendCapUsd: numeric('daily_spend_cap_usd', { precision: 10, scale: 2 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('uq_agent_types_tenant_slug').on(table.tenantId, table.slug),
]);

export const tools = pgTable('tools', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').default('read').notNull(),
  requiresHitl: boolean('requires_hitl').default(false),
  requiresUserConfirm: boolean('requires_user_confirm').default(false),
  parameters: jsonb('parameters').notNull(),
  backendMapping: jsonb('backend_mapping').notNull(),
  executionConfig: jsonb('execution_config'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const agentTools = pgTable('agent_tools', {
  agentTypeId: uuid('agent_type_id').references(() => agentTypes.id, { onDelete: 'cascade' }).notNull(),
  toolId: uuid('tool_id').references(() => tools.id, { onDelete: 'cascade' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentTypeId, table.toolId] }),
]);
