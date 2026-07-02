# AgentForge Parity List & Requirements Document (v4)
## Multi-Tenant, Multi-Agent AI Platform — Implementation-Ready Specification

**Prepared for:** Pradeep, Founder, Amtariksha Tech Pvt Ltd (Bangalore)
**Date:** July 2, 2026
**Scope:** Repo parity analysis, architecture requirements, use-case specs, SOTA methods, DB/API schema, phased plan for Claude Code execution.

---

## TL;DR
- **AgentForge should be built as a modular-monolith Fastify/TypeScript platform with a strict object model (Tenant → Agent → Tool/Conversation), a generative-UI protocol treated as a Phase-1 core deliverable, and per-conversation token/cost metering wired in from day one** — this is achievable in the existing repo with the user's stack (Fastify, Prisma/PostgreSQL, pgvector, Redis/BullMQ, direct Anthropic API, no LangChain).
- **Two use cases are flagged as partial deviations:** the Swarg accounting/bank-reconciliation agent (needs a deterministic rules-engine + human-in-loop learning loop, not a pure LLM agent) and the Marketing intelligence agent (needs long-running scheduled jobs + external ad/SEO APIs — fits as an async "operator" agent class, not a chat agent). Neither should be force-fit into the synchronous chat path.
- **I could not directly read the two GitHub repos** (`amtariksha/agentforge` and `amtariksha/chatagent`) — GitHub blocks automated/unauthenticated tree access and neither repo is search-indexed. The parity table below is therefore structured against the stated v3.1 spec and must be reconciled by running the Claude Code audit prompt in §1 against the actual code.

---

## Key Findings

1. **The "agent as frontend" vision aligns directly with an emerging industry standard.** The MCP Apps extension (SEP-1865) — proposed November 21, 2025 and released as MCP's first official extension on January 26, 2026, co-authored by named MCP maintainers including Sean Strong and Jerome Swannack (Anthropic), Alexi Christakis and Bryan Ashley (OpenAI), together with MCP-UI creators Ido Salomon and Liad Yosef — defines exactly the pattern the user wants. Per the Model Context Protocol blog: *"UI templates are resources with the `ui://` URI scheme, referenced in tool metadata."* Tools carry a `_meta.ui.resourceUri` pointing to a UI resource rendered in a sandboxed iframe with bidirectional JSON-RPC-over-postMessage. AgentForge should design a generative-UI protocol that mirrors this standard (component schema + intent-bubbling) without necessarily adopting MCP as transport.

2. **The unified platform is viable, but requires clean separation of three agent execution modes:** (a) synchronous chat agents (support, sales, navigation), (b) asynchronous "operator" agents (marketing, forecasting, reconciliation) run via BullMQ, and (c) form-filling/transactional agents (Karmayog task creation, Swarg order ops). One agent registry, three runtime harnesses.

3. **Cost metering at per-tenant + per-agent + per-conversation granularity is straightforward** because the Anthropic Messages API returns `usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` on every response. Capture these per LLM call, attach tenant/agent/conversation IDs, and aggregate. Pricing must be versioned in a table because Anthropic ships new models frequently (Opus 4.8 at $5/$25 per MTok as of May 28, 2026; Sonnet 4.6 at $3/$15; Haiku 4.5 at $1/$5).

4. **The old chatagent repo's most salvageable assets are its integration adapters and session/conversation persistence** — the chat loop itself should be rebuilt around the direct Anthropic tool-use loop and context compaction, not carried forward if it used an older framework abstraction.

5. **State-of-the-art patterns to adopt:** Anthropic's five workflow patterns (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer); orchestrator-worker multi-agent only where breadth demands it (per Anthropic's engineering post, multi-agent systems "use about 15× more tokens than chats"); context compaction + external memory for long conversations; structured outputs via constrained decoding; and Karpathy's "build for agents" principle (machine-readable APIs, `llms.txt`, agent-first navigation).

---

## Details

### §1. Repo Analysis — Parity Table & Audit Method

**Access limitation (must be resolved first):** Automated fetching of both repos failed (`ROBOTS_DISALLOWED` / permission errors) and they are not search-indexed. The following parity table is derived from the stated v3.1 spec. **Deliverable:** run the audit prompt below in Claude Code against the checked-out repo to populate the "Actual" column.

**Feature-by-feature parity (against v3.1 spec + this document's requirements):**

| Capability | v3.1 Spec Intent | Required for v4 | Expected Status |
|---|---|---|---|
| Modular monolith Fastify structure | Yes | Yes | Likely EXISTS |
| Direct Anthropic API (no LangChain) | Yes | Yes | Likely EXISTS |
| Three-layer memory | Yes | Yes (refine) | PARTIAL |
| pgvector embeddings | Yes | Yes | PARTIAL/EXISTS |
| PostgreSQL + Prisma | Yes | Yes | Likely EXISTS |
| Per-tenant Claude prompts | Yes | Yes | PARTIAL |
| Internal tenant gateway (direct DB tool exec) | Yes | Yes | PARTIAL |
| Tenant → Agent → Tool hierarchy (explicit tables) | Implied | **Required** | LIKELY MISSING |
| Agent registry (typed definitions) | Partial | **Required** | LIKELY MISSING |
| Tool registry (schema, scoping, versioning, rate limits) | Partial | **Required** | MISSING |
| Generative UI protocol (Phase 1) | Not in v3.1 | **Required (core)** | MISSING |
| Cost metering (per-conv/agent/tenant) | Not detailed | **Required (core)** | MISSING |
| Invoice generation | No | **Required** | MISSING |
| Structured outputs / tool-use loop | Partial | Yes | PARTIAL |
| Context compaction | Not detailed | Yes | MISSING |
| Guardrails (input/output/tool) | Not detailed | Yes | MISSING |
| BullMQ async agent runtime | Not detailed | Yes | LIKELY MISSING |
| RLS tenant isolation | Not detailed | Recommended | LIKELY MISSING |

**Claude Code audit prompt (run in repo root):**
> "Enumerate the folder structure to 3 levels. For each of: agent definitions, memory layers, DB schema (prisma/schema.prisma), API routes (Fastify), tenant handling, tool implementations, Anthropic API client wrapper, and any cost/token tracking — report the file path, what it does, and whether it is complete/partial/stub. Output a table mapping each capability in the parity table above to exists/partial/missing with file references."

### §2. What to Salvage from `chatagent`

Since the code could not be read, this is a **decision framework** to apply during the audit, plus concrete recommendations by pattern:

**Salvage (re-use with light refactor):**
- **Integration adapters / API clients** to the business systems (Swarg, Eassylife, etc.) — these encode hard-won knowledge of each backend's endpoints and auth. Port them into the new tool registry as tool→internal-API mappings.
- **Session/conversation persistence schema** — table structure for messages, roles, timestamps, and threading is reusable; extend it with tenant_id/agent_id/conversation_id and token columns.
- **Webhook / channel ingestion** (WhatsApp, web widget, etc.) if present — transport is orthogonal to the agent framework.
- **Prompt templates and domain knowledge** encoded in system prompts.

**Rebuild (do not carry forward):**
- **The chat/tool-calling loop itself** if it was built on an older framework or a bespoke orchestration layer. Rebuild around the direct Anthropic tool-use loop (`stop_reason === "tool_use"` → execute → feed `tool_result` back) with native structured outputs and context compaction.
- **Any vendor-SaaS coupling** (managed vector DBs, hosted agent frameworks) — replace with pgvector + internal tooling per the user's preference.
- **Memory implementations** that don't separate working/episodic/semantic layers.

**Rightly abandoned:** monolithic single-agent designs, framework abstractions that obscure prompts/responses (the documented anti-pattern), and any tightly-coupled UI that assumed a traditional frontend.

### §3. Core Architecture Requirements

#### 3.1 Tenant → Agent → Tool/Conversation Hierarchy
Model the two-level business hierarchy explicitly:
- **Level 1 — Tenant:** a business vertical (Swarg, Meraghar, Karmayog, Eassylife, Aedhas, AiroGro, CommunityOS, Amtariksha Tech). Owns config, branding, billing entity, prompt overrides, tool configuration overrides.
- **Level 2 — Agent:** a typed agent within a tenant (support, sales, accounting, navigation, forecast, candidate-eval, etc.). Owns system prompt, model selection, allowed tool set, memory policy, guardrail policy, UI component whitelist.
- **Sub-level — Tool & Conversation:** tools are scoped/configured per tenant and attached to agents; conversations belong to an (agent, end-user) pair and carry all messages, tool calls, token usage.

**Isolation:** shared-database/shared-schema with a `tenant_id` on every row, enforced by **PostgreSQL Row-Level Security** as a defense-in-depth layer beneath application filtering. Use a Prisma client extension that runs `SELECT set_config('app.current_tenant', $tenantId, true)` in a transaction before each operation; use a `BYPASSRLS` admin role for cross-tenant ops (billing rollups). This makes a forgotten `WHERE tenant_id=` a non-breach.

#### 3.2 Agent Registry
Typed, DB-backed agent definitions (not hard-coded). Each agent record: `id, tenant_id, key, name, type (enum), model, system_prompt, memory_policy (json), allowed_tool_ids (array), ui_components (array), guardrail_policy (json), runtime_mode (sync_chat | async_operator | transactional), max_tokens, temperature, is_active, version`. Agents are versioned; prompt changes create a new version for auditability. Follow Anthropic's guidance: start with single-purpose agents, keep prompts inspectable, provide well-typed tools.

#### 3.3 Tool Registry
The heart of the platform. Tool definition schema:
```
Tool {
  id, tenant_id (nullable = global), key, name, description,
  parameters_json_schema,        // JSON Schema for Anthropic tool input
  handler_type,                  // internal_api | db_query | compute | http | composite
  handler_config (json),         // endpoint, method, auth ref, SQL template, etc.
  permission_scope,              // read | write | admin
  rate_limit (json),             // per-minute/hour caps
  requires_confirmation (bool),  // human-in-loop gate for writes
  version, is_active
}
```
- **Per-tenant overrides:** a `ToolConfigOverride { tool_id, tenant_id, config_patch (json), enabled }` table lets the same "get_outstanding_invoices" tool point to different internal APIs per tenant.
- **Tool→internal-API mapping:** `handler_config` holds the endpoint + auth reference; the internal tenant gateway executes with direct DB access for zero-latency reads where possible.
- **Versioning:** immutable tool versions; agents pin a version; new versions require re-approval.
- **Anthropic wiring:** each tool's `parameters_json_schema` becomes the Anthropic tool `input_schema`; enable `strict: true` for write tools. Per Anthropic's Structured Outputs docs, strict tool use applies constrained sampling with compiled grammar artifacts so tool inputs strictly follow your `input_schema` (guaranteed field types and required fields), eliminating malformed inputs rather than merely reducing them.
- **Guardrails at the tool boundary:** every write tool passes through a pre-execution validator and (if `requires_confirmation`) a UI confirmation component.

#### 3.4 Memory System (three-layer)
- **Working memory:** the live context window. Apply **context compaction** — when nearing the window limit, summarize and reinitialize with the summary (the dominant long-horizon technique in 2026 agent frameworks). Use prompt caching on the stable system-prompt + tool-schema prefix. Per Anthropic's prompt-caching docs, cache writes cost 1.25× standard input (5-minute TTL; 2.0× for the 1-hour TTL), and every read within the TTL costs only 0.10× the standard input price — a 90% discount, breaking even on the second cache hit. Minimum cacheable block is 1,024 tokens (Haiku) / 2,048 tokens (Sonnet, Opus).
- **Episodic memory:** per-conversation history in PostgreSQL (messages, tool calls, outcomes), retrievable by conversation_id.
- **Semantic memory:** pgvector embeddings of durable facts, per-tenant knowledge, and — critically for the accounting agent — learned categorization patterns. Store `embedding vector`, `tenant_id`, `agent_id`, `content`, `metadata`.
- **Guard against memory poisoning:** semantic memory writes from user-supplied content must be sanitized (indirect prompt injection can persist as a "fact" across sessions — a documented risk).

#### 3.5 Generative UI Protocol (PHASE 1 CORE)
This is the "agent as frontend" layer. Design it to mirror the MCP Apps standard so AgentForge is future-interoperable, while running on the user's own transport.

**Protocol design (aligned to SEP-1865 / MCP-UI):**
- **UI resources are pre-declared, addressable components** with a custom URI scheme analogous to `ui://<component>/<instance>`, linked from tool/agent metadata via a nested field like `_meta.ui.resourceUri` (the GA field form; the November 2025 proposal used a flat `ui/resourceUri` string key and MIME type `text/html+mcp`, refined at GA to `text/html;profile=mcp-app`). Separate the **static template** (cacheable, reviewable) from the **dynamic tool-result data**.
- **Component contract:** the LLM emits a structured JSON component descriptor (via a tool call or structured output) — `{ component: "product_card" | "comparison_table" | "chart" | "form" | "decision_aid" | "invoice_summary", props: {...}, intents: [...] }`. A registry of allowed components per agent (`ui_components`) gates what can render.
- **Bidirectional communication (from the standard):** host→guest JSON-RPC notifications (`ui/notifications/tool-input`, `tool-input-partial`, `tool-result`, `host-context-changed`, `size-changed`, `tool-cancelled`, `ui/resource-teardown`); guest→host requests (`tools/call`, `ui/message`, `ui/open-link`, `notifications/message`, size-changed). A messageId correlation scheme handles async request/ack/response, plus a ready → render-data handshake.
- **Intent-bubbling (Shopify's principle):** components never mutate authoritative state directly; they **emit intents** (e.g. `view_details`, `checkout`, `add_to_cart`, `confirm_order_change`, `authorize_visitor`) that the agent interprets and turns into tool calls. This "preserves agent control while enabling rich and interactive user experiences."
- **Web (Next.js):** use the Vercel AI SDK v5 `useChat` + typed **data parts** (`data-*`) and tool-result parts (SSE-based streaming). Tool results render as custom React components (generative UI); `streamText` with `stopWhen: stepCountIs(n)` enables multi-step tool→render loops. Note AI SDK RSC (`streamUI`) is experimental/paused — prefer AI SDK UI (data parts + `message.parts`) for production.
- **Flutter:** use **server-driven UI** — the server emits the same JSON component descriptor; a Flutter widget factory (e.g. a `serve_dynamic_ui`/`json_dynamic_widget`-style recursive parser) maps descriptor nodes to native widgets, with an action registry that maps taps back to intents. This avoids heavy WebViews and reuses one descriptor schema across web and mobile. (For web you may render HTML/React; for Flutter render native — the shared contract is the JSON descriptor, not HTML. This is also where a Remote-DOM channel maps better to native widgets than raw HTML.)
- **Streaming:** stream component descriptors progressively (SSE) so charts/cards/forms appear as data resolves.
- **Security (four layers, from the standard):** sandbox any HTML surfaces; pre-declare/review templates; log all UI→host messages (auditable JSON-RPC); require explicit user consent for UI-initiated write actions. Validate any external URLs server-side (block private IPs/localhost, timeouts, size limits, CSP).

#### 3.6 Cost Metering & Billing (CORE)
**Capture:** wrap every Anthropic call; from `response.usage` record `input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens`, plus `model`, `tenant_id`, `agent_id`, `conversation_id`, `message_id`, `timestamp`.
**Pricing:** a versioned `ModelPricing { model, input_per_mtok, output_per_mtok, cache_write_per_mtok, cache_read_per_mtok, effective_from, effective_to }` table. Cost per call is computed at capture time against the active pricing row and stored (so historical costs are immutable even when prices change).
**Aggregation pipeline (BullMQ jobs):** raw usage → per-conversation rollup → per-agent rollup → per-tenant rollup → per-billing-period. Store rollups in materialized summary tables for fast dashboards.
**Budget alerts:** per-tenant/agent monthly caps; a BullMQ scheduled job checks cumulative spend and fires alerts (and optional hard-stop) at thresholds (e.g. 80%/100%).
**Invoicing:** an `Invoice { tenant_id, period_start, period_end, line_items (json: per-agent cost), subtotal, currency, status }` generator produces a billable invoice per business entity. Because Anthropic bills per token and output is ~5× input, model routing (Haiku for classification/routing, Sonnet default, Opus for hard reasoning) is the main cost lever, alongside prompt caching (90% off cached reads) and the Batch API (50% off) for async operator agents.

### §4. Elaborated Use-Case Specifications

Each spec: agent definition · tools · integrations · memory · UI components · edge cases · guardrails.

**UC1 — Support Agent (generic, per-tenant configurable).**
Definition: `type=support, runtime=sync_chat`, per-tenant system prompt + KB. Tools: `search_kb(query)`, `get_customer(id)`, `get_order_history(customer_id)`, `create_ticket(...)`, `escalate_to_human(reason)`. Integrations: tenant CRM/helpdesk via tool registry. Memory: episodic (this customer's history) + semantic (KB, learned FAQs). UI: answer cards, KB article cards, ticket-status card, escalation confirmation. Edge cases: unknown customer, out-of-scope request, angry customer → escalate. Guardrails: no PII leakage in output, no refunds without `requires_confirmation`, prompt-injection filter on inbound.

**UC2 — Sales Agent.** `type=sales, sync_chat`. Tools: `get_catalog(filters)`, `get_pricing(sku, qty)`, `check_inventory(sku)`, `create_quote(...)`, `book_demo(datetime)`, `create_lead(...)`. UI: product cards, comparison tables, pricing calculator, quote summary, demo-booking form. Memory: lead profile (episodic), product embeddings (semantic). Edge cases: out-of-stock → suggest alternatives; discount requests → gated. Guardrails: no unauthorized discounts (confirmation), factual pricing only (pull from tool, never hallucinate).

**UC3 — Chat + App/Webapp Navigation Agent (agent-as-frontend).** `type=navigation, sync_chat`. This is the flagship. Tools: `search_products/services(query)`, `render_dashboard(view)`, `get_entity_detail(type,id)`, `start_flow(flow_name)`. UI: the full generative-UI catalog — nav menus as cards, product/service grids, charts, comparison tables, inline forms, decision aids. Behaves as a "dynamic router" that reads user intent and renders relevant UI inline. Memory: session state + user preferences. Edge cases: ambiguous intent → clarifying UI; deep-link into a flow. Guardrails: component whitelist per tenant; intents mediated by agent.

**UC4 — Sales Forecast Agent.** `type=forecast, async_operator` (BullMQ). Tools: `get_historical_sales(range)`, `compute_forecast(method, horizon)`, `consolidate_report(...)`. Runs on schedule or on-demand; not a chat-first agent. UI: forecast charts, scenario tables, downloadable report. Memory: semantic (seasonality patterns). Edge cases: sparse data → wider confidence bands, flag low confidence. Guardrails: label all figures as estimates; show method + assumptions (transparency).

**UC5 — Financial Analysis Agent.** `type=financial, async_operator`. Tools: `get_ledger(range)`, `get_pnl()`, `compute_ratios()`, `consolidate_report()`. UI: P&L tables, ratio dashboards, trend charts. Memory: semantic (chart-of-accounts, prior analyses). Edge cases: unreconciled periods → warn. Guardrails: read-only; no advice framed as certainty; source every number.

**UC6 — Meraghar (property/community).** `type=support, sync_chat + transactional`.
- *Outstanding invoices:* `get_outstanding_invoices(resident_id)` → invoice summary cards + pay-now intent.
- *Visitor pre-authorization:* `preauthorize_visitor(resident_id, visitor_name, phone, valid_window)` — a **transactional** write; agent collects required fields via a form component, then `requires_confirmation` before creating the entry. UI: invoice cards, visitor-auth form, confirmation card. Edge cases: resident identity verification before any write; expired auth windows. Guardrails: strong identity check; write-confirmation; rate-limit visitor auths.

**UC7 — Swarg Food (customer-facing).** `type=support+transactional, sync_chat`. Tools: `get_products()`, `place_order(...)`, `modify_order(order_id, changes)`, `pause_delivery(subscription_id, dates)`, `increase_quantity_tomorrow_only(subscription_id, sku, qty)` (one-time subscription modification), `file_complaint(...)`. **Key design:** subscription operations are transactional tools with tight schemas; the "increase quantity only for tomorrow" op is a bounded one-time modifier (validates the date == tomorrow, does not alter the recurring plan). UI: product cards, order summary, subscription-modification form, complaint form, confirmation cards. Memory: episodic (this customer's subscription + order history). Edge cases: cutoff-time enforcement (can't modify after kitchen cutoff), out-of-stock, double-modification. Guardrails: confirm all writes; enforce business rules (cutoff, one-time vs recurring) server-side, never trust the model to enforce them.

**UC8 — Karmayog (task management).** `type=transactional, sync_chat`. Tools: `create_task(title, description, priority, assignee, due_date, labels)`, `create_bug(title, description, priority, assignee, repro_steps, attachments, severity)`. **Key design:** the agent must **elicit all required fields before calling the tool** — use structured output to track which fields are still missing and ask for them conversationally; only call `create_bug` when the schema is satisfied (`strict: true`). UI: dynamic form component (pre-filled as fields are gathered), attachment uploader, created-item card with link. Edge cases: missing repro steps → keep asking; invalid assignee → show picker. Guardrails: validate assignee/labels against real project data via a lookup tool.

**UC9 — Swarg Admin Accounting Agent (bank reconciliation).** ⚠️ **Flagged — see §5.** `type=accounting, async_operator + human-in-loop`. Tools: `fetch_bank_transactions(range)`, `fetch_ledger_entries(range)`, `match_transactions()`, `categorize_transaction(txn, category)`, `save_categorization_rule(pattern, category)`. **Learning loop (concrete design):**
1. Deterministic matcher runs first (exact/fuzzy amount+date+reference).
2. Unmatched/"stray" transactions go to the LLM, which proposes a category **with a confidence score** and cites similar past transactions (few-shot examples pulled from semantic memory).
3. Auto-apply only when confidence ≥ threshold (e.g. 90%); otherwise route to human review.
4. When the human corrects a categorization, **persist the correction as a rule + a labeled example** in a `CategorizationRule` table and as a pgvector example. Next time a similar transaction appears, it is matched by rule (deterministic) or retrieved as a high-similarity few-shot example — so accuracy compounds.
UI: reconciliation worklist, transaction cards with proposed category + confidence, correction form, rule-created toast. Guardrails: never post to ledger without human confirmation initially; keep an audit trail of every auto-categorization and its basis; controller monitors new auto-rules before trusting them.

**UC10 — Marketing Intelligence Agent.** ⚠️ **Flagged — see §5.** `type=marketing, async_operator`. Tools: `get_ad_account_metrics(platform)`, `adjust_campaign_budget(...)`, `get_seo_rankings(keywords)`, `analyze_aeo(query_set)`, `consolidate_marketing_report()`. Runs scheduled + on-demand; long-running; calls external ad/SEO APIs. UI: campaign dashboards, keyword tables, recommendation cards. Guardrails: budget-change writes gated by confirmation + hard caps; rate-limit external APIs.

**UC11 — Aedhas Candidate Evaluation Agent.** `type=evaluation, async_operator`. Tools: `get_candidate(id)`, `get_evaluation_parameters()`, `score_candidate(candidate, rubric)`, `rank_candidates(job_id)`, `consolidate_scorecard()`. **Design:** use the **evaluator-optimizer / rubric pattern** — score against explicit parameters, return per-criterion scores + justification (structured output). UI: scorecards, ranked candidate tables, criterion breakdown charts. Memory: semantic (rubric, past evaluations). Edge cases: incomplete profiles → flag; bias controls. Guardrails: transparency (show rubric + evidence per score); human sign-off on final decisions; fairness/audit logging.

**Expanded use-case catalog (brainstorm across the user's businesses):**
- **Eassylife (home services):** booking agent (service selection → slot → address → confirm), provider-matching agent, service-status/tracking agent, reschedule/cancel agent, quote/estimate agent, upsell agent (recommend complementary services), post-service feedback/complaint agent, recurring-service subscription agent.
- **AiroGro (agritech):** crop advisory agent (inputs: crop, region, season → advice cards), pest/disease diagnosis agent (image input → diagnosis + treatment), input-ordering agent (seeds/fertilizer), yield-forecast agent, mandi/market-price agent, irrigation/weather advisory agent, scheme/subsidy-eligibility agent.
- **CommunityOS (community mgmt):** resident onboarding agent, facility-booking agent (clubhouse, courts), complaint/maintenance-ticket agent, dues/payment agent, notice/announcement agent, poll/voting agent, vendor-management agent, visitor/security agent (shared with Meraghar).
- **Food delivery (Swarg-adjacent):** menu-discovery agent, dietary-preference/meal-plan agent, delivery-tracking agent, feedback agent, loyalty/rewards agent.
- **Hardware/robotics:** device-troubleshooting agent, firmware/OTA-status agent, warranty/RMA agent, spare-parts ordering agent, telemetry/diagnostics-analysis agent (async operator), installation-guide/navigation agent.
- **Cross-cutting (all tenants):** onboarding/KYC agent, analytics/BI "ask-your-data" agent, internal admin ops agent, notification/reminder agent, document-generation agent (invoices, reports), HR/helpdesk agent.

### §5. Flagged Deviations

1. **Swarg Accounting / Bank Reconciliation (UC9)** — *Partial deviation.* Reconciliation is fundamentally a **deterministic matching + learning** problem, not a conversational-LLM problem. Force-fitting it into the synchronous chat agent would be slow, expensive, and error-prone. **Fit it in** as an `async_operator` agent with a **deterministic rules engine first, LLM only for stray transactions, and a human-in-loop learning loop** (as specified in UC9). The LLM's role is narrow (propose category + confidence + evidence); the platform's job is the rule store and audit trail. This belongs in the platform, but as a distinct runtime mode.

2. **Marketing Intelligence (UC10)** — *Partial deviation.* This is a long-running, scheduled, external-API-heavy "operator," not a chat agent. It fits as an `async_operator` class driven by BullMQ, but should **not** share the synchronous chat request path. Writes (budget changes) need hard caps and confirmation. Flagged so it isn't built as a chat agent.

3. **General principle:** anything that is (a) long-running, (b) scheduled/batch, or (c) primarily deterministic computation should be an **async operator agent**, not a sync chat agent. The unified platform accommodates both via the `runtime_mode` field and two harnesses — but conflating them in one synchronous loop is the deviation to avoid.

No use case needs to be rejected outright; all fit under one registry with the three runtime modes.

### §6. Database Schema Requirements (PostgreSQL / Prisma)

Core tables (all tenant-scoped tables carry `tenant_id` + RLS policy):
- `Tenant(id, key, name, billing_entity, config_json, is_active, created_at)`
- `Agent(id, tenant_id, key, name, type, runtime_mode, model, system_prompt, memory_policy_json, guardrail_policy_json, ui_components_json, max_tokens, temperature, version, is_active)`
- `Tool(id, tenant_id?, key, name, description, parameters_json_schema, handler_type, handler_config_json, permission_scope, rate_limit_json, requires_confirmation, version, is_active)`
- `AgentTool(agent_id, tool_id, tool_version)` — join with pinned version
- `ToolConfigOverride(id, tool_id, tenant_id, config_patch_json, enabled)`
- `Conversation(id, tenant_id, agent_id, external_user_id, channel, status, created_at, last_activity_at)`
- `Message(id, conversation_id, role, content_json, created_at)` — content_json holds text + tool_use + tool_result + ui component parts
- `ToolCall(id, message_id, tool_id, input_json, output_json, status, latency_ms, confirmed_by, created_at)`
- `TokenUsage(id, tenant_id, agent_id, conversation_id, message_id, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd, pricing_version, created_at)`
- `ModelPricing(id, model, input_per_mtok, output_per_mtok, cache_write_per_mtok, cache_read_per_mtok, effective_from, effective_to)`
- `UsageRollup(id, tenant_id, agent_id?, period_start, period_end, grain, input_tokens, output_tokens, cost_usd)`
- `Invoice(id, tenant_id, period_start, period_end, line_items_json, subtotal_usd, currency, status, generated_at)`
- `MemoryVector(id, tenant_id, agent_id?, content, embedding vector, metadata_json, created_at)` — pgvector
- `CategorizationRule(id, tenant_id, pattern, category, confidence, created_by, created_at)` — accounting learning loop
- `UiComponent(id, key, name, schema_json, allowed_intents_json, version)` — component registry
- `Budget(id, tenant_id, agent_id?, period, cap_usd, alert_thresholds_json)`
- `AuditLog(id, tenant_id, actor, action, target, detail_json, created_at)`

Indexes: `(tenant_id)` on all scoped tables; `(conversation_id, created_at)` on Message; `(tenant_id, agent_id, created_at)` on TokenUsage; ivfflat/hnsw index on MemoryVector.embedding. Enable RLS + `FORCE ROW LEVEL SECURITY` on tenant-scoped tables; `set_config('app.current_tenant', ...)` per request.

### §7. API Surface Requirements (Fastify)

- `POST /v1/tenants/:tenantId/agents/:agentKey/conversations` — start conversation
- `POST /v1/conversations/:id/messages` — send message; SSE stream of text + tool events + UI component parts back
- `POST /v1/conversations/:id/intents` — client posts a UI-emitted intent (from a rendered component)
- `POST /v1/conversations/:id/confirm` — confirm a gated write (tool confirmation)
- `GET /v1/conversations/:id` — history
- `POST /v1/tenants/:tenantId/agents` / `PATCH` / `GET` — agent registry CRUD (admin)
- `POST /v1/tenants/:tenantId/tools` / `PATCH` / `GET` — tool registry CRUD (admin)
- `POST /v1/internal/tools/:toolId/execute` — internal tenant gateway (direct DB/API exec)
- `GET /v1/tenants/:tenantId/usage?grain=conversation|agent|tenant&period=...` — metering
- `POST /v1/tenants/:tenantId/invoices/generate` / `GET` — billing
- `GET /v1/tenants/:tenantId/budgets` / `PATCH` — budgets & alerts
- `GET /v1/ui/components` / `GET /v1/ui/components/:key` — component registry (served to web/Flutter clients)
- `POST /v1/agents/:agentKey/jobs` — enqueue async operator run (BullMQ)
- `GET /v1/jobs/:id` — async job status/result
- Auth: per-tenant API keys + JWT for end-user sessions; every route resolves and sets `tenant_id` context.

### §8. Recommended SOTA Patterns (with justification)

- **Anthropic's five workflow patterns** — use the simplest that works. *Prompt chaining* for sequential ops (gather → validate → create). *Routing* to pick the right sub-agent/tool set by intent (Haiku classifier). *Parallelization* for independent lookups. *Orchestrator-workers* only for breadth-first tasks (e.g. a complex financial consolidation across sources). *Evaluator-optimizer* for candidate scoring and report quality. Justification: named patterns with distinct cost/debuggability profiles; avoids over-engineering.
- **Direct tool-use loop, no LangChain** — matches user preference; keeps prompts/responses inspectable (Anthropic explicitly warns frameworks obscure these). The Claude Agent SDK is an option for the operator harness (it ships the loop, subagents, sessions, MCP, cost tracking) but is not required; a direct implementation is fully viable.
- **Structured outputs / strict tool use** — per Anthropic's docs, constrained sampling with compiled grammar artifacts guarantees tool inputs strictly follow the `input_schema`, essential for transactional agents (Karmayog, Swarg orders). Use `output_config.format` (JSON outputs) for report/extraction agents and `strict: true` tools for writes.
- **Context compaction + prompt caching** — the dominant long-horizon technique; caching the stable prefix yields a 90% discount on cached reads (0.10× input price within the TTL). Essential for cost control at scale.
- **Orchestrator-worker multi-agent — used sparingly.** Per Anthropic's "How we built our multi-agent research system," a lead Opus 4 agent with Sonnet 4 subagents "outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval," but "multi-agent systems use about 15× more tokens than chats" (agents alone use ~4×; token usage explains ~80% of the eval variance). Justification: reserve for genuine breadth-first tasks; most AgentForge use cases are better as single agents + tools.
- **MCP as optional tool transport** — MCP has become the de-facto standard (200+ servers). AgentForge's tool registry should be MCP-compatible in shape so internal tools can later be exposed/consumed as MCP servers, but the internal gateway (direct DB) stays for zero-latency.
- **MCP Apps / MCP-UI alignment for generative UI** — mirror the `ui://` resource + `_meta.ui.resourceUri` + intent-bubbling model so the platform is interoperable with Claude/ChatGPT/VS Code/Goose hosts later, while rendering natively in your own web/Flutter clients now.
- **Karpathy "build for agents" (Software 3.0)** — the agent-as-frontend vision is squarely in this paradigm (LLM as the new OS, context window as RAM, English as the interface), per Karpathy's "Software in the Era of AI / Software 3.0" talk at the YC AI Startup School (June 2025). Practical takeaways to adopt: machine-readable APIs and `llms.txt`-style docs for every internal system; treat the prompt+context as the program; keep humans in the loop with partial-autonomy UIs (the "autonomy slider"); and design for what Karpathy calls **"jagged intelligence"** — models that "can both perform extremely impressive tasks… while simultaneously struggle with some very dumb problems" (his example: asking which is bigger, 9.11 or 9.9, and getting it wrong) — hence verify model outputs, especially numbers. Also relevant: his observation that text is not humans' preferred format, which motivates the push to visual/spatial generative UI — exactly this platform's thesis.

### §9. Phased Implementation Plan (milestone-gated, for Claude Code)

**Milestone 0 — Audit & Foundations (gate: audit table complete).**
Run the §1 audit prompt against the repo; produce the real parity table. Confirm Fastify modular-monolith skeleton, Prisma + PostgreSQL + pgvector, Redis/BullMQ wired, Anthropic client wrapper with `usage` capture. Set up RLS + tenant context extension.

**Milestone 1 — Core hierarchy + one sync chat agent end-to-end (gate: a Swarg support conversation works with tools + cost logged).**
Implement Tenant/Agent/Tool/Conversation/Message/ToolCall tables + registries. Build the direct Anthropic tool-use loop with structured outputs and context compaction. Wire TokenUsage capture + ModelPricing. Ship UC1 (support) for one tenant.

**Milestone 2 — Generative UI protocol (Phase-1 core) (gate: navigation agent renders cards/charts/forms inline in both Next.js and Flutter).**
Define the component descriptor schema + UiComponent registry + intent endpoint. Implement Next.js (AI SDK v5 data parts) and Flutter (server-driven UI parser) renderers. Ship UC3 (navigation) and the product-card/comparison/chart/form components.

**Milestone 3 — Transactional agents + guardrails (gate: Karmayog task/bug creation and Swarg order ops with confirmation gating).**
Implement `requires_confirmation` flow, form components, field-elicitation via structured output, input/output/tool guardrails. Ship UC7 (Swarg orders/subscriptions), UC8 (Karmayog), UC6 (Meraghar).

**Milestone 4 — Async operator harness (gate: a forecast + a reconciliation run complete as BullMQ jobs).**
Build the async runtime (`runtime_mode=async_operator`), job endpoints, Batch API integration. Ship UC4 (forecast), UC5 (financial), UC11 (candidate eval).

**Milestone 5 — Accounting learning loop (gate: a human correction creates a rule that auto-categorizes the next similar txn).**
Implement deterministic matcher + confidence-gated LLM categorization + CategorizationRule store + pgvector few-shot retrieval + human-review UI. Ship UC9.

**Milestone 6 — Metering, budgets, invoicing (gate: an invoice per tenant with per-agent line items; budget alert fires).**
Aggregation pipeline (rollups), budget alerts, invoice generation, usage dashboards.

**Milestone 7 — Marketing operator + catalog expansion + hardening (gate: prod-readiness review).**
Ship UC10 and selected expanded-catalog agents per business priority. Load-test BullMQ, finalize RLS/security review, observability, and per-tenant onboarding docs.

---

## Recommendations

1. **Resolve the repo audit first (Milestone 0).** Do not build against assumptions — run the §1 Claude Code prompt and populate the real parity table before writing new code. Reconcile the salvage decisions (§2) at the same time.
2. **Treat generative UI and cost metering as Phase-1 non-negotiables** (Milestones 1–2), not later phases — the user explicitly confirmed both as core. Everything else can be added incrementally per business priority.
3. **Adopt three runtime modes now** (sync chat, async operator, transactional) in the Agent schema, even if only sync chat ships first — retrofitting this later is expensive.
4. **Mirror the MCP Apps / MCP-UI contract** for the UI protocol so the platform is interoperable later, but keep your own transport and the direct-DB internal gateway for zero latency.
5. **Keep the accounting and marketing agents out of the synchronous chat path** — build them as async operators from the start.
6. **Standardize on Sonnet as default, Haiku for routing/classification, Opus for hard reasoning**, with prompt caching on the stable prefix and Batch API for operator jobs — this is the primary cost lever.
7. **Benchmarks that would change the plan:** if async operator volume is low, defer Milestone 4's Batch API optimization; if a tenant needs hard data-residency or isolation, escalate that tenant from RLS row-level to schema- or database-level isolation; if orchestrator-worker token cost proves prohibitive on any use case, collapse it to single-agent + tools.

## Caveats
- **Repo contents were not directly readable** (GitHub blocked automated access; repos not indexed). All parity/salvage findings are framework-level and must be reconciled against the actual code via the Milestone-0 audit. This is the single biggest open item.
- **Anthropic pricing and model names move fast.** Figures cited (Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 per MTok as of mid-2026) must be treated as versioned data in `ModelPricing`, not hard-coded. A US-only inference multiplier (~1.1×) and regional endpoint premiums (~10%) may apply.
- **MCP Apps / MCP-UI is an emerging standard.** SEP-1865 reached GA Jan 26 2026 but field names evolved (early `text/html+mcp` / flat `ui/resourceUri` → `text/html;profile=mcp-app` / nested `_meta.ui.resourceUri`) and the `extensions` capability relies on SEP-1724, which is not yet fully in the core protocol. Design to the contract but expect churn.
- **Generative UI in Flutter** relies on server-driven-UI libraries that are community-maintained; validate the chosen library's maturity before committing, or build a minimal in-house recursive widget parser.
- **The learning loop for reconciliation** must retain a human-in-loop gate and full audit trail until accuracy is proven per tenant; auto-categorization confidence thresholds should start conservative (≥90%) and be monitored.