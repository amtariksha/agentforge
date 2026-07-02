# Milestone 2 Plan — Generative UI (per Salvage Register v4.1 §4 + Requirements v4 §3.5)

**Status:** PLAN — awaiting review. No implementation yet.
**Scope (register §6):** the Phase-1 core deliverable. A content-blocks wire format, deterministic + model-driven emission paths, channel renderers with degradation, the web widget upgrade, and the Flutter *contract doc* (no Flutter code). Billing/operator-runtime stay out (later milestones).
**Constraints (CLAUDE.md):** Zod on ALL external inputs (blocks validated server-side — this is the security boundary), Drizzle ORM (raw SQL only in migrations), TS strict / no `any`, every DB query includes tenant_id, structured logs never logging PII, minimal diff. Reuse M1 patterns (vitest suite of 46 tests, `servedBy`/usage wiring).
**Model note:** planned on Fable 5; execute on Opus 4.8 (same split as M1).

---

## 0. Verified ground truth (code-level)

1. **`messages.content` is jsonb** ([messages.ts:10](../../src/shared/schema/messages.ts)) — confirmed **zero-migration**: existing `{ text, contentType, mediaUrl }` / legacy `{ type:'text', text }` rows coexist with new `{ text, blocks:[...] }` rows. New rows keep a top-level `text` for cheap legacy reads + canonical fallback.
2. **Critical read site** ([agent-loop.ts:204-213](../../src/orchestrator/agent-loop.ts)): history→Anthropic mapping does `content.text ?? '[media message]'`. Once assistant turns carry `blocks` without a top-level `text`, this silently drops them. Must route through a normalizer.
3. **Latent web-delivery bug (M2 fixes it):** [websocket.ts:80](../../src/gateway/websocket.ts) calls `await processMessage(...)` then only sends `typing:false`. `processMessage`'s channel switch ([agent-loop.ts:355-370](../../src/orchestrator/agent-loop.ts)) handles **only whatsapp/telegram** — the `web` channel has **no delivery branch**, so the widget receives the greeting + typing indicators but **never the agent's reply**. M2 wires responses back via a `sink` callback (text today, blocks for genUI).
4. **WhatsApp sender already supports interactive** buttons + lists ([sender.ts:53-101](../../src/gateway/whatsapp/sender.ts)) — no media send yet. Telegram has `sendTelegramText` + inline-keyboard helper. Strong renderer foundation.
5. **SSE** ([sse.ts:50-56](../../src/gateway/sse.ts)) JSON-serializes any `StreamEvent` — a new `{ type:'ui', blocks }` variant flows with zero SSE plumbing change.
6. **Web widget** ([widget/agentforge-widget.js](../../widget/agentforge-widget.js)) is a 206-line vanilla IIFE over WebSocket, text-only, XSS-safe (all `document.createElement`, no `innerHTML`). No React, no bundler. Block rendering is added in vanilla JS to preserve zero-build embedding + the no-`innerHTML` safety property.
7. **`ToolExecutionResult`** ([tool-definition.ts:54-62](../../src/shared/types/tool-definition.ts)) has **no `ui` field** yet; `executor.ts:177` spreads the result, so adding `ui` flows through. Tenant tools are DB-backed; `getHandler('', name)` ([registry.ts:27](../../src/tools/tenant-gateway/registry.ts)) resolves an unqualified platform handler — the clean seam for `render_ui`.
8. **No `zod-to-json-schema` dep** (deps: `zod ^3.24.0`). `render_ui`'s Anthropic `input_schema` is **hand-authored** JSON Schema kept in sync with the Zod union — no new dep.
9. Old Python RichCard/renderers source is **not present locally** — work from the register's summary (this plan reconstructs it as Zod).

---

## 1. The wire format (block catalog)

`src/ui/content-blocks.ts` — a Zod **discriminated union on `type`**; **every block carries a mandatory `fallbackText: z.string().min(1)`** (the universal degradation floor). Actions carry an `intent` for intent-bubbling (loosely MCP-UI/SEP-1865: component≈`type`, props≈fields, intents≈actions).

Blocks: `text`, `product_card`, `carousel`, `quick_replies`, `image`, `video`, `webview`, `chart`, `table`, `comparison`, `invoice_list`, `form`, `confirmation`, `kpi_card`, `timeline`.

Action kinds: `url | postback | call | buy | view | share` — `url/call/share` require a `url`; `postback/buy/view` require a `payload`; all may carry `intent`.

**Security by construction:** a `SafeUrl` refinement forces absolute `https://` on every URL field (`image.url`, `video.url/posterUrl`, `product_card.imageUrl`, `webview.url`, `action.url`) — rejects `javascript:`/`data:`/relative at parse time. `webview` is the highest-risk block; https-only and disableable per-agent via the whitelist (§3).

Helpers (exported): `textBlock(text)`, `normalizeContent(raw) → { blocks }` (legacy `{text}` / `{type:'text',text}` / new `{blocks}` / garbage→`[media message]` text block), `extractText(content) → string` (blocks→plain string using `fallbackText` for non-text blocks), `validateBlocks(unknown) → { blocks, errors }` (drop-invalid, keep valid), `filterAllowedBlocks(blocks, allowed)` (per-agent whitelist).

---

## 2. Work packages and landing order

```
A wire format → B emission core (executor + render_ui) → C delivery (loops + stream event + web sink + read-site fix)
  → D renderers + widget → E actions round-trip → F Flutter doc + tests + verify
```

### WP-A — Wire format (foundation; everything imports it)

| Action | File | Change |
|---|---|---|
| CREATE | `src/ui/content-blocks.ts` | The Zod union + `Action` sub-schema + `SafeUrl` + `MessageContentSchema` (`{ blocks: ContentBlock[] }`) + inferred TS types + helpers (§1) |
| CREATE | `tests/ui/content-blocks.test.ts` | Each block parses; missing `fallbackText` rejected; `SafeUrl` rejects `javascript:`/`http:`/relative; `normalizeContent`/`extractText`/`validateBlocks`/`filterAllowedBlocks` |
| MODIFY | `src/shared/types/index.ts` | Re-export block types from `../ui/content-blocks.js` |

### WP-B — Emission core (both paths funnel through one validation seam)

| Action | File | Change |
|---|---|---|
| MODIFY | `src/shared/types/tool-definition.ts` | Add `ui?: unknown` to `ToolExecutionResult` (raw; validated in executor — keeps the type module runtime-import-free) |
| MODIFY | `src/tools/executor.ts` | At the return seam (`:177`): `validateBlocks(result.ui)` → drop invalid + log, **keep `data`**; apply `filterAllowedBlocks(blocks, ctx.allowedBlockTypes)`; return sanitized `ui`. Add `allowedBlockTypes?` to `ToolContext`. `render_ui` resolves via the existing internal/`getHandler('', 'render_ui')` path — no new dispatch branch |
| CREATE | `src/tools/platform/render-ui.ts` | Path-B platform handler `renderUiHandler` (validates blocks; valid → `{ success:true, data:{rendered:n}, ui:blocks }`; invalid → `{ success:false, error:{code:'INVALID_UI_BLOCKS'} }`, never throws) + hand-authored `RENDER_UI_INPUT_SCHEMA` (JSON Schema mirror of the union) |
| MODIFY | `src/tools/tenant-gateway/registry.ts` (or a new `src/tools/platform/index.ts` imported in `initializeGateway`) | `registerHandler('render_ui', renderUiHandler)` — unqualified/global key |
| MODIFY | `src/shared/schema/agents.ts` | Add `allowedBlockTypes: jsonb('allowed_block_types')` to `agentTypes` (NULL = allow all) |
| CREATE | `drizzle/00XX_agent_allowed_block_types.sql` | `ALTER TABLE agent_types ADD COLUMN allowed_block_types jsonb;` (additive; raw SQL only in migration) |
| MODIFY | `src/shared/types/tenant-config.ts` | `AgentTypeConfig.allowedBlockTypes?: string[] \| null` |
| CREATE | `tests/tools/render-ui.test.ts` | Valid → `ui`; invalid → error, no throw; whitelist drops disallowed types |

`render_ui` is offered to the model only for whitelisted agents (append `renderUiToolDef()` to the tool list when the agent opts in); executor re-validates + whitelists defensively. One attachment path serves both A (tools return `ui`) and B (`render_ui` returns `ui`).

### WP-C — Delivery (collect, attach, persist, stream, and fix web response)

| Action | File | Change |
|---|---|---|
| MODIFY | `src/orchestrator/agent-loop.ts` | (1) history read (`:204-213`) → `extractText(row.content)` (fixes the `[media message]` drop). (2) `const uiBlocks: ContentBlock[] = []` before the loop; after each tool result, push validated `result.ui`. (3) store site (`:344-350`): `content:{ type:'text', text: finalText, blocks: [textBlock(finalText), ...uiBlocks] }`. (4) **add `sink?: ResponseSink` param**; the `web` channel calls `sink({type:'ui',blocks})`/`sink({type:'text',text})` instead of a channel send — **this is the web-response fix**; whatsapp/telegram route through the renderer dispatcher (WP-D). (5) postback structured-turn injection (WP-E) |
| MODIFY | `src/orchestrator/agent-stream.ts` | `StreamEvent` union `+ { type:'ui'; blocks: ContentBlock[] }`; collect `result.ui` and `onEvent({type:'ui',blocks})` progressively; store site gets the same `{blocks}` shape |
| MODIFY | `src/gateway/websocket.ts` | Pass a `sink` to `processMessage` that sends `{type:'response',text}` / `{type:'ui',blocks}` WS frames (the widget already has a `response` branch; add a `ui` branch in WP-D) |
| MODIFY | `src/gateway/sse.ts` | No change needed for the event (auto-serializes); optionally accept an inbound `action` field in `StreamBodySchema` for SSE clients (WP-E) |

### WP-D — Channel renderers + sender media + widget

| Action | File | Change |
|---|---|---|
| CREATE | `src/gateway/renderers/base.ts` | `Renderer` interface (`render(blocks, ctx) → RenderedOutput[]`) + `RenderedOutput` type |
| CREATE | `src/gateway/renderers/web.ts` | Pass-through: validated `blocks` as server-driven-UI JSON (web + Flutter consume identical payload) |
| CREATE | `src/gateway/renderers/whatsapp.ts` | Map `quick_replies`/`confirmation`→interactive buttons (≤3, 20-char titles), `carousel`/`invoice_list`/`table`→interactive lists, media blocks→image/video/document sends, **everything else→`extractText` plain text**. Reuses `sendWhatsApp*` |
| CREATE | `src/gateway/renderers/telegram.ts` | Actions→inline keyboards (`callback_data`=short token), media→photo/video/document, tables→Markdown fenced, else→`extractText` |
| CREATE | `src/gateway/renderers/index.ts` | `renderForChannel(channel, blocks, ctx)` dispatcher, called from agent-loop's channel-send |
| MODIFY | `src/gateway/whatsapp/sender.ts` | Add `sendWhatsAppImage/Video/Document` (thin wrappers over `sendWhatsAppRequest`) |
| MODIFY | `src/gateway/telegram/webhook.ts` | Add `sendTelegramPhoto/Video/Document` (mirror `sendTelegramText`) |
| MODIFY | `widget/agentforge-widget.js` | WS `ui` event branch; `renderBlock(block)` dispatcher + one vanilla DOM fn per block (`renderCard/renderTable/renderChart/renderForm/renderQuickReplies/renderConfirmation/...`); unknown type→`fallbackText`; `sendIntent(action)` WS frame; append block CSS; bump version 2.0.0. **Charts: uPlot (~40KB, canvas, no deps) lazy-loaded on first `chart` block, `<img>` fallback if `imageUrl` present.** Keep the no-`innerHTML` posture |
| CREATE | `tests/gateway/renderers.test.ts` | web pass-through; whatsapp button/list/media mapping + text fallback == `fallbackText`; telegram inline-keyboard + fallback; list/button caps enforced |

Dashboard React components (a `<GenerativeMessage>` set) are **deferred** — the vanilla widget is the M2 web surface; the dashboard is a future nicety.

### WP-E — Actions round-trip (intent-bubbling)

| Action | File | Change |
|---|---|---|
| MODIFY | `src/shared/types/unified-message.ts` | Add `metadata.action?: { intent?: string; payload: string; title?: string; source: 'button'\|'list'\|'callback'\|'form' }` |
| MODIFY | `src/gateway/normalizer.ts` | WhatsApp interactive reply id → `metadata.action` (decode small `intent#b64(payload)` inline) |
| MODIFY | `src/gateway/telegram/webhook.ts` | `callback_query.data` token → resolve → `metadata.action` |
| MODIFY | `src/orchestrator/agent-loop.ts` | When `message.metadata.action` present, prepend a structured signal to the user turn (`[user action: <intent> payload=<payload>] <text>`) so the model calls the right tool. Log intent/payload only, never `title` (PII) |
| (payload registry) | Redis | Oversized action payloads (WhatsApp id ≤256B, Telegram `callback_data` ≤64B) stored at `ui:action:<tenantId>:<token>` (ioredis, tenant-scoped, short TTL); token emitted, resolved on inbound. Small payloads inline |
| CREATE | `tests/gateway/actions.test.ts` | WA id token→action; Telegram token→registry→action; WS `action` frame→`metadata.action`; agent-loop injects structured turn |

### WP-F — Flutter contract doc + remaining tests + verification

| Action | File | Change |
|---|---|---|
| CREATE | `docs/GENERATIVE-UI-CONTRACT.md` | The cross-client server-driven-UI contract (Flutter = doc only, register §6): envelope, block catalog with prop tables + suggested Flutter-widget mapping, action/intent protocol + return frame + payload registry, per-channel degradation matrix, `fallbackText` mandatory + unknown-type→fallbackText forward-compat, security (URL checks, webview sandbox, consent for `buy`, audit intents), versioning |
| CREATE/EXTEND | `tests/orchestrator/agent-loop-ui.test.ts`, extend `agent-stream.test.ts` | tool `ui` → assistant message persisted with `content.blocks`; invalid `ui` dropped; web `sink` invoked with `{type:'ui',blocks}`; whatsapp degrades to `fallbackText`; stream emits `ui` event before `done` |
| CREATE | `tests/compat/message-read.test.ts` | Backward-compat gate: legacy `{text}` / `{type:'text',text}` / new `{blocks}` all read correctly into history; no `[media message]` regression |
| CREATE | `tests/helpers/block-factories.ts` | `makeCard/makeTable/makeChart/makeButtons/makeConfirmation/makeForm` (valid blocks w/ `fallbackText`) for reuse |

---

## 3. Security boundary (Requirements §3.5, four layers)

All blocks Zod-validated server-side at three choke points, all through `validateBlocks()`: (a) executor on every tool `ui`, (b) `render_ui` handler, (c) `normalizeContent()` on read. `SafeUrl` https-only on every URL field. Invalid blocks dropped, never persisted; `data` preserved so the model's factual answer survives. Per-agent `allowed_block_types` whitelist (read from the already-tenant-scoped `agentTypes` row — no query bypasses `tenant_id`) gates which blocks an agent may emit; drop `webview` to disable it. Intent frames are opaque + tenant-scoped; every UI→host action is auditable.

---

## 4. Verification commands + milestone gate

```bash
npm run typecheck        # strict; new union types must compile at all read/write sites
npm test                 # existing 46 + new UI/renderer/compat suites green (no network)
npm run build            # renderers + platform tool compile to dist
```

Manual smoke:
1. **Web:** `npm run dev`; embed `widget/agentforge-widget.js` (v2.0.0); an agent whose tool returns `ui:[product_card, table]` → card+table render inline; a `quick_replies`/`confirmation` click sends a WS `action` frame → the agent answers the intent. (Also confirms the web-response fix: text replies now arrive at all.)
2. **SSE:** `curl -N POST /api/v1/chat/:slug/stream` with a `render_ui`-enabled agent → `data:{"type":"ui","blocks":[...]}` frames before `done`.
3. **WhatsApp degradation:** a `table`/`chart` block → phone receives its `fallbackText` as plain text (no crash); a `buttons` block → native interactive buttons; press → normalizer produces `metadata.action`.

**Milestone gate (register §6):** a navigation/commerce agent renders `product_card` + `table` + `form`/`confirmation` **inline on the web widget** (from tool truth, Path A) and **degrades cleanly to plain text on WhatsApp** (via `fallbackText`), with a button postback round-tripping as a structured user turn (`metadata.action`) the loop answers. Flutter delivered as `docs/GENERATIVE-UI-CONTRACT.md` only. New vitest suites + backward-compat read test green; `typecheck`/`build` clean.

---

## 5. Risks & notes

1. **Web-response fix changes behavior:** wiring the `sink` means the widget starts receiving replies it never got before — verify no double-delivery on whatsapp/telegram (sink is web-only; those keep their channel sends). Highest-value side effect of M2.
2. **Widget stays vanilla** (no bundler) to preserve zero-build embedding; block rendering is hand-written DOM. A React dashboard renderer is deferred, not part of the gate.
3. **`render_ui` input_schema is hand-authored** JSON Schema; a `content-blocks.test.ts` snapshot keeps it honest against the Zod union (drift = failing test).
4. **Path A is preferred** (tools return `ui` → renders from tool truth, no hallucinated prices/invoices); Path B (`render_ui`) is for model-composed views (comparisons, decision aids) and is whitelist-gated.
5. **Zero migration for messages**; the only schema change is the additive `agent_types.allowed_block_types` column.
6. **`fallbackText` is mandatory on every block** — this is what makes every channel (and every future/unknown block type on the Flutter client) safe to degrade.
