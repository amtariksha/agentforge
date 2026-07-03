import {
  pgTable, uuid, text, decimal, integer, bigint, boolean, jsonb, timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Per-agent usage rollup, denormalized onto billing_periods.byAgent and onto
 * each debit_usage ledger entry's metadata. `costUsd` is the RAW provider cost
 * (decimal serialized as string); margin is applied at debit/invoice time, not
 * stored here.
 */
export interface AgentUsageRollup {
  slug: string | null;
  calls: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheWrite: number;
  tokensCacheRead: number;
  costUsd: string;
}

/**
 * Monthly usage rollup per tenant (UTC month bounds). Re-aggregated from
 * llm_usage_logs on every nightly run (idempotent by construction), and once
 * more at month close before the invoice is cut. `unpricedRows` counts
 * NULL-cost rows (unknown-model usage) — the under-billing tripwire, since
 * SUM(cost_usd) silently skips them.
 */
export const billingPeriods = pgTable('billing_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('open'),   // open | closed | invoiced
  totalCostUsd: decimal('total_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  totalTokensInput: bigint('total_tokens_input', { mode: 'number' }).notNull().default(0),
  totalTokensOutput: bigint('total_tokens_output', { mode: 'number' }).notNull().default(0),
  totalTokensCacheWrite: bigint('total_tokens_cache_write', { mode: 'number' }).notNull().default(0),
  totalTokensCacheRead: bigint('total_tokens_cache_read', { mode: 'number' }).notNull().default(0),
  llmCalls: integer('llm_calls').notNull().default(0),
  unpricedRows: integer('unpriced_rows').notNull().default(0),
  byAgent: jsonb('by_agent').$type<AgentUsageRollup[]>(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('uq_billing_periods_tenant_start').on(table.tenantId, table.periodStart),
]);

/**
 * One prepaid/postpaid ledger balance per tenant. `postpaid` (default, internal
 * tenants) is never auto-paused; `prepaid` auto-pauses at balance <= 0.
 * `pausedReason` distinguishes an automatic balance pause (auto-resumes on
 * credit) from a deliberate super-admin `manual` pause (requires manual resume,
 * honored for postpaid too). `monthlyBudgetUsd` is ALERT-ONLY (NULL = no USD
 * alerting) — there is no hard USD stop. `marginPct` is the platform spread over
 * raw LLM cost, snapshotted into each debit at debit time.
 */
export const tenantWallets = pgTable('tenant_wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull().unique(),
  balanceUsd: decimal('balance_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  billingMode: text('billing_mode').notNull().default('postpaid'),   // postpaid | prepaid
  marginPct: decimal('margin_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  monthlyBudgetUsd: decimal('monthly_budget_usd', { precision: 12, scale: 2 }),   // nullable = no USD alerting
  lowBalanceThresholdUsd: decimal('low_balance_threshold_usd', { precision: 12, scale: 2 }).notNull().default('10'),
  isPaused: boolean('is_paused').notNull().default(false),
  pausedReason: text('paused_reason'),   // auto_balance | manual
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  lowBalanceNotifiedAt: timestamp('low_balance_notified_at', { withTimezone: true }),
  currency: text('currency').notNull().default('USD'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Metadata carried on a debit_usage ledger entry: the UTC day it charges, the
 * margin snapshot, and the raw per-agent breakdown so an invoice can be built
 * from ledger truth without re-reading llm_usage_logs.
 */
export interface LedgerUsageMeta {
  date?: string;               // 'YYYY-MM-DD' UTC day (debit_usage only)
  llmCalls?: number;
  unpricedRows?: number;
  marginPct?: string;          // snapshot at debit time
  rawCostUsd?: string;         // pre-margin cost for the day
  byAgent?: AgentUsageRollup[];
}

/**
 * Append-only money ledger. `amountUsd` is signed (debits negative, credits
 * positive); `balanceAfterUsd` snapshots the wallet balance after the entry.
 * `reference` is the idempotency key, unique per tenant — a replayed reference
 * (missed-run back-fill, top-up retry, manual key reuse) is a no-op that returns
 * the existing row. Usage debits use `usage:{tenantId}:{YYYY-MM-DD}`.
 */
export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  // debit_usage | debit_manual | credit_manual | credit_topup | refund | credit_bonus
  type: text('type').notNull(),
  amountUsd: decimal('amount_usd', { precision: 12, scale: 6 }).notNull(),
  balanceAfterUsd: decimal('balance_after_usd', { precision: 12, scale: 6 }).notNull(),
  reference: text('reference').notNull(),
  description: text('description'),
  metadata: jsonb('metadata').$type<LedgerUsageMeta>(),
  createdBy: uuid('created_by'),   // human agent id for manual ops; null for system debits
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('uq_ledger_tenant_reference').on(table.tenantId, table.reference),
  index('idx_ledger_tenant_created').on(table.tenantId, table.createdAt),
]);

export interface InvoiceLineItem {
  agentSlug: string | null;
  calls: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: string;   // raw cost for this agent over the period
}

/**
 * One invoice per closed billing period. `totalUsd` equals the sum of the
 * period's debit_usage ledger entries by construction (ledger is the source of
 * truth), so it always reconciles with the ledger; `subtotalUsd` is the raw
 * cost and `marginUsd` the spread. A voided invoice does not block a corrected
 * one — the (tenant, period) uniqueness is a partial index `WHERE status !=
 * 'void'` in drizzle/0003; regenerated invoices get an `-r{n}` number suffix.
 */
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  billingPeriodId: uuid('billing_period_id').references(() => billingPeriods.id).notNull(),
  invoiceNumber: text('invoice_number').notNull().unique(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  lineItems: jsonb('line_items').$type<InvoiceLineItem[]>().notNull(),
  subtotalUsd: decimal('subtotal_usd', { precision: 12, scale: 2 }).notNull(),
  marginPct: decimal('margin_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  marginUsd: decimal('margin_usd', { precision: 12, scale: 2 }).notNull().default('0'),
  totalUsd: decimal('total_usd', { precision: 12, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull().default('draft'),   // draft | issued | paid | void
  pdfPath: text('pdf_path'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow(),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_invoices_tenant').on(table.tenantId, table.createdAt),
]);
