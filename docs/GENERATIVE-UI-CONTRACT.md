# AgentForge Generative-UI Contract (v2.0)

The cross-client, server-driven-UI contract. The JSON block descriptor — **not**
HTML — is the contract: the web widget renders it as DOM, a Flutter client
renders it as native widgets, both from the *same* payload. This document is the
M2 Flutter deliverable (no Flutter code ships in M2); it is enough to build a
native server-driven-UI parser later.

**Source of truth:** [`src/ui/content-blocks.ts`](../src/ui/content-blocks.ts)
(Zod). This doc mirrors it; the Zod schema wins on any discrepancy.

---

## 1. Envelope & transport

A message's persisted `content` is `{ blocks: ContentBlock[] }`. A plain-text
message is a single `text` block, so legacy rows (`{ text }`) need no migration —
readers normalize on the way in.

Delivery:
- **WebSocket** (web widget): the server sends `{ "type": "ui", "blocks": [...] }`
  frames; plain text arrives as `{ "type": "response", "text": "..." }`.
- **SSE** (`POST /api/v1/chat/:tenantSlug/stream`): events are newline-delimited
  `data: {...}` JSON. UI arrives as `data: { "type": "ui", "blocks": [...] }`,
  emitted progressively (a turn may send several `ui` events before `done`).
- **WhatsApp / Telegram**: blocks are *degraded server-side* to native elements
  or `fallbackText`; the client receives channel-native messages, not blocks.

Ordering = array order. Streaming appends: a client accumulates blocks across
events within a turn.

---

## 2. Block catalog

Every block has `type` (the discriminator) and a **mandatory `fallbackText`**
(non-empty) — the plain-text rendering used on text-only channels and by any
client for an unknown/unsupported block type. A parser MUST render `fallbackText`
for any `type` it does not recognize (forward-compat).

| type | key props | suggested Flutter widget |
|---|---|---|
| `text` | `text` | `Text` / Markdown |
| `product_card` | `productId, title, subtitle?, price?{amount,currency}, imageUrl?, description?, actions[]` | `Card` |
| `carousel` | `items: product_card[]` (≤10) | `PageView` / horizontal `ListView` |
| `quick_replies` | `prompt?, replies: Action[]` (≤13) | `Wrap` of `ActionChip` |
| `image` | `url, caption?, alt?` | `Image.network` |
| `video` | `url, caption?, posterUrl?` | `video_player` |
| `webview` | `url, title?, heightHint?` | `webview_flutter` (sandboxed) |
| `chart` | `chartType('line'\|'bar'\|'pie'\|'area'), series[{name,points[{x,y}]}], title?, imageUrl?` | `fl_chart`, or `Image` if `imageUrl` |
| `table` | `columns[{key,label}], rows: Record<key,cell>[]` | `DataTable` |
| `comparison` | `columns[{key,label}] (2–4), rows[{feature,values}]` | `DataTable` |
| `invoice_list` | `invoices[{id,date,amount{amount,currency},status,actions?}]` | `ListView` of tiles |
| `form` | `submitIntent, submitLabel?, fields[{name,label,inputType,required,options?}]` | `Form` |
| `confirmation` | `title, body?, confirm: Action, cancel?: Action` | `AlertDialog` / inline |
| `kpi_card` | `label, value, trend?('up'\|'down'\|'flat'), deltaPct?` | custom card |
| `timeline` | `events[{ts,title,description?,icon?}]` | `Stepper` / `Timeline` |

`inputType` ∈ `text | number | email | tel | select | date | textarea`.
All URL fields are **absolute https** (enforced server-side).

---

## 3. Actions & intent-bubbling

Components never mutate state directly — they emit **intents**; the agent
interprets an intent and decides the tool call (Shopify/MCP-UI principle).

```
Action = {
  kind: 'url' | 'postback' | 'call' | 'buy' | 'view' | 'share',
  label: string,
  url?: string,        // required for url/call/share
  payload?: string,    // required for postback/buy/view
  intent?: string,     // bubbles to the agent as metadata.action.intent
}
```

**Return frame (client → server):**
- **Web (WS):** `{ "type": "action", "intent": "...", "payload": "...", "label": "..." }`.
  `url`/`call` actions are handled client-side (open link / dialer), not sent.
- **WhatsApp/Telegram:** the rendered reply-id / `callback_data` encodes the
  action as `intent#payload`; the server decodes it back into `metadata.action`.

`callback_data` (Telegram) is capped at 64 bytes and WhatsApp reply ids at 256;
oversized payloads should be staged in Redis under `ui:action:<tenantId>:<token>`
and the token emitted instead (see `src/gateway/renderers/base.ts`
`encodeActionId`/`decodeActionId`). The agent receives the action as a structured
user turn (`[user action: intent=<intent> payload=<payload>] <label>`), so it
calls the right tool rather than parsing the button label.

Loose MCP-UI / SEP-1865 correspondence: `component` ≈ `type`, `props` ≈ block
fields, `intents` ≈ `actions`.

---

## 4. Degradation matrix

`fallbackText` is the universal floor. Per channel:

| block | Web / Flutter | WhatsApp | Telegram |
|---|---|---|---|
| text | native | text | text |
| product_card | card | image + reply buttons (≤3) | photo + inline keyboard |
| quick_replies | chips | buttons (≤3) or list | inline keyboard |
| confirmation | buttons | 2 reply buttons | inline keyboard |
| image / video | native | media message | photo / video |
| table, comparison, invoice_list, chart, kpi_card, timeline, form, webview, carousel | native | **fallbackText** | **fallbackText** (tables may use Markdown) |

A client that cannot render a block renders its `fallbackText`.

---

## 5. Security (four layers)

1. **Validated server-side** — every block passes Zod (`validateBlocks`) before it
   is persisted or sent; malformed blocks are dropped (the tool's `data` is
   preserved), never surfaced.
2. **URL safety** — all URL fields are absolute `https` (blocks `javascript:`,
   `data:`, relative). `webview` is the highest-risk block: https-only and
   disableable per agent (drop `webview` from `allowed_block_types`).
3. **Per-agent whitelist** — `agent_types.allowed_block_types` (jsonb, NULL =
   allow all) gates which block types an agent may emit; `render_ui` (model-driven
   UI) is offered only to agents with a non-empty whitelist.
4. **Auditable intents** — every action frame is opaque and tenant-scoped; a
   client MUST require explicit user consent for `buy`/write intents and MUST NOT
   execute any code from a descriptor.

---

## 6. Emission paths (server internals, for context)

- **Path A (preferred):** a tool returns `{ data, ui: ContentBlock[] }`; UI
  renders from *tool truth* (no hallucinated prices/invoices).
- **Path B:** the model calls the `render_ui(blocks)` platform tool for composed
  views (comparisons, decision aids); gated by the whitelist.

Both funnel through the same validation seam in `src/tools/executor.ts` and
attach to the assistant message identically.

---

## 7. Versioning

`contractVersion: "2.0"`. Block additions are additive; a client treats an
unknown `type` as `fallbackText`. Prop additions are additive and optional.
Breaking changes bump the major version.
