-- Applied AFTER `drizzle-kit push` creates the billing tables from the Drizzle
-- schema. Adds the RLS policies Drizzle can't express, plus the partial unique
-- index for invoices (one live invoice per period, but voided invoices don't
-- block a corrected one). Same idempotent pattern as 0001 — safe to re-apply on
-- every deploy. Apply with:  psql "$DATABASE_URL" -f drizzle/0003_billing_rls.sql
--
-- RLS here is defense-in-depth: the app connects as the table owner (no FORCE
-- ROW LEVEL SECURITY), so cross-tenant rollup jobs are unaffected; a non-owner
-- role that forgot a WHERE tenant_id would still be contained.

-- === Tenant isolation for the new billing tables ===

DROP POLICY IF EXISTS tenant_isolation_billing_periods ON billing_periods;
CREATE POLICY tenant_isolation_billing_periods ON billing_periods
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE billing_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_tenant_wallets ON tenant_wallets;
CREATE POLICY tenant_isolation_tenant_wallets ON tenant_wallets
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE tenant_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_ledger_entries ON ledger_entries;
CREATE POLICY tenant_isolation_ledger_entries ON ledger_entries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_invoices ON invoices;
CREATE POLICY tenant_isolation_invoices ON invoices
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_notifications ON notifications;
CREATE POLICY tenant_isolation_notifications ON notifications
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- === Backfill RLS on the billing source of truth (previously unprotected) ===

DROP POLICY IF EXISTS tenant_isolation_llm_usage_logs ON llm_usage_logs;
CREATE POLICY tenant_isolation_llm_usage_logs ON llm_usage_logs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE llm_usage_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_conversation_traces ON conversation_traces;
CREATE POLICY tenant_isolation_conversation_traces ON conversation_traces
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE conversation_traces ENABLE ROW LEVEL SECURITY;

-- === One live invoice per (tenant, period); voided invoices excluded ===
-- Partial unique index — Drizzle has no native partial-index expression.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_tenant_period_live
  ON invoices (tenant_id, billing_period_id) WHERE status != 'void';
