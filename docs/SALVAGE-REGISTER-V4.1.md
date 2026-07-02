# AgentForge — Salvage Register & Verified Parity Addendum (v4.1)

**Companion to:** AgentForge Requirements & Parity Document v4
**Basis:** Direct clone + code-level analysis of `amtariksha/agentforge@main` (commit `7e6333e`) and `amtariksha/chatagent@main` (commit `93aa26a`), 02 Jul 2026.
**Purpose:** Record what was already built once in the Python platform, what the TS rebuild already covers, and exactly what to carry forward — so nothing gets built a third time.

---

## 0. Local folders — action item for Pradeep

`project10-chatagent` and `chat-agent-old` map to these same GitHub repos, so the analysis below covers them **if everything is pushed**. Run this in each local folder to confirm nothing lives only on disk:

```bash
git status --short && git log origin/main..HEAD --oneline
```

If either shows unpushed commits or uncommitted files, push or zip just the delta.

---

## 1. Verified stack snapshot

| | chatagent (old) | agentforge (current) |
|---|---|---|
| Language / framework | Python, FastAPI, SQLAlchemy/Alembic | TypeScript, Fastify 5, **Drizzle ORM** |
| Agent framework | LangChain + LangGraph | None — hand-rolled loop (correct) |
| Vector store | ChromaDB | pgvector (`knowledge.ts`, `knowledge-base.ts`) |
| Queue | — (uvicorn only) | BullMQ + Redis |
| LLM providers | 6 (OpenAI, Anthropic, Gemini, Groq, DeepSeek, OpenRouter) via LangChain | Anthropic SDK + Gemini via OpenAI-compatible endpoint |
| Channels | Web widget, WhatsApp, Telegram, (voice, WordPress) | Web widget, WhatsApp (**incl. coexistence**), Telegram, mobile routes, WS, SSE |
| Admin UI | Next.js + shadcn (`admin/`) | Next.js + shadcn (`dashboard/`) — rebuilt, multi-tenant aware |
| Size | 473 files; own audit (`feature_list.json`, 2025-12-19) lists **38 features, all failing** | 168 files, focused |

**Note for the v4 doc:** it assumed Prisma. The repo uses **Drizzle**. Keep Drizzle — schema quality is good, migration churn buys nothing. Treat every "Prisma schema" item in v4 as a Drizzle schema item.

The old repo's own `feature_list.json` marking all 38 features as failing is the clearest justification of the rebuild decision — the scrap was correct; the *feature map* is the asset.

---

## 2. Verified current state of AgentForge (corrects v4 assumptions)

### 2.1 Already built — stronger than the v4 doc assumed

| Capability | Evidence | Status vs v4 |
|---|---|---|
| Tenant → Agent → Tool hierarchy | `tenants` (config jsonb) → `agent_types` (per-tenant slug, priority, confidence, model override) → `tools` + `agent_tools` join | **EXISTS** — matches v4 §3 model almost exactly |
| Super-admin + sub-portal | commits `7d576e2`, `7e6333e`; `active-tenant` resolution; tenant CRUD UI | EXISTS |
| Tool definition schema | `tool-definition.ts`: read/write/destructive category, `requiresHitl`, `requiresUserConfirm`, JSON-schema params, `backendMapping` internal/external, timeout/retry/fallback, per-agent-type permissions | **EXISTS** — v4's tool registry is ~70% done |
| Internal tenant gateway | `tools/tenant-gateway/` with registry; swarg-food folder (12 LMS tools, commit `baf9d1f`) | EXISTS (1 of N tenants) |
| Agent loop | `agent-loop.ts` (533 lines): tool-use loop, read-concurrent/write-serial per CLAUDE.md, circuit breaker | EXISTS |
| Streaming | `agent-stream.ts` — SSE with typed events (`token`, …) | EXISTS (text-only, see gaps) |
| Routing/classification | `classifier.ts` (Haiku), intent keywords/examples on agent_types | EXISTS |
| Context management | `compaction.ts` (Micro/Auto/Full), `prompt-builder.ts` static/dynamic cache split | EXISTS — already implements the context-engineering patterns v4 §8 recommends |
| Guardrails | input + output, `guardrails.ts` + schema + dashboard page | EXISTS |
| Memory | 3-layer (index → topic → transcript) per CLAUDE.md; `memory-manager.ts`, `consolidation.ts`, pgvector KB | EXISTS |
| HITL | approval-queue, escalation, live-chat manager, operators page, tickets + SLA checker job | EXISTS |
| Corrections loop (seed of "learning") | `corrections` schema + admin routes + dashboard page; `wasCorrected`/`correction` on messages | **PARTIAL** — capture exists; retrieval-into-prompt loop must be verified/completed (v4 §use-case 9 depends on it) |
| Usage telemetry | `llm_usage_logs`: tenantId, conversationId, **agentTypeSlug**, model, provider, tokens in/out/cached, `costUsd`, indexes for per-agent daily rollups | **EXISTS** — the exact per-tenant + per-agent + per-conversation granularity you asked for is already captured at write time |
| Budget guards | `budget.ts` monthly token budget w/ Redis cache; `dailySpendCapUsd` per agent (429 `agent_disabled_budget`) | EXISTS |
| Shadow mode | `agent_types.shadowMode` — write tools dry-run for 14-day eval window | EXISTS (nice — v4 didn't have this; keep it as the standard promotion gate for every new agent) |
| Tracing | `conversation_traces` per-turn jsonb | EXISTS |
| Multi-provider | `llm-provider.ts`; Gemini via OpenAI-compat (commit `462c3dc`) | EXISTS (fallback chain: verify) |

### 2.2 Verified gaps (the real build list)

1. **Generative UI — the Phase-1 core requirement.** `agent-stream.ts` emits only text tokens; the widget is a plain chat embed. However, `messages.content` is already `jsonb` — the substrate for structured content blocks exists. Nothing renders cards/charts/forms today.
2. **Billing on top of metering.** Capture is done; missing: versioned `model_pricing` table (costUsd source is currently code-side — same hardcoded-pricing anti-pattern as the old repo's `cost_tracker.py`), cache **write vs read** token split (single `tokensCached` today; Anthropic bills 5-min cache writes at 1.25×, reads at 0.1×), `billing_periods` + `invoices` + line-item generation job, budget **alert notifications** (currently log-only), per-conversation cost API.
3. **Only one tenant gateway** (swarg-food). Meraghar, Karmayog, Eassylife, Aedhas, AiroGro, CommunityOS folders don't exist.
4. **No async/operator runtime.** Everything is the sync chat loop. The accounting-reconciliation and marketing-intelligence agents (v4 flagged deviations) need the BullMQ-driven operator mode — queue exists, runtime doesn't.
5. **Tool registry v2 gaps:** no versioning, no shared tool templates w/ per-tenant overrides, no per-tool rate limits, no MCP transport.
6. **No evaluator / LLM-as-judge**, no test suite in repo.
7. **`CLAUDE.md` contradicts the new requirements** — see §5. This is the highest-leverage 10-minute fix, because Claude Code obeys that file.

---

## 3. Salvage register — chatagent (Python) → AgentForge (TS)

Verdicts: **PORT** (translate nearly as-is) · **ADAPT** (take the design, reshape) · **REFERENCE** (read before building, don't copy) · **KEEP SCRAPPED** · **DEFER**.

### 3.1 PORT — highest value

| Old asset | What it is | Target in AgentForge |
|---|---|---|
| `app/models/rich_cards.py` (185 ln) | Unified rich-media schema: ProductCard, Carousel, QuickReplies, Image/Video, Webview, buttons w/ actions (url/postback/call/buy/view/share), **mandatory `fallback_text`** | `src/ui/content-blocks.ts` — this is the **seed of your generative UI wire format**. Port as Zod schemas; extend with the v4 block set: `chart`, `table`, `form`, `comparison`, `invoice_list`, `confirmation`, `kpi_card`, `timeline` |
| `app/channels/renderers.py` (310 ln) | BaseRenderer + WebWidget/WhatsApp/Telegram adapters converting one RichCard to channel-native payloads (WhatsApp interactive messages etc.) | `src/gateway/renderers/` — exactly the degradation strategy v4 §4 needs: full blocks on web/Flutter, WhatsApp interactive lists/buttons, plain-text fallback everywhere. The pattern survives; rewrite in TS against current WhatsApp Cloud API |
| `endpoints/costs.py` + `billing.py` response shapes | Tenant usage, daily breakdown, platform summary, top-tenants | `src/admin/analytics/` cost routes — same aggregations, now with agentTypeSlug + conversation dimensions that already exist in `llm_usage_logs` |

### 3.2 ADAPT

| Old asset | Design worth keeping | Reshape as |
|---|---|---|
| `wallet_service.py` (346 ln) | Prepaid credit ledger: balances, debits per usage, top-ups (Razorpay), low-balance behavior | **Internal project billing ledger.** Each tenant/project gets a ledger; nightly rollup job debits actual LLM cost + margin. Gives you the "bill to the respective project" mechanics without inventing invoicing from scratch. Razorpay top-up path is optional-only (internal tenants settle via invoice) |
| `model_router.py` + `llm_factory.py` | Model fallback chain, per-bot model selection | Verify/extend `llm-provider.ts` fallback: primary → fallback on 429/5xx/timeout, logged to `llm_usage_logs` with `provider` |
| `sentiment_analyzer.py` | Sentiment → escalation signal | Fold into existing `classifier.ts` output (one call, add sentiment + frustration fields) feeding `escalation.ts` — don't keep a separate service |
| `proactive.py` + notifications | Proactive outbound nudges | DEFER to M6, then adapt for Swarg subscription nudges ("increase only for tomorrow?" prompts before cutoff) via BullMQ scheduled jobs + WhatsApp sender that already exists |
| `hitl_service.py`, `rolling_summarizer.py`, `prompt_cache.py`, `language_detector.py` | — | Already re-implemented (approval-queue/escalation, compaction, prompt-builder, language.ts). No action; skim only if a bug reproduces |

### 3.3 REFERENCE — read, then do it right

| Old asset | Lesson |
|---|---|
| `cost_tracker.py` `LLM_PRICING` dict | **The anti-pattern that motivates the pricing table.** Hardcoded Dec-2024 prices, no cache tiers, no history — a price change silently corrupts all past cost math. Replace with `model_pricing` (provider, model, input/output/cache_write/cache_read per-MTok, `effective_from`, `effective_to`) and compute `costUsd` by joining usage timestamp → active price row |
| `token_counter.py` (tiktoken) | Client-side token estimation is unnecessary — Anthropic's API returns authoritative `usage` incl. `cache_creation_input_tokens` / `cache_read_input_tokens`. Persist those two separately (schema change: split `tokensCached`) |
| `ADVANCED_FEATURES_PLAN_1.md` §1 | Evaluation framework + LLM-as-judge + prompt experiments — your own past design maps cleanly onto v4's M7 eval harness. §3 (rich media) and §4 (MCP vs generated APIs hybrid) validate the v4 direction — you'd already reached the same conclusions once |
| `api_code_generator.py` + `APICodeGeneratorModal` | Gemini-generated integration code for tools. Clever, but generated-code-in-DB is fragile. Reconsider in v2 as a **dashboard authoring aid** that drafts `backendMapping` JSON (external type) for review — never executes generated code directly |
| `agent_types.csv` | Your own field-tested catalog (Sales/Support/Billing/Tracking personas, intent keyword sets, priorities, handoff messages) — reuse verbatim as seed content in `config/seeds/*.seed.json` for new tenants |

### 3.4 KEEP SCRAPPED (rightly abandoned — resist nostalgia)

LangChain/LangGraph orchestration · ChromaDB · React-Flow visual flow builder (`DecisionNode/ClassifierNode/RouterNode/ActionNode`) + `flow_executor` · conversation-flow trees · A/B experiment UI · blueprint/template system · WooCommerce/WordPress plugin (revive only if a paying tenant demands it) · Railway deploy · avatar/persona generators (cosmetic).

The CLAUDE.md "Do NOT Build" list already encodes most of this — correct instincts, keep them.

### 3.5 DEFER

Voice (`deepgram_stt`, `elevenlabs_tts`, `voice_service`) — superseded by the Lara spec (Sarvam/ElevenLabs routing); when AgentForge grows voice, it inherits Lara's stack, not this code.

---

## 4. Generative UI — concrete plug-in points (verified against code)

1. **Wire format:** port RichCard → `src/ui/content-blocks.ts` (Zod). A message's `content` jsonb becomes `{ blocks: ContentBlock[] }`; plain text is just a `text` block — zero migration for existing rows.
2. **Emission path A (deterministic, preferred):** tools return `{ data, ui?: ContentBlock[] }`. `executor.ts` passes `ui` through; `agent-loop.ts` attaches blocks to the assistant message. Products/invoices/charts render from *tool truth*, not model prose — no hallucinated prices.
3. **Emission path B (model-driven):** one platform tool `render_ui(blocks)` with the Zod schema as its JSON schema, for cases where the model composes the view (comparisons, decision aids). Guardrail: validate blocks server-side; on failure, fall back to `fallback_text`.
4. **Stream event:** add `{ type: 'ui', blocks }` to the `agent-stream.ts` event union (it's a typed union already — small diff).
5. **Renderers:** `src/gateway/renderers/{web,whatsapp,telegram}.ts` per §3.1; widget upgrade to render blocks; Flutter client consumes the same JSON (server-driven UI — matches your Swarg/CommunityOS Flutter apps).
6. **Actions:** button `postback` payloads arrive as user messages with `metadata.action` — the loop treats them as structured user turns (old repo's postback concept, formalized).

This keeps the v4 §4 protocol intact while reusing ~500 lines of your own prior design thinking.

## 5. CLAUDE.md amendments (do this first — Claude Code obeys this file)

```diff
 ## Do NOT Build
 - No LangChain/LangGraph.
 - No ChromaDB (use pgvector).
 - No conversation flows / visual builder.
 - No A/B testing.
 - No internal CRM/Kanban (use outbound webhooks to external CRM).
-- No billing/subscriptions yet.
 - No voice yet.
 - No formal blueprint/template system (configure tools directly).
+
+## Build (v4 additions)
+- Generative UI: content blocks (src/ui/content-blocks.ts), tool `ui` passthrough,
+  render_ui platform tool, channel renderers. Messages.content = { blocks: [...] }.
+- Cost & billing: model_pricing (versioned, cache write/read tiers), split
+  tokensCached → tokensCacheWrite/tokensCacheRead, billing_periods, invoices,
+  ledger, budget alert notifications. llm_usage_logs stays the single source.
+- Async operator runtime on BullMQ for accounting-reconciliation and
+  marketing agents (approval-gated, no direct customer chat).
+- Tool registry v2: versioning, shared templates + per-tenant overrides,
+  per-tool rate limits. MCP transport optional, external-facing only.
```

## 6. Milestone deltas vs v4 plan

- **M1 (platform core): ~80% pre-existing.** Recast M1 as *verify + harden*: fallback chain test, corrections-retrieval loop completion, first test suite (loop, executor, budget), CLAUDE.md amendment, split cache-token columns + `model_pricing` table (small, do early — every day of usage logged before the split loses cache-tier fidelity).
- **M2 (generative UI): accelerate** — seeded by RichCard port (§4). Widget + WhatsApp renderer in same milestone; Flutter contract doc only.
- **M3 (billing): reduce scope** — capture exists; build pricing join, rollups, ledger (adapted wallet), invoice PDF job, alerts.
- **M4 (tenant gateways):** replicate swarg-food folder pattern per tenant; Meraghar + Karmayog first (smallest tool surfaces), Aedhas scoring after.
- **M5 (operator runtime):** unchanged from v4; shadowMode is the promotion gate.
- **M6–M7:** unchanged; evaluator lifts design from `ADVANCED_FEATURES_PLAN_1.md` §1.

---

*Everything above is verified against actual code, not the GitHub web view. Hand this file + v4 to Claude Code together; start with §5.*
