# Milestone 1 Plan — Verify + Harden (per Salvage Register v4.1 §6)

**Status:** PLAN — awaiting review. No implementation yet. Do not start M2.
**Scope (register §6 recast):** (a) verify llm-provider fallback chain end to end · (b) complete the corrections retrieval loop · (c) split `tokensCached` → `tokensCacheWrite`/`tokensCacheRead` + versioned `model_pricing` table + `costUsd` computed from it · (d) first test suite: agent-loop, tools/executor, budget.
**Constraints (CLAUDE.md):** Drizzle ORM, no raw SQL except migrations · Zod on all external inputs · TS strict, no `any` · every DB query includes tenant_id · structured JSON logs, never log PII · minimal diffs — verify + harden, not rewrite.
**Decisions confirmed by Pradeep:** corrections = full loop with embeddings (new `message_corrections` table + pgvector retrieval) · executor = harden + test (HITL gate, retry, fallbackMessage implemented so tests can assert them).

---

## 0. Verified ground truth (code-level; corrects register/v4 assumptions)

These findings were verified directly against the code and change the shape of each work item:

1. **Fallback chain does NOT exist** (register §2.1 said "verify"). `src/orchestrator/llm-provider.ts:23-33` selects the provider once via `LLM_PROVIDER` env at module load; Anthropic/Gemini clients are module-scope singletons; no 429/5xx/timeout handling anywhere. Item (a) is a **build**, not a verify.
2. **`agent-loop.ts:420` hardcodes `provider: 'anthropic'`** in usage rows; `classifier.ts` and `compaction.ts` call the Anthropic SDK directly, bypassing the provider module entirely.
3. **Cache-write tokens are dropped entirely.** Both capture sites (`llm-provider.ts:90-97`, `agent-loop.ts:266-269`) read only `cache_read_input_tokens`; `cache_creation_input_tokens` never lands anywhere. Item (c) is not a rename — it recovers billing data currently lost every day.
4. **`estimateCost` (agent-loop.ts:517-533) has three defects:** stale hardcoded prices (`claude-opus-4-6` $15/$75; `claude-haiku-4-5` $0.8/$4 vs current $1/$5); unknown models silently priced as Sonnet; and a **double-subtraction bug** — `input_tokens - cachedTokens`, but Anthropic's `usage.input_tokens` already *excludes* both cache tiers (total billed input = input + cache_write + cache_read), so costs are under-counted whenever caching is active.
5. **Gemini path:** `streamGemini` hardcodes `cached_tokens: 0`, estimates tokens by `text.length / 4` when the OpenAI-compat stream omits usage, and `agent-stream.ts:230-232` knowingly bills Gemini turns at the Anthropic nominal model.
6. **Corrections loop is half-built.** `loadActiveCorrections()` → `buildPrompt` "## Active Corrections" injection EXISTS (`agent-loop.ts:181` → `:233`; `prompt-builder.ts:109-115`), but: the `appliesToAgents` filter is a no-op stub (column not even selected — `routes.ts:152-158`); `usageCount` is never incremented; immediate message corrections (`messages.wasCorrected`/`correction`) are captured but **never retrieved**; the immediate-correction UPDATE has **no tenant_id predicate** (`routes.ts:27-38` — an admin JWT from tenant A can overwrite tenant B's messages); `originalText` is a `null` TODO. `agent-stream.ts` bypasses `buildPrompt` entirely (raw `agent.systemPrompt` string at line 154) — no corrections, no cache split on the SSE/LMS path.
7. **Executor safety config is dead.** `requiresHitl`/`requiresUserConfirm` are loaded (`executor.ts:48-49`) but `executeTool` never checks them — destructive tools execute ungated (violates CLAUDE.md "Destructive tools need HITL approval"). `executionConfig.retryCount`/`fallbackMessage` are parsed (`executor.ts:105`) but unused. `executeWithTimeout` (executor.ts:228-233) leaks timers.
8. **No test infrastructure exists.** No framework in devDependencies, zero test files. `"type": "module"`, tsx, TypeScript 5.7 strict.
9. **Migration workflow:** `npm run migrate` = `drizzle-kit push`; `drizzle/0000_init.sql` is the hand-written raw-SQL precedent (pgvector columns + ivfflat indexes + RLS policies). `drizzle.config.ts` prefers `./dist/.../schema/index.js` when present (stale-dist trap).
10. **`TenantConfig.ai.fallbackProvider` exists in types (`tenant-config.ts:73`) but is referenced nowhere** — it is the intended per-tenant fallback seam; M1 uses env defaults and documents this field as the future override.
11. **No circuit breaker / read-concurrent scheduling exists** despite CLAUDE.md describing them: tools execute strictly serially in a `for` loop (agent-loop.ts:290-316, agent-stream.ts:183-210). M1 maps "max 3 retries" to the Anthropic SDK's built-in retry (`maxRetries: 2` ⇒ 3 attempts) + exactly one fallback hop; serial ordering is tested as the current contract; a Redis circuit breaker is explicitly out of M1 scope.

---

## 1. Work packages and landing order

```
WP0 test scaffolding  →  WP1 (c) token split + pricing  →  WP2 (a) fallback  →  WP3 (b) corrections  →  WP4 (d) remaining suites
```

Rationale: WP0 is pure additive and everything after lands with tests. WP1 lands before WP2 because both rewrite the same two usage-insert sites and the `StreamResult.usage` shape — and every day logged pre-split loses cache-tier fidelity permanently (register §6: "do early"). WP3 is independent of WP2 and shares WP1's migration window (one migration ceremony). WP4's executor/budget suites have no dependency on WP1–WP3 and can be written any time after WP0; the fallback and corrections test cases land with WP2/WP3 respectively.

---

## 2. WP0 — Test scaffolding

**Framework: Vitest** — the only mainstream runner handling ESM + TS strict + path aliases without a transpile step; `vi.mock`/`vi.resetModules` are the practical answer to this codebase's module-scope singletons (`db`, `redis`, `new Anthropic(...)` at import time). No DI refactor (rejected as non-minimal).

| Action | File | Content |
|---|---|---|
| MODIFY | `package.json` | devDeps: `vitest`, `vite-tsconfig-paths`, `ioredis-mock`; scripts `"test": "vitest run"`, `"test:watch": "vitest"`; `"build": "tsc -p tsconfig.build.json"` |
| CREATE | `vitest.config.ts` | node env, `include: ['tests/**/*.test.ts']`, `setupFiles: ['tests/setup.ts']`, `restoreMocks: true`, `vite-tsconfig-paths` plugin |
| CREATE | `tests/setup.ts` | Sets `ANTHROPIC_API_KEY`, `LLM_PROVIDER=anthropic`, `LLM_FALLBACK_PROVIDER=anthropic`, `LLM_FALLBACK_MODEL=claude-haiku-4-5`, dummy `DATABASE_URL`/`REDIS_URL` — setupFiles run before test-file imports, so import-time env reads see them |
| CREATE | `tests/helpers/mock-db.ts` | Fluent Drizzle stub: `select().from(T).where()...` chains resolve queued per-table results; `insert().values()` / `update().set().where()` record calls for assertion; `.returning()` resolves queued rows. Used via `vi.mock('src/shared/db.js')` |
| CREATE | `tests/helpers/anthropic-fake.ts` | Builders: `textResponse()`, `toolUseResponse()`, `apiError(status, type)` constructing real `Anthropic.APIError` subclasses (so `instanceof` classification is exercised); fake stream exposing `.on('text', cb)` + `.finalMessage()` |
| CREATE | `tsconfig.build.json` | `extends ./tsconfig.json`, `include: ["src/**/*.ts", "scripts/**/*.ts"]` — tests never land in `dist/` |
| MODIFY | `tsconfig.json` | `include` += `tests/**/*.ts` so `npm run typecheck` covers tests (strict applies; no `any` in tests) |

Mocking strategy used by all suites: `vi.mock` for db/redis singletons and SDK constructors; `vi.resetModules()` + set env + dynamic `await import(...)` for the module-load-time `PROVIDER`/client constants; `ioredis-mock` implements the `get/setex/exists/incrby` surface budget.ts uses.

---

## 3. WP1 — (c) Token split + `model_pricing` + `costUsd` from the table

### 3.1 Schema changes

| Action | File | Change |
|---|---|---|
| CREATE | `src/shared/schema/pricing.ts` | `model_pricing`: `id uuid PK`, `provider text NOT NULL`, `model text NOT NULL` (exact string logged in usage rows), `inputPerMtok` / `outputPerMtok` / `cacheWritePerMtok` / `cacheReadPerMtok` `decimal(12,6) NOT NULL`, `effectiveFrom timestamptz NOT NULL`, `effectiveTo timestamptz` (NULL = active), `createdAt`. Unique index `(provider, model, effectiveFrom)` — doubles as the lookup index. **No tenantId, no RLS** (platform reference data; RLS in this repo is per-table opt-in). Rows are append-only: close a version by setting `effectiveTo`, insert a new row — never UPDATE prices retroactively |
| MODIFY | `src/shared/schema/tracing.ts` | `llmUsageLogs` gains nullable `tokensCacheWrite`, `tokensCacheRead`, `pricingId uuid` (FK → model_pricing; audit of exactly which price row produced `costUsd`; NULL = legacy or unpriced). **Keep `tokensCached`** as a deprecated legacy column: dropping under `drizzle-kit push` is destructive and it is the only cache signal on old rows. New code stops writing it; readers use `COALESCE(tokens_cache_read, tokens_cached)` |
| MODIFY | `src/shared/schema/index.ts` | `export { modelPricing } from './pricing.js';` |
| MODIFY | `src/shared/types/index.ts` | `ConversationTrace.ai` gains `tokensCacheWrite`/`tokensCacheRead` (traceData is jsonb — old traces still parse) |

### 3.2 Migration steps (push-only workflow), in order

1. `npm run typecheck`
2. `npm run migrate` — expect **additive only**: `CREATE TABLE model_pricing` + 3 `ADD COLUMN` on `llm_usage_logs`, no destructive prompts. **Trap:** `drizzle.config.ts` prefers `./dist/src/shared/schema/index.js` if present — run `npm run build` first or delete stale `dist/` so push sees the new columns.
3. **Backfill** — CREATE `scripts/backfill-cache-token-split.ts` (run with `npx tsx`; Drizzle-only, same pattern as `scripts/seed.ts`): set `tokensCacheRead = tokensCached` where `tokensCached IS NOT NULL AND tokensCacheRead IS NULL`; **leave `tokensCacheWrite` NULL on legacy rows** — the write-tier count is genuinely unknown (old code never captured it); never fabricate a `0` that looks measured. Idempotent via the IS NULL guard. Tradeoff: aggregations must `COALESCE(tokens_cache_write, 0)`, but no fake data. **Do NOT recompute legacy `costUsd`** — those numbers came from the buggy formula and lack write-tier data; `pricing_id IS NULL` marks them.
4. `npm run seed` (loads pricing rows, §3.3), then deploy code. **Order matters: migrate → backfill → seed → deploy.** Code-before-seed ⇒ every capture logs `model_pricing_missing` and stores NULL cost until the seed runs.

### 3.3 Pricing seed

| Action | File | Change |
|---|---|---|
| CREATE | `config/seeds/model-pricing.pricing.json` | Distinct `.pricing.json` extension (existing `*.seed.json` files are `TenantSeed`-shaped). Rows (per MTok; cache write = 1.25× input, read = 0.1× input): anthropic `claude-opus-4-8` 5.00/25.00/6.25/0.50 · `claude-sonnet-4-6` 3.00/15.00/3.75/0.30 · `claude-haiku-4-5` 1.00/5.00/1.25/0.10 · legacy `claude-opus-4-6` 15.00/75.00/18.75/1.50 (classifier `premiumModel` still defaults to it — must stay priced; bumping that default is a flagged follow-up, not this slice) · gemini `gemini-2.0-flash` 0.10/0.40/0.10/0.025 (only Gemini model the repo can emit; cache columns inert). `effectiveFrom` backdated to `2025-01-01T00:00:00Z` so historical `created_at` joins resolve; `effectiveTo` omitted. **Confirm all prices against live vendor pricing at implementation time** (v4 doc's own caveat: pricing moves fast and must live in the table, not in anyone's memory) |
| MODIFY | `scripts/seed.ts` | Second loop over `readdirSync(SEEDS_DIR).filter(f => f.endsWith('.pricing.json'))`; Zod-validate the file (external input); insert with `onConflictDoNothing({ target: [provider, model, effectiveFrom] })` — re-seeds idempotent, existing versions never mutated (price change = new `effectiveFrom` row). Log `Seeded model_pricing: N rows` |

### 3.4 Cost pipeline

| Action | File | Change |
|---|---|---|
| CREATE | `src/orchestrator/pricing.ts` | `lookupPricing(provider, model, at)` — Drizzle query: `effectiveFrom <= at AND (effectiveTo IS NULL OR effectiveTo > at)`, `ORDER BY effectiveFrom DESC LIMIT 1`. In-memory `Map` cache keyed `provider:model`, 5-min TTL (budget.ts precedent); **negative results cached too**. `computeCostUsd(provider, model, {input, output, cacheWrite, cacheRead}, at = now)` → `{ costUsd: number \| null, pricingId: string \| null }` — **pure addition** `(input·in + output·out + cacheWrite·cw + cacheRead·cr) / 1e6` (fixes the double-subtract). **Unknown model ⇒ structured warn `model_pricing_missing` + NULL cost + NULL pricingId — never silent 0** (the warn is the alert hook; no PII). Documented consequence: NULL costs don't count toward `dailySpendCapUsd` (SUM skips NULL) until the seed row lands. `clearPricingCache()` exported as the WP4 test hook |
| MODIFY | `src/orchestrator/llm-provider.ts` | `StreamResult.usage` → `{ input_tokens, output_tokens, cache_write_tokens, cache_read_tokens }`; add `model` (the model actually invoked — Gemini returns the resolved `pickGeminiModel` output so the pricing join is honest). Anthropic path captures `cache_creation_input_tokens` (currently dropped) and drops the `as unknown as Record<string, number>` cast (SDK ^0.39 types both fields). Gemini path returns explicit zeros for both cache tiers |
| MODIFY | `src/orchestrator/agent-loop.ts` | Split accumulators (`totalCacheWriteTokens`/`totalCacheReadTokens`); capture both tiers at lines 266-269; usage insert writes split columns + `pricingId` via `computeCostUsd` (`tokensCached` no longer written); trace `ai` block gains split fields; **DELETE `estimateCost` (lines 517-533) entirely** — grep-verified: only `agent-stream.ts` imports it |
| MODIFY | `src/orchestrator/agent-stream.ts` | Same accumulator/insert treatment; delete the "nominal Anthropic pricing" hack comment (lines 230-232); `done` SSE event + `agent_run.completed` webhook payload gain `cache_write_tokens`/`cache_read_tokens`, keep `cached_tokens` (= read count) for consumer compat; `cost_usd: number \| null` in the `StreamEvent` union (line 51) |
| MODIFY | `src/admin/analytics/routes.ts` | Aggregates use `COALESCE(tokens_cache_read, tokens_cached)`; add a cache-write aggregate. **Keep response key names** (`totalCachedTokens`, `cachedTokens`) so the dashboard needs zero changes. Optional 1-line fix (recommended): cache-hit-rate denominator should be `input + cacheWrite + cacheRead` since `input_tokens` excludes cache tokens |

---

## 4. WP2 — (a) Fallback chain: verify + harden

### 4.1 Acceptance criteria — what "verified end to end" means

For each failure class F ∈ {429 rate_limit, 529 overloaded, 500/5xx, network error, request timeout} on the **primary**:

| # | Assertion |
|---|---|
| A1 | Fallback provider/model invoked exactly once, only after the SDK's own retries (3 attempts) exhaust on the primary |
| A2 | The turn completes: final text returned / `done` event emitted |
| A3 | Exactly **one** `llm_usage_logs` row for the turn, `provider`/`model` = what **actually served** (the fallback); failed-primary tokens not counted (no double-billing) |
| A4 | `costUsd` computed from the served model via the WP1 pricing table |
| A5 | Structured log `llm_fallback` `{fromProvider, fromModel, toProvider, toModel, status, errorType, requestId, tenantId}` — never message content (no PII) |
| A6 | Non-retryable errors (400/401/403/404/413/422) do NOT fall back; error propagates to the existing catches; no usage row |
| A7 | **Streaming safety:** if the primary stream fails after emitting ≥1 text delta, fallback is NOT attempted (would duplicate tokens on SSE clients); fallback only when zero deltas emitted |
| A8 | Budget interactions see the served attempt: `incrementBudgetUsage` and the daily-cap SUM operate on fallback-priced rows |

### 4.2 Changes

**Single seam: `src/orchestrator/llm-provider.ts`.** `classifier.ts`/`compaction.ts` stay direct-Anthropic (internal, cheap, own degraded modes) — documented follow-up, not M1.

| Action | File | Change |
|---|---|---|
| MODIFY | `src/orchestrator/llm-provider.ts` | (1) Config via env, matching the existing pattern: `LLM_FALLBACK_PROVIDER` (default `anthropic`), `LLM_FALLBACK_MODEL` (default `claude-haiku-4-5` — less-loaded tier; same-provider preserves tool-use/content-block semantics). Per-tenant `tenantConfig.ai.fallbackProvider` (typed, dead) = documented future override, not plumbed in M1. (2) Clients: `new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 })` — SDK does the 3-attempt retry; our layer adds exactly one fallback hop (the "max-3-retries" mapping). Gemini client constructed when **either** primary or fallback is gemini (today primary-only ⇒ cross-provider fallback impossible). (3) Export `isRetryableLlmError(err)` — check `APIConnectionError` **before** `APIError` (it's a subclass in the TS SDK); retryable = connection errors, 429, ≥500 (incl. 529 overloaded); same shape for the OpenAI SDK. (4) Wrap `streamLlm`: delta-emitted guard (A7) → classify (A6) → warn `llm_fallback` (A5) → single hop to fallback dispatch. `StreamResult` gains `servedBy: { provider, model }`. (5) NEW `callLlm()` non-streaming counterpart, same fallback loop; `system: string \| Anthropic.TextBlockParam[]` (agent-loop passes prompt-builder's cached block array); Gemini converter gains a block-array flatten |
| MODIFY | `src/orchestrator/agent-loop.ts` | Delete the module-scope Anthropic client; route `anthropic.messages.create` (lines 252-259) through `callLlm` — the WhatsApp path gets fallback for free; usage insert uses `servedBy` (removes the hardcoded `'anthropic'` at line 420) |
| MODIFY | `src/orchestrator/agent-stream.ts` | Track last `servedBy` across loop iterations; usage row + cost use served provider/model (also fixes "Gemini billed at Anthropic nominal model") |
| CREATE | `scripts/manual/fallback-check.ts` | Dev-only manual live check: one-shot local HTTP server returning `529 overloaded_error`; `ANTHROPIC_BASE_URL` pointed at it for the primary; invoke a turn against the dev DB; expect newest usage row = fallback provider/model + one `llm_fallback` log line. Negative check: invalid API key ⇒ 401 ⇒ correctly no fallback |

---

## 5. WP3 — (b) Corrections retrieval loop (full, with embeddings)

**Design:** capture already writes `messages.wasCorrected`/`correction` and `correction_rules`; what's missing is embedding-at-capture, per-turn retrieval, and injection — plus fixing the rules-path stub. Reuse the exact `knowledge_chunks` pgvector pattern (Drizzle table without the vector column + raw-SQL migration adding `vector(1536)` + ivfflat cosine index + RLS — `drizzle/0000_init.sql` precedent) and the existing `text-embedding-3-small` embedder. **Retrieval key:** embed *the context in which the correction applies* — `"<preceding user message>\n<corrected text>"` at capture; query with the incoming user message each turn.

| Action | File | Change |
|---|---|---|
| MODIFY | `src/shared/schema/corrections.ts` | ADD `message_corrections`: `id`, `tenantId (NOT NULL FK)`, `agentTypeSlug` (from `conversations.currentAgentType` at capture), `sourceMessageId`, `userText` (preceding user msg — retrieval context), `originalText`, `correctedText NOT NULL`, `createdAt`; index `(tenantId, agentTypeSlug)`. **Do NOT put vectors on the hot `messages` table** |
| CREATE | `drizzle/0001_message_corrections.sql` | `ALTER TABLE message_corrections ADD COLUMN IF NOT EXISTS embedding vector(1536);` + ivfflat `vector_cosine_ops` index + RLS policy (`tenant_id = current_setting('app.tenant_id', true)::uuid`) + `ENABLE ROW LEVEL SECURITY` — 0000_init.sql pattern. Apply: `npm run migrate` (push creates the table) → `psql -f drizzle/0001_message_corrections.sql`. Rides WP1's migration window — one ceremony |
| MODIFY | `src/admin/corrections/routes.ts` | (1) **Zod schemas on all bodies** (currently plain TS generics — CLAUDE.md violation): immediate `{ messageId: uuid, correctedText: 1..4000, sendToUser: boolean, apologyPrefix?: ..500 }`; same treatment for rules POST/PUT. (2) **Fix the tenant-isolation bug:** SELECT the message `WHERE (id, tenantId)` → 404 if absent; UPDATE with both predicates; populate `originalText` from `content->>'text'` (closes the TODO at line 31). (3) On immediate correction: find the conversation's `currentAgentType` + nearest preceding `senderType='user'` message (tenant-scoped, `createdAt <` corrected msg, desc limit 1); `generateEmbedding(userText + '\n' + correctedText)`; insert the `message_corrections` row writing the vector via the same drizzle `sql` template pattern as `searchKnowledge`. **Embedding failure never fails capture** (try/catch; row inserted with NULL embedding; retrieval skips NULLs). Log ids only — never text (PII). (4) Complete the `appliesToAgents` stub in `loadActiveCorrections` (select the column; keep rule if null/empty/includes(agentSlug)) |
| CREATE | `src/admin/corrections/retrieval.ts` | `searchPastCorrections(tenantId, agentSlug, queryText, topK = 3, minSimilarity = 0.5)` → `Array<{ userText, originalText, correctedText, score }>`. Cosine similarity `1 - (embedding <=> $vec)`; `WHERE tenant_id = $t AND (agent_type_slug = $slug OR agent_type_slug IS NULL) AND embedding IS NOT NULL ORDER BY embedding <=> $vec LIMIT $k`, then score-floor filter in TS (drizzle `sql` template — same accepted exception as `searchKnowledge`). Guards: no `OPENAI_API_KEY` or zero-vector query embedding ⇒ `[]`. K=3 / floor 0.5 as tunable constants. Structured log `{tenantId, agentSlug, hits, topScore}` — never text |
| MODIFY | `src/memory/knowledge-base.ts` | 1-line: `export` on `generateEmbedding` |
| MODIFY | `src/orchestrator/prompt-builder.ts` | `PromptContext.pastCorrections?: string[]`; render in the **dynamic block only** — after Active Corrections, before the language instruction; **never in the `cache_control` static block**: `## Learned Corrections (from past operator fixes — guidance, not verbatim replies)` + bullet per item `When the customer asked: "<userText ≤160 chars>" — the correct answer is: "<correctedText ≤240 chars>"`. Whole block capped ~600 tokens (~2,400 chars), lowest-score items dropped first. Formatting happens in agent-loop (retrieval returns structured rows; prompt-builder just renders strings) |
| MODIFY | `src/orchestrator/agent-loop.ts` | Call `searchPastCorrections(tenantId, agentSlug, processedInput)` alongside `loadActiveCorrections` (line 181 area); pass formatted strings into `buildPrompt` |

**Strict-write-discipline caveats (encoded in header + code):** (i) the block header marks items as guidance, not scripts — no verbatim replay of stale answers; (ii) retrieved text is customer-derived → never logged, never added to `conversationTraces.traceData`; (iii) every query tenant-scoped; (iv) block always below the cache boundary so per-turn variance never invalidates the static cache.

**Out of scope (documented):** corrections on the `agent-stream.ts` SSE path — it bypasses `buildPrompt` and its LMS agents emit strict JSON; unifying it with prompt-builder is a follow-up.

---

## 6. WP4 — (d) First test suite

**Executor hardening first (prerequisite for its tests, per confirmed decision):**

| Action | File | Change |
|---|---|---|
| MODIFY | `src/tools/executor.ts` | (1) HITL short-circuit: `requiresHitl`/`requiresUserConfirm` ⇒ `{success: false, error: {code: 'HITL_REQUIRED'}}`, handler not called. (2) Implement `executionConfig.retryCount` (re-invoke on failure up to N) and `fallbackMessage` (final-failure error message). (3) `clearTimeout` after the race in `executeWithTimeout` (timer leak). (4) Zod param-envelope gate ⇒ `{success: false, error: {code: 'INVALID_PARAMS'}}` before any handler/HTTP call |

**Test files (all CREATE):**

| File | Covers |
|---|---|
| `tests/orchestrator/llm-fallback.test.ts` | The A1–A8 matrix: 429/529/500/network/timeout ⇒ fallback once, correct `servedBy`; 400/401 ⇒ no fallback, rethrow; mid-stream failure after ≥1 delta ⇒ no fallback; both-fail ⇒ propagate (primary then fallback attempted, nothing else); `isRetryableLlmError` unit matrix over all error classes; cross-provider env (`vi.resetModules` path) ⇒ gemini client constructed for fallback even when primary is anthropic; clients constructed with `maxRetries: 2` / `timeout: 60_000` |
| `tests/orchestrator/agent-loop.test.ts` | Happy path (agent message row, WhatsApp send, usage row provider/model/tokens, `incrementBudgetUsage(input+output)`, trace row) · tool-use loop (full tenant ctx passed to `executeTool`, `tool_result` fed back with matching `tool_use_id`, tokens summed across turns, **single** usage row) · serial ordering contract (two `tool_use` blocks execute in order — documents current behavior; read-concurrency explicitly absent) · `MAX_TOOL_ITERATIONS` (10) cap, usage still logged · fallback path (usage row = fallback pair, one row, `llm_fallback` log via pino spy) · terminal LLM failure (persona `fallbackMessage` sent via WhatsApp, **no** usage row) · budget gate (over-limit ⇒ no LLM call) · corrections regression (`pastCorrections` reaches `buildPrompt`; "Learned Corrections" present in the dynamic system block and absent from the `cache_control` static block) |
| `tests/tools/executor.test.ts` | Internal gateway dispatch (handler resolved via registry, receives params + `{tenantId, userId, conversationId}` ctx) · `TOOL_NOT_FOUND` with tenant-scoped lookup asserted · shadow mode (write-category short-circuited to `dryRun`, handler not called; read still executes) · HITL gate (`HITL_REQUIRED`, handler not called) · timeout (fake timers, `EXECUTION_ERROR` "timed out", no leaked handles) · retry (fail-fail-succeed ⇒ success with 3 invocations; exhausted ⇒ failure) · `fallbackMessage` on final failure · external HTTP path (path-param substitution `/orders/{order_id}`, `responseMapping` extraction, non-ok ⇒ `HTTP_<status>`, `AbortSignal.timeout` passed) · Zod param gate ⇒ `INVALID_PARAMS` before any call |
| `tests/orchestrator/budget.test.ts` | No `monthlyTokenBudget` ⇒ `withinBudget: true`, no redis/db touch · cache hit ⇒ parsed value, no db query · cache miss ⇒ month-SUM query (tenantId + first-of-month), `setex` 300s, correct `percentUsed` · `used >= limit` ⇒ false; ≥80% ⇒ warn/info logs (pino spy) · `incrementBudgetUsage` increments only when key exists, no-op otherwise |
| `tests/orchestrator/agent-stream.test.ts` (minimal) | `dailySpendCapUsd` reached (db SUM ≥ cap) ⇒ `{type:'error', message:'agent_disabled_budget'}` event, `{agentDisabled:'budget'}` return, no LLM call, no usage insert · under cap ⇒ proceeds · usage row written with `servedBy` provider/model |

**Explicit M1 non-goals** (record in the test README header with rationale): Redis circuit breaker · read-parallel tool scheduling · classifier/compaction fallback · real-Postgres integration test lane (CI stays network-free; testcontainers lane is a follow-up) · billing_periods / invoices / ledger / budget alert notifications (M3) · agent-stream prompt-builder unification.

---

## 7. Verification commands

```bash
npm run typecheck                                          # strict TS incl. tests
npm test                                                   # full vitest suite — no network, no live API
npx vitest run tests/orchestrator/llm-fallback.test.ts     # milestone-(a) acceptance matrix
npm run migrate                                            # additive: model_pricing + 3 columns (rebuild or remove stale dist/ first!)
psql "$DATABASE_URL" -f drizzle/0001_message_corrections.sql
npx tsx scripts/backfill-cache-token-split.ts
npm run seed                                               # pricing rows, idempotent
npx tsx scripts/manual/fallback-check.ts                   # dev-only live fallback check (529 mock server)
```

SQL spot-checks after migration + one live agent turn:

```sql
-- 1. Pricing seeded; one active version per (provider, model)
SELECT provider, model, input_per_mtok, cache_write_per_mtok, cache_read_per_mtok, effective_from, effective_to
FROM model_pricing ORDER BY provider, model, effective_from;

-- 2. Backfill complete (expect 0)
SELECT COUNT(*) FROM llm_usage_logs
WHERE tokens_cached IS NOT NULL AND tokens_cache_read IS DISTINCT FROM tokens_cached;

-- 3. New rows carry split tokens + pricing join (expect tokens_cached NULL, pricing_id NOT NULL)
SELECT model, provider, tokens_input, tokens_cache_write, tokens_cache_read, tokens_cached, cost_usd, pricing_id
FROM llm_usage_logs ORDER BY created_at DESC LIMIT 5;

-- 4. Stored cost matches recompute through the time-versioned join (expect equality)
SELECT u.id, u.cost_usd,
  ROUND((u.tokens_input * p.input_per_mtok + u.tokens_output * p.output_per_mtok
       + COALESCE(u.tokens_cache_write,0) * p.cache_write_per_mtok
       + COALESCE(u.tokens_cache_read,0)  * p.cache_read_per_mtok) / 1e6, 6) AS recomputed
FROM llm_usage_logs u JOIN model_pricing p ON p.id = u.pricing_id
WHERE u.pricing_id IS NOT NULL ORDER BY u.created_at DESC LIMIT 10;
```

Corrections smoke (dev): `POST /admin/corrections/immediate` on a recent agent message → send a similar user message → expect a `module=corrections` retrieval-hit log (`hits ≥ 1`) and the "Learned Corrections" block in the prompt debug output. Analytics smoke: `GET /admin/analytics/:tenantId/costs` returns coherent `totalCachedTokens` spanning legacy + new rows.

---

## 8. Risks

1. **Deploy ordering:** code before seed ⇒ NULL costs + `model_pricing_missing` warns; NULL costs don't count toward `dailySpendCapUsd`. Mitigate: migrate → backfill → seed → deploy.
2. **Stale `dist/` trap:** `drizzle.config.ts` prefers compiled schema — a stale build makes push silently miss new columns. Rebuild or remove `dist/` before `npm run migrate`.
3. **Reported costs will rise** — fixing the double-subtract and billing cache writes at 1.25× is a correction, not a regression; tenants near `dailySpendCapUsd` may trip caps sooner. Call out in release notes.
4. **`done` SSE event `cost_usd` becomes nullable** — strict consumers must tolerate; `cached_tokens` kept for compat.
5. **Legacy rows keep old-formula costs** (`pricing_id IS NULL` marks them); recomputing would fabricate precision the data can't support.
6. **`claude-opus-4-6` naming drift:** classifier `premiumModel` still defaults to it — kept priced in the seed; bumping the default to `claude-opus-4-8` is a flagged follow-up (WP2-adjacent, not this milestone's scope).
7. **Fallback masks provider degradation** if left silent — the `llm_fallback` structured warn is the observability hook; watch its rate after deploy.
