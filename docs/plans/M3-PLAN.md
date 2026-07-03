# M3 Plan — Billing (rollups, ledger, invoices, alerts)

**Status: DRAFT v2 — awaiting Pradeep's review. No implementation yet.**
*(v2: revised after adversarial review — 24 findings applied; the material ones are called out
inline as “⚠ review-fix”.)*

Scope source: Salvage Register v4.1 §6 — *"M3 (billing): reduce scope — capture exists; build
pricing join, rollups, ledger (adapted wallet), invoice PDF job, alerts"* — plus register §2.2
item 2 (billing_periods + invoices + line-item generation job, budget alert notifications,
per-conversation cost API) and REQUIREMENTS-V4 §3.6.

The **pricing join is already done** (M1): `llm_usage_logs` stores per-row `cost_usd` +
`pricing_id` at capture time. M3 is settlement on top: periodic rollups, a tenant ledger
adapted from the old Python wallet, invoice generation with PDF, and turning log-only budget
signals into real notifications.

---

## 1. Ground truth (verified against code, 2026-07-02)

### What exists (M3 builds on)
- **Cost capture**: `computeCostUsd()` (`src/orchestrator/pricing.ts`) at capture time; one
  `llm_usage_logs` row per LLM turn with split tokens, `costUsd` (decimal 10,6, Drizzle returns
  **strings**), `pricingId`. Two duplicate insert sites: `agent-loop.ts` and `agent-stream.ts`.
- **Versioned reference data pattern**: `model_pricing` (append-only, `effectiveFrom`/`effectiveTo`,
  unique `(provider, model, effective_from)`), seeded from `config/seeds/*.pricing.json` with
  `onConflictDoNothing`. Reuse this pattern for any billing rate data.
- **BullMQ**: everything in `src/shared/queue.ts` — Queues exported at top, Workers created in
  `startWorkers()` (in-process with Fastify, called in `src/server.ts` before `app.listen()`),
  cron via `Queue.upsertJobScheduler(id, { pattern }, jobTemplate)` in `setupRecurringJobs()`,
  job logic in separate modules loaded via dynamic `await import(...)`. Retry
  (`attempts: 3`, exponential backoff 60s) is a **per-add convention** (`scheduleConsolidation`),
  NOT a default — the existing scheduler templates carry no retry opts, so scheduler-spawned
  jobs get zero retries unless the jobTemplate sets them explicitly (WP3 does).
- **Outbound webhooks**: `fireWebhooks(tenantId, event, data)` in
  `src/gateway/outbound-webhooks.ts` — HMAC-SHA256 signing (`X-AgentForge-Signature`), envelope
  `{ event, tenantId, timestamp, data }`, exact-string event match against
  `webhook_configs.events text[]`. **Fire-and-forget, single 10s fetch, no retry, no delivery
  log.** The `WebhookEvent` union declares 8 events; only 3 have live producers
  (`conversation_started`, `handoff_triggered` in agent-loop; `agent_run.completed` in
  agent-stream, lms-insights only).
- **Admin conventions**: `src/admin/<feature>/routes.ts` plugin, `authMiddleware` preHandler +
  `requireRole('admin')` / `requireSuperAdmin()`; Zod via `schema.parse(request.body)` with the
  global error handler mapping ZodError→400. The **safe** tenant-resolution helper is
  `getActiveTenantId(request)` (only `corrections/routes.ts` uses it today).
- **Dashboard**: Next 16 App Router; server components fetch via `dashboard/lib/api.ts` (Bearer
  `af_token` cookie + `X-Active-Tenant-Id`); mutations via `'use server'` actions; nav in
  `dashboard/components/sidebar.tsx` (`superAdminOnly` flag); safe tenant helper
  `dashboard/lib/tenant.ts` (`getActiveTenantId()`/`isSuperAdmin()`).
- **Schema conventions**: `pgTable('snake_case', { camelKey: type('snake_col') }, (t) => [...])`
  array form; uuid PK `defaultRandom()`; `tenantId` FK second column, first in composite
  indexes; `timestamp(..., { withTimezone: true }).defaultNow()`; money as `decimal` with
  explicit precision; RLS via hand-written **idempotent** `drizzle/NNNN_*.sql`
  (DROP POLICY IF EXISTS → CREATE POLICY → ENABLE RLS; 0001 is the template).
  `scripts/setup-server.sh` applies `drizzle/*.sql` in sorted order **only on the single-server
  prod compose**; split-DB installs must run them manually on the DB host (the script prints
  the reminder).

### What does NOT exist (gaps M3 fills or must not trip on)
- **No** `billing_periods`, `invoices`, `ledger`, wallet, or notifications tables. No
  `src/admin/billing/` module, no dashboard billing page.
- **No PDF, email, or template-engine dependency** in either package.json. Email is fully absent
  → email delivery is OUT of M3 scope; alerts = durable webhooks + in-app notifications.
- **`webhookDeliveryQueue` is dead code**: declared/exported in `queue.ts:19`, no producer, no
  worker. The dispatcher bypasses BullMQ. M3 revives it for durable delivery.
- **Budget alerts are log-only** — and the 80%/100% logs fire only on the Redis cache-miss path
  (silent during each 300s cache window). No path reaches a human.
- **Budget enforcement is asymmetric**: tenant monthly TOKEN budget (`config.ai.monthlyTokenBudget`)
  gates only agent-loop (WhatsApp/web); per-agent daily USD cap (`agent_types.daily_spend_cap_usd`,
  uncached SUM per request) gates only agent-stream (SSE). No tenant-level USD budget exists —
  WP1 adds an **alert-only** `monthlyBudgetUsd`. Symmetrizing enforcement is an explicit
  non-goal (see §7) — it would change live LMS/SSE behavior and is Pradeep's call.
- **Period-boundary inconsistency**: `budget.ts` month start uses server-LOCAL time; the daily
  cap uses UTC. `billing_periods` will be strictly UTC — see WP5 fix.
- **NULL-cost rows** (unpriced models) are silently excluded from every `SUM(cost_usd)` — a
  billing rollup must **count** them (`unpricedRows`) and alert, or we silently under-bill.
- **Legacy rows**: cache reads must use `COALESCE(tokens_cache_read, tokens_cached)`;
  `pricingId`/`costUsd`/`agentTypeSlug` may be NULL on old rows.
- `llm_usage_logs.conversationId` has **no index** — the per-conversation cost API needs one.
  `llm_usage_logs` also has **no RLS policy** — 0003 adds it (it becomes the billing source of
  truth; policing derived tables but not the source would be inconsistent).
- **Cross-tenant scoping hole (security)**: analytics/tools/tickets/agents/webhooks routes trust
  URL `:tenantId` without checking it against the JWT — any authenticated user of any tenant can
  read another tenant's cost data via `/admin/analytics/<otherTenantId>/costs`. Also
  `GET /admin/analytics/system-overview` (platform-wide costs) has **no super-admin gate**.
  M3 fixes the cost surfaces it sits beside; the full retrofit is a flagged follow-up.
- `PUT /admin/webhooks/:tenantId/:id` applies a raw body with no Zod (rule violation) — in-scope
  fix since tenants subscribe to billing events through this surface.
- RLS note: the app connects as table owner, so RLS is defense-in-depth for non-owner roles
  only (no `FORCE ROW LEVEL SECURITY`); cross-tenant rollup jobs work exactly like the existing
  `sla-checker` precedent.
- **No route-level test harness exists** (zero `app.inject` uses in tests/; all suites are
  plain-function tests). WP8 builds one. `tests/helpers/mock-db.ts` has **no transaction
  support** and src/ has zero `db.transaction` call sites today — WP2 introduces the first;
  WP8 extends the mock.

### Old Python wallet — what to port vs. what to fix (verified read of `wallet_service.py`, `billing.py`, `costs.py`, `cost_tracker.py`)

**Port (the shape is right):**
- Append-only ledger with signed amounts + `balance_after` snapshot per row.
- Transaction taxonomy: `topup_razorpay, topup_manual, deduction_usage, deduction_manual, refund, credit_bonus`.
- Usage metadata denormalized on the ledger row (self-contained transaction list UI).
- Lifecycle state machine: low-balance threshold → notify → pause at ≤0 → auto-resume on credit.
- Allow-negative-then-pause debit policy (the coherent one of the two contradictory old paths).
- Endpoint response **shapes** for wallet/transactions/costs (JSON contracts only).

**Do NOT port (verified bugs):**
- No idempotency anywhere → replaying a top-up verification **double-credits**. v4: unique
  `(tenant_id, reference)` on ledger inserts.
- Read-modify-write balance with no locking → lost updates. v4: single-statement atomic
  `UPDATE ... SET balance = balance + $x ... RETURNING` inside a transaction with the ledger insert.
- Phantom `is_low_balance` attribute (not a real column — low-balance flagging never worked).
- Currency bug (all wallets debited at INR rates); FX was cosmetic. v4: **USD-only** in M3.
- Two disconnected hardcoded price systems → superseded by `model_pricing`; margin was implicit
  in inflated flat rates → v4 makes **margin an explicit column**, snapshotted per debit.
- Fail-open Razorpay webhook verification; `payment.captured` no-op ("paid but never credited").
  → Razorpay top-ups are **deferred entirely** (register: optional-only; internal tenants settle
  via invoice). Manual super-admin credits cover M3.

---

## 2. Design decisions

1. **Money**: `decimal(12,6)` USD everywhere in billing tables (matches `cost_usd`; Drizzle
   string convention; SQL-side SUMs, never float accumulation in JS). Rounding: half-up to 6dp
   at debit time; invoice totals to 2dp at generation.
2. **Debits are daily aggregates, not per-call**, and **self-healing** (⚠ review-fix): each
   rollup run debits every un-debited UTC day since period start — not just "yesterday" — by
   listing distinct usage days and subtracting days whose `usage:{tenantId}:{YYYY-MM-DD}`
   ledger reference already exists. A missed night, a multi-day outage, or a mid-month deploy
   all back-fill automatically on the next successful run; idempotency still guarantees no
   double-debit.
3. **The ledger is the invoice's source of truth** (⚠ review-fix): invoice subtotal = SUM of the
   period's `debit_usage` entries (reference prefix `usage:{tenant}:{YYYY-MM}-`), so ledger and
   invoice agree **by construction**. The re-aggregated rollup is a cross-check: divergence
   beyond $0.01 raises a `billing.drift` warning notification, never silently corrects.
   `marginPct` is snapshotted into each debit's `metadata` — a mid-month margin edit affects
   only subsequent days, and the invoice inherits exactly what was debited.
4. **Billing mode per tenant**: `postpaid` (default — internal tenants, never auto-paused,
   invoice settles) vs `prepaid` (auto-pause at balance ≤ 0, auto-resume on credit).
5. **Pause reasons** (⚠ review-fix): `pausedReason: 'auto_balance' | 'manual'`. Auto-resume
   applies **only** to `auto_balance`; a manual (super-admin) pause requires manual resume and
   is honored for postpaid tenants too.
6. **Margin explicit**: `margin_pct` on the wallet row (default 0). Invoice line items show
   cost, margin, and total separately.
7. **One live invoice per (tenant, period)** — **partial** unique index `WHERE status != 'void'`
   (⚠ review-fix: a voided invoice must not block a corrected one). Invoice number
   `AF-{YYYYMM}-{tenant-slug}` with `-r{n}` suffix on regeneration.
8. **Alerts = durable webhooks + in-app notifications.** Revive `webhookDeliveryQueue`:
   `fireWebhooks` becomes an enqueue of `{ webhookConfigId, envelope }` — **the worker fetches
   url/secret from `webhook_configs` at delivery time** (⚠ review-fix: no secrets in Redis job
   payloads; secret rotation picked up between retries). New events: `budget.threshold_reached`,
   `budget.exceeded`, `wallet.low_balance`, `wallet.paused`, `invoice.generated`. In-app:
   `notifications` table with `dedupe_key` (unique). Email: out of scope.
9. **Periods are strictly UTC months.** Rollup cron runs with `tz: 'UTC'`; "a usage day" is a
   UTC calendar day `[00:00, 24:00)`; all debit reference dates are UTC-formatted.
10. **Tenant-level USD budget = alert-only** (⚠ review-fix): nullable
    `monthlyBudgetUsd decimal(12,2)` on `tenant_wallets` (NULL = no USD alerting — correct
    default for internal tenants). This is the denominator for the nightly 80%/100% USD alerts.
    No hard-stop (consistent with "visibility + pause, not new caps").
11. **PDF**: `pdfkit` (battle-tested, pure JS, no browser dep — verify npm health at
    implementation time per research-first rule). Files under `INVOICE_PDF_DIR` (env, default
    `./data/invoices`, Docker volume on prod), served only through an authenticated admin route.
12. **All new billing routes resolve the tenant via `getActiveTenantId(request)`** — never a URL
    `:tenantId` — plus targeted fixes to the two worst existing cost holes (WP6).

---

## 3. Work packages (landing order)

### WP1 — Schema: billing tables + RLS + indexes

| File | Change |
|---|---|
| `src/shared/schema/billing.ts` | CREATE — 4 tables below |
| `src/shared/schema/notifications.ts` | CREATE — notifications table |
| `src/shared/schema/tracing.ts` | MODIFY — add `idx_llm_usage_tenant_conversation` on `(tenantId, conversationId)` |
| `src/shared/schema/index.ts` | MODIFY — export new files |
| `drizzle/0003_billing_rls.sql` | CREATE — idempotent RLS (0001 template) for the 5 new tables **+ `llm_usage_logs` + `conversation_traces`** (⚠ review-fix: the source of truth gets a policy too) |

Tables (house conventions: uuid PK, `tenantId` FK second, tz timestamps):

- **`billing_periods`** — `tenantId`, `periodStart`/`periodEnd` (timestamptz, UTC month bounds),
  `status` text: `open | closed | invoiced`, rollups: `totalCostUsd decimal(12,6)`,
  `totalTokensInput/Output/CacheWrite/CacheRead` (bigint), `llmCalls integer`,
  `unpricedRows integer` (NULL-cost tripwire), `byAgent jsonb`
  (`{ slug, calls, tokens, costUsd }[]`), `closedAt`, `createdAt`, `updatedAt`.
  Unique `uq_billing_periods_tenant_start (tenantId, periodStart)`.
- **`tenant_wallets`** — one row per tenant: `tenantId` (unique), `balanceUsd decimal(12,6)`
  default 0, `billingMode` text default `'postpaid'`, `marginPct decimal(5,2)` default 0,
  `monthlyBudgetUsd decimal(12,2)` (nullable — USD alert denominator),
  `lowBalanceThresholdUsd decimal(12,2)` default 10, `isPaused boolean` default false,
  `pausedReason` text (nullable: `auto_balance | manual`), `pausedAt`, `lowBalanceNotifiedAt`,
  `currency` text default `'USD'`, timestamps.
- **`ledger_entries`** — append-only: `tenantId`, `type` text
  (`debit_usage | debit_manual | credit_manual | credit_topup | refund | credit_bonus`),
  `amountUsd decimal(12,6)` (signed: debits negative), `balanceAfterUsd decimal(12,6)`,
  `reference` text NOT NULL (idempotency key), `description`, `metadata jsonb`
  (usage: `{ date, llmCalls, unpricedRows, marginPct, byAgent }`), `createdBy uuid` (manual
  ops), `createdAt`. Unique `uq_ledger_tenant_reference (tenantId, reference)`;
  index `(tenantId, createdAt)`.
- **`invoices`** — `tenantId`, `billingPeriodId` FK, `invoiceNumber` text unique,
  `periodStart`/`periodEnd`, `lineItems jsonb`, `subtotalUsd decimal(12,2)`,
  `marginPct decimal(5,2)` (informational — actual margin lives in the debits),
  `marginUsd decimal(12,2)`, `totalUsd decimal(12,2)`, `currency` default `'USD'`,
  `status` text: `draft | issued | paid | void`, `pdfPath` text, `generatedAt`, `issuedAt`,
  `paidAt`, `createdAt`. **Partial** unique `uq_invoices_tenant_period (tenantId,
  billingPeriodId) WHERE status != 'void'` (partial indexes go in `drizzle/0003`, Drizzle can't
  express them).
- **`notifications`** — `tenantId`, `type` text, `severity` text (`info | warning | critical`),
  `title`, `body`, `metadata jsonb`, `dedupeKey` text, `readAt`, `createdAt`.
  Unique `uq_notifications_dedupe (tenantId, dedupeKey)`; index `(tenantId, createdAt)`.

### WP2 — Ledger service (the adapted wallet, bugs fixed)

| File | Change |
|---|---|
| `src/billing/ledger.ts` | CREATE — core service |
| `src/billing/wallet-state.ts` | CREATE — pause/low-balance checks with Redis cache |

- `ensureWallet(tenantId)` — lazy create with defaults.
- `applyLedgerEntry({ tenantId, type, amountUsd, reference, description, metadata, createdBy })`
  — single `db.transaction` (the repo's first — WP8 extends the mock): atomic
  `UPDATE tenant_wallets SET balance_usd = balance_usd + $x RETURNING balance_usd` → insert
  ledger row with returned `balanceAfterUsd` → evaluate state machine:
  - prepaid + balance ≤ 0 + not already paused → `isPaused = true, pausedReason = 'auto_balance'`;
  - credit while `pausedReason = 'auto_balance'` and balance > 0 → auto-resume
    (**manual pauses never auto-resume**);
  - low-balance threshold **crossing** (was above, now below) → set `lowBalanceNotifiedAt`,
    return flag; a credit lifting balance above threshold **clears** `lowBalanceNotifiedAt`
    (this defines the alert "episode" — see WP5).
  - **On unique-violation of `(tenantId, reference)`: return the existing entry with
    `idempotentReplay: true`, never throw** (the fix for the old double-credit bug).
- `getBalance(tenantId)` / `verifyBalance(tenantId)` — derived `SUM(amount_usd)` cross-check
  against stored balance (reconciliation guard; structured warn on drift).
- `isTenantPaused(tenantId)` in `wallet-state.ts` — Redis-cached 60s; checked in **both**
  `agent-loop.ts` and `agent-stream.ts` gates; honors `manual` pauses regardless of
  `billingMode`. **Overshoot mitigation** (⚠ review-fix): for prepaid tenants below
  `lowBalanceThresholdUsd`, also compute effective balance = balance − (un-debited
  month-to-date cost × margin) via uncached SUM (same pattern as agent-stream's daily cap) and
  pause on effective ≤ 0. Only sub-threshold prepaid tenants pay the extra query; postpaid and
  healthy-balance tenants are untouched. Residual overshoot bound: ~60s cache lag (was ~26.5h
  unmitigated — see §6 Risk 2).

### WP3 — Rollup job (BullMQ, nightly, self-healing)

| File | Change |
|---|---|
| `src/billing/rollup.ts` | CREATE — job logic (dynamic-imported by worker) |
| `src/shared/queue.ts` | MODIFY — `billingQueue`, worker registration in `startWorkers()`, scheduler in `setupRecurringJobs()` |

- Scheduler: `billingQueue.upsertJobScheduler('daily-billing-rollup', { pattern: '30 2 * * *',
  tz: 'UTC' }, { name: 'daily-billing-rollup', data: {}, opts: { attempts: 3, backoff:
  { type: 'exponential', delay: 60000 } } })` — retry opts **must** be in the jobTemplate
  (⚠ review-fix: existing scheduler templates carry none; scheduler jobs otherwise get zero
  retries). Existing jobs don't set `tz`; billing must.
- Per active tenant (cross-tenant scan, sla-checker precedent). Steps, in order:
  1. **Month close first** (when a previous-month period exists and is `open`):
     **re-run the full aggregation over the previous month's UTC bounds and persist it**
     (⚠ review-fix — CRITICAL: without this, the last ~21.5h of the month never reach the
     invoice), then run step 2's debit back-fill so the final days are debited, then mark
     `closed`, generate the invoice (WP4), mark `invoiced`. No previous-month row (fresh
     deploy, tenant created this month) → structured log + skip, never throw.
  2. **Self-healing debits** (⚠ review-fix): `SELECT DISTINCT date_trunc('day', created_at AT
     TIME ZONE 'UTC')` days with usage since current period start (and previous month during
     close); subtract days that already have a `usage:{tenantId}:{YYYY-MM-DD}` ledger
     reference; for each missing day, `applyLedgerEntry({ type: 'debit_usage', amountUsd:
     -(dayCost × (1 + marginPct/100)) rounded half-up 6dp, reference: 'usage:{tenantId}:{date}',
     metadata: { date, llmCalls, unpricedRows, marginPct, byAgent } })`. Skip zero-cost days.
     Missed nights, outages, and mid-month deploys back-fill automatically.
  3. **Upsert current UTC month's `billing_periods` row** — full month-to-date re-aggregation
     (idempotent by construction; COALESCE convention;
     `unpricedRows = COUNT(*) FILTER (WHERE cost_usd IS NULL)`). Period rows are created for
     **all** active tenants, including zero-usage ones.
  4. **Alert evaluation** (via WP5): `unpricedRows > 0` → warning; low-balance / paused
     transitions from WP2 flags; USD budget 80%/100% against `tenant_wallets.monthlyBudgetUsd`
     when set (dedupe namespace `budget-usd:` — distinct from the token-budget's
     `budget-tokens:`, ⚠ review-fix: shared keys would suppress one another).
- **Cold-start policy** (⚠ review-fix, explicit): deploy-month periods deliberately cover the
  **full** UTC month including pre-deploy usage (internal tenants; the data exists and the
  self-healing debit back-fills it — ledger and invoice stay consistent). Months fully before
  deploy get no periods/invoices. Month close no-ops gracefully when no period row exists.
- Job concurrency 1. The rollup and consolidation jobs are unrelated; no ordering dependency.

### WP4 — Invoices + PDF job

| File | Change |
|---|---|
| `src/billing/invoice.ts` | CREATE — generation from a closed period |
| `src/billing/invoice-pdf.ts` | CREATE — pdfkit renderer (job handler) |
| `src/shared/queue.ts` | MODIFY — PDF jobs as named jobs on `billingQueue` (one queue) |
| `package.json` | MODIFY — add `pdfkit` + `@types/pdfkit` |

- `generateInvoice(billingPeriodId)` (⚠ review-fix — ledger is source of truth):
  - `subtotalUsd`/`marginUsd`/line items derive from the period's `debit_usage` **ledger
    entries** (reference prefix `usage:{tenant}:{YYYY-MM}-`; per-agent split from each entry's
    `metadata.byAgent`), rounded to 2dp at the end. Invoice total = ledger total **by
    construction**.
  - Cross-check against the re-aggregated period rollup; drift > $0.01 → `billing.drift`
    warning notification (never silent correction).
  - Skip generation entirely when the period total is 0 (no $0 invoices).
  - Insert with `onConflictDoNothing` on the partial unique index; **if the existing row has
    `pdfPath IS NULL`, re-enqueue the PDF job** (⚠ review-fix: PDF-job exhaustion no longer
    strands a draft forever). `invoiceNumber = 'AF-' + YYYYMM + '-' + tenantSlug`, `-r{n}`
    suffix when regenerating after a void.
- PDF: header (tenant name, period, invoice number), line-item table (per agent: calls, tokens,
  cost), subtotal / margin / total, footer noting `unpricedRows` if > 0 ("N calls unpriced —
  totals understate usage"). Write to `INVOICE_PDF_DIR`, store `pdfPath`, update status.
- No auto-issue: `draft → issued` is a manual admin action (WP6). Internal settlement, not
  customer-facing dunning.

### WP5 — Alerts: durable webhooks + notifications (+ boundary fix)

| File | Change |
|---|---|
| `src/gateway/outbound-webhooks.ts` | MODIFY — `fireWebhooks` matches configs then enqueues `{ webhookConfigId, envelope }` per match; extend `WebhookEvent` union (8 declared → 13) with the 5 billing events |
| `src/shared/queue.ts` | MODIFY — worker for `webhook-delivery` (attempts 5, exponential backoff); worker **re-fetches url/secret from `webhook_configs` at delivery time**, signs, posts (10s timeout) |
| `src/billing/alerts.ts` | CREATE — `raiseAlert({ tenantId, type, severity, title, body, dedupeKey, webhookEvent?, webhookData? })` → insert notification (`onConflictDoNothing` on dedupe) + fire webhook **only when the notification row was actually inserted** (dedupe gates both channels) |
| `src/orchestrator/budget.ts` | MODIFY — month start → UTC (`setUTCDate/setUTCHours`); `checkBudget` **returns threshold-crossing flags** (stays dependency-light — no static import of alerts/queue, ⚠ review-fix: keeps existing budget.test.ts isolation intact); `agent-loop.ts` invokes `raiseAlert` on the flags (dedupe `budget-tokens:{tenant}:{YYYY-MM}:{80\|100}` — once per month per tier, fixing the silent-cache-window problem at the alerting level) |
| `src/admin/webhooks/routes.ts` | MODIFY — Zod on the unvalidated PUT **and** `events: z.array(z.enum([...WebhookEvent]))` on BOTH create and update schemas (⚠ review-fix: a typo'd event subscription is a silent alerting outage) |
| `src/shared/validators/index.ts` | MODIFY — `createWebhookConfigSchema.events` → same enum |

- Dedupe keys: `budget-tokens:{t}:{YYYY-MM}:{tier}`, `budget-usd:{t}:{YYYY-MM}:{tier}`,
  `wallet:low:{t}:{crossing-date}` (**episode-scoped** — `lowBalanceNotifiedAt` cleared on
  recovery defines the episode; ⚠ review-fix: month-scoped dedupe would miss the
  top-up-then-drain-again tenant), `wallet:paused:{t}:{pausedAt-date}`,
  `unpriced:{t}:{YYYY-MM-DD}`, `invoice:{invoiceNumber}`, `billing.drift:{t}:{YYYY-MM}`.
- Behavior change to flag: all 3 live fireWebhooks call sites become queue-delivered with retry
  — strictly more reliable, envelope/signature unchanged, delivery no longer same-tick. The 5
  declared-but-never-fired events are unaffected.
- Alert payloads carry ids + numbers only — **no PII, no message text** (the existing
  `agent_run.completed` includes `finalText`; billing events must not copy that pattern).

### WP6 — Admin API + scoping fixes

| File | Change |
|---|---|
| `src/admin/billing/routes.ts` | CREATE — all routes below |
| `src/admin/analytics/routes.ts` | MODIFY — two targeted security fixes |
| `src/server.ts` | MODIFY — register `billingRoutes` |
| `src/shared/validators/index.ts` | MODIFY — Zod schemas for billing bodies |

Routes (all `authMiddleware`; tenant from `getActiveTenantId(request)` — no `:tenantId` params):
- `GET /admin/billing/summary` — wallet + current open period rollup (dashboard's single fetch).
- `GET /admin/billing/periods` (paginated) · `GET /admin/billing/periods/:id`
- `GET /admin/billing/ledger` (paginated; old transactions-list shape:
  `{ transactions, total, limit, offset }`)
- `GET /admin/billing/invoices` · `GET /admin/billing/invoices/:id` ·
  `GET /admin/billing/invoices/:id/pdf` (stream from `INVOICE_PDF_DIR`; **path from DB row
  only, never from user input**)
- `POST /admin/billing/invoices/:id/issue` — `requireRole('admin')`, `draft → issued`
- `POST /admin/billing/invoices/:id/regenerate-pdf` — `requireRole('admin')` (⚠ review-fix:
  manual recovery for exhausted PDF jobs)
- `POST /admin/billing/wallet/adjust` — `requireSuperAdmin()`; body
  `{ type: credit_manual | debit_manual | credit_bonus | refund, amountUsd > 0, reason,
  idempotencyKey }` (Zod); maps to `applyLedgerEntry` with `reference = 'manual:' +
  idempotencyKey`, `createdBy` from JWT; response includes `idempotentReplay: true` on replay
- `POST /admin/billing/wallet/pause` / `resume` — `requireSuperAdmin()`; pause sets
  `pausedReason = 'manual'`
- `POST /admin/billing/rollup/run` — `requireSuperAdmin()`; enqueue the rollup on demand
  (testing/backfill; also how the first-ever rollup is triggered on prod)
- `GET /admin/notifications` (paginated, unread filter) · `POST /admin/notifications/:id/read`
- `GET /admin/analytics/conversations/:conversationId/cost` — per-conversation cost API
  (register §2.2): SUM over `llm_usage_logs` by `(tenantId, conversationId)` using the new
  index; per-turn breakdown; `unpricedRows` in response.

Security fixes (targeted, cost surfaces only — full retrofit is a follow-up):
- `GET /admin/analytics/system-overview` → add `requireSuperAdmin()`.
- `GET /admin/analytics/:tenantId/costs` (and siblings in the same file) → assert
  `params.tenantId === getActiveTenantId(request)` (403 otherwise; super_admin passes via the
  switcher header as designed).

### WP7 — Dashboard billing page

| File | Change |
|---|---|
| `dashboard/app/(dashboard)/billing/page.tsx` | CREATE — server component |
| `dashboard/lib/billing-actions.ts` | CREATE — `'use server'` actions (issue invoice, adjust wallet, pause/resume — super-admin gated UI, backend enforces) |
| `dashboard/components/sidebar.tsx` | MODIFY — nav item `{ href: '/billing', label: 'Billing', icon: '💰' }` |

One page, four sections: wallet card (balance, mode, margin, paused state + reason),
current-period rollup (cost, tokens, per-agent table, unpriced warning), ledger table
(paginated), invoices list (status + PDF download). Uses `dashboard/lib/tenant.ts`
`getActiveTenantId()` (the switcher-aware helper — NOT the copy-pasted local `getTenantId()`
in older pages). Notifications: unread count + list section on this page; a global bell is
deferred. (Next 16 / React 19 / Tailwind 4 — check `dashboard/AGENTS.md` conventions.)

### WP8 — Tests (land with their WPs; listed together)

New harness pieces (⚠ review-fix — neither exists today):
| File | Change |
|---|---|
| `tests/helpers/build-app.ts` | CREATE — Fastify app-builder: registers `authMiddleware` + routes under test, `app.inject` with signed JWTs (admin / super_admin / wrong-tenant); first route-level harness in the repo |
| `tests/helpers/mock-db.ts` | MODIFY — add `transaction(cb)` passthrough replaying the fluent stub + recording tx boundaries (WP2's `db.transaction` is the repo's first) |
| `tests/orchestrator/budget.test.ts` | MODIFY — cover the new crossing-flags return shape (no new mocks needed since budget.ts stays dependency-light) |

| File | Covers |
|---|---|
| `tests/billing/ledger.test.ts` | atomic apply (update+insert same tx), idempotent replay returns existing entry + flag, signed amounts, balanceAfter correctness, prepaid pause at ≤0 sets `auto_balance`, resume on credit only for `auto_balance`, manual pause survives credits, postpaid never auto-pauses, low-balance episode set/clear, derived-balance reconciliation warn |
| `tests/billing/rollup.test.ts` | month-to-date upsert idempotency, COALESCE legacy tokens, `unpricedRows` counting, **self-healing: 3 missed days → 3 debits, each idempotent**, zero-cost day skipped, margin applied + snapshotted in metadata, **month-close re-aggregates the final day before invoicing**, close no-ops without a period row |
| `tests/billing/invoice.test.ts` | line items from ledger entries (not rollup), ledger-vs-rollup drift alert, margin/total math (2dp), deterministic number + `-r{n}` on regen, partial-unique void semantics, $0 period → no invoice, `pdfPath IS NULL` → PDF re-enqueued |
| `tests/billing/alerts.test.ts` | dedupe gates both notification and webhook, `budget-tokens` and `budget-usd` can both fire same month, episode-scoped low-balance re-fires after recovery, no PII in payloads |
| `tests/gateway/webhook-delivery.test.ts` | fireWebhooks enqueues `{webhookConfigId, envelope}` (no secret in payload), worker re-fetches config + signs + posts, retry on failure, event-match filtering unchanged, unknown event name → 400 on create/update |
| `tests/admin/billing-routes.test.ts` | via `build-app`: tenant B cannot read tenant A (403), super-admin gates on adjust/pause/rollup/regenerate, Zod rejection on adjust body, per-conversation cost aggregation, system-overview 403 for non-super-admin |

Mocking: existing `vi.hoisted` Proxy-to-holder pattern for `db`/`redis`; BullMQ Queue/Worker
mocked at the `shared/queue.js` module boundary; job logic tested as plain async functions.

---

## 4. Migration & deploy steps (in order)

```bash
# local
rm -rf dist                                    # drizzle-kit dist/ trap
npm run typecheck && npm test
npm run migrate                                # additive: 5 new tables + 1 index
psql "$DATABASE_URL" -f drizzle/0003_billing_rls.sql
npm run build
```

No backfill needed (all-new tables; the rollup's self-healing debit IS the usage backfill).
No seed changes (wallets lazy-create; defaults correct for internal tenants — set
`monthlyBudgetUsd`/`marginPct` per tenant via the adjust/settings routes when wanted).

Prod (same backup-first sequence as M1/M2):
1. `pg_dump` backup → `git pull` → build image.
2. `drizzle-kit push` (additive; verify table count 19 → 24).
3. `psql -f drizzle/0003_billing_rls.sql` (auto-applied by `scripts/setup-server.sh` only on
   single-server prod compose; split-DB installs run it manually on the DB host).
4. Recreate app. Add `INVOICE_PDF_DIR` env + Docker volume for `./data/invoices`.
5. Kick the first rollup: `POST /admin/billing/rollup/run` — verify `billing_periods` rows
   appear and one `debit_usage` entry exists **per usage day this month** per tenant with
   spend (self-healing back-fill covers the deploy month from the 1st).

**Deploy behavior notes:** webhooks become queued (no longer same-tick); `budget.ts` month
boundary shifts local→UTC (IST: 5.5h earlier, one-time, token-budget only); pause-check adds
one cached Redis read per message (plus an uncached SUM only for sub-threshold prepaid
tenants); deploy-month invoices deliberately include pre-deploy usage (full UTC month).

---

## 5. Verification

```bash
npm run typecheck
npm test
npm run migrate && psql "$DATABASE_URL" -f drizzle/0003_billing_rls.sql
npx tsx -e "import('./src/billing/rollup.js').then(m => m.runBillingRollup())"   # manual local run
```

SQL spot checks:
1. `SELECT tenant_id, period_start, total_cost_usd, unpriced_rows FROM billing_periods` — one
   open row per active tenant; totals match per-tenant
   `SELECT SUM(cost_usd) FROM llm_usage_logs WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')`.
2. Re-run rollup → `SELECT reference, COUNT(*) FROM ledger_entries GROUP BY reference
   HAVING COUNT(*) > 1` → **0 rows** (idempotency).
3. `SELECT balance_usd FROM tenant_wallets` vs `SELECT SUM(amount_usd) FROM ledger_entries
   GROUP BY tenant_id` — equal.
4. **Ledger↔invoice** (⚠ review-fix): for a closed period, invoice `subtotal_usd` ==
   `-SUM(amount_usd)` of its `debit_usage` entries (2dp) == period re-aggregation within $0.01.
5. **Every usage day has a debit**: `SELECT DISTINCT date_trunc('day', created_at AT TIME ZONE
   'UTC') FROM llm_usage_logs WHERE cost_usd > 0` minus
   `SELECT DISTINCT (metadata->>'date') FROM ledger_entries WHERE type = 'debit_usage'` →
   empty, per tenant.
6. As non-super-admin: `GET /admin/analytics/system-overview` → 403;
   `GET /admin/analytics/<other-tenant>/costs` → 403.
7. Notification dedupe: same threshold twice → 1 row; low-balance → top-up → drain →
   **2** rows (episode-scoped).

---

## 6. Risks

1. **NULL-cost rows** — `costUsd` is computed at capture, so seeding a missing `model_pricing`
   row fixes only **future** rows. Remediation runbook (⚠ review-fix): seed pricing → run a
   backfill script for historical NULL-cost rows (precedent:
   `scripts/backfill-cache-token-split.ts`) → the next rollup's re-aggregation picks up the
   corrected rollup, and a **delta ledger entry** `usage-adj:{tenant}:{YYYY-MM}:repriced-{date}`
   posts the difference (idempotent, auditable) — day-debit references being already-taken can
   never absorb the correction. Until then: `unpricedRows` alert + invoice footer disclosure.
2. **Prepaid overshoot (accepted, bounded)** (⚠ review-fix): balance moves only on ledger
   events. Unmitigated exposure was ~26.5h (usage at 00:00 UTC, debited 02:30 next day); with
   WP2's effective-balance check for sub-threshold prepaid tenants the residual bound is ~60s
   (Redis cache TTL) plus intra-message spend. Accepted for M3 (internal tenants are postpaid).
3. **Webhook delivery semantics change** for the 3 live events (queued + retried vs
   fire-and-forget). Payloads unchanged; consumers may first see delayed/retried deliveries.
4. **UTC boundary shift** in `budget.ts` (IST −5.5h, one-time, token budget only). Release note.
5. Rollup is month-to-date **re-aggregation** — O(month of usage rows) per tenant per night;
   fine at current volume ((tenantId, createdAt) index exists). Revisit incremental rollup only
   if nightly runtime grows.
6. `pdfkit` is a new dependency — verify maintenance at implementation; renderer isolated in
   one file if it must be swapped.
7. Ledger `reference` uniqueness is per-tenant — a reused manual `idempotencyKey` returns the
   prior entry silently (by design); responses carry `idempotentReplay: true` for the UI.
8. In-process workers die with the app (no separate worker process) — a deploy at 02:30 UTC
   kills that night's run; the self-healing debit makes the next run repair it, and month-close
   re-aggregation is stateless. This is why nothing in the design depends on "the job ran last
   night".

## 7. Non-goals (explicit)

- **Razorpay top-ups / payment gateway** — deferred (register: optional-only). Manual
  super-admin credits are the M3 top-up path. The old `PaymentTransaction` two-table split is
  the design to follow when it lands.
- **Email delivery** — no infra exists; alerts are webhooks + in-app only.
- **Multi-currency / FX** — USD only; `currency` columns exist for future.
- **Subscriptions, coupons, plans** — the old coupon logic was decorative; not ported.
- **Budget-enforcement symmetry** (⚠ review-fix — explicit decision, not an accident): the
  tenant token budget still gates only agent-loop and the per-agent daily cap only
  agent-stream. Symmetrizing would change live LMS/SSE behavior; M3 adds only `isTenantPaused`
  to both paths. Flagged follow-up for Pradeep's call.
- **BYO LLM keys** (⚠ review-fix): all tenants ride platform keys today, so debiting everyone
  is correct. The old `is_using_shared_key` gate becomes relevant the moment per-tenant
  provider keys land — the gate would slot into the single debit call in `rollup.ts` step 2.
  Deferred until such keys exist.
- **Full admin-route tenant-scoping retrofit** — M3 fixes the two cost surfaces; the rest
  (tools/tickets/agents/webhooks URL-tenant trust) is a flagged follow-up.
- **Incremental/streaming rollups, materialized views** — nightly re-aggregation is enough.
- **Per-agent monthly caps / new enforcement knobs** — M3 adds visibility + pause, not new caps.
- **Global dashboard notification bell / realtime pushes** — list on the billing page only.
