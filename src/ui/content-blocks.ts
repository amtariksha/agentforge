/**
 * Generative-UI wire format (Milestone 2).
 *
 * A message's persisted `content` jsonb becomes { blocks: ContentBlock[] };
 * plain text is just a `text` block, so existing rows need zero migration
 * (see normalizeContent). Every block carries a MANDATORY `fallbackText` — the
 * universal degradation floor for text-only channels and unknown/future block
 * types on native clients.
 *
 * Server-side Zod validation of blocks is the security boundary: URLs are
 * https-only (blocks javascript:/data:/relative), and malformed blocks are
 * dropped, never persisted or sent (validateBlocks). Loosely mirrors MCP-UI /
 * SEP-1865 (component ≈ type, props ≈ block fields, intents ≈ actions).
 */
import { z } from 'zod';

// ── URL security boundary: absolute https only ──────────────────────────────
const SafeUrl = z.string().url().refine(
  (u) => /^https:\/\//i.test(u),
  { message: 'URL must be absolute https' },
);

const Money = z.object({ amount: z.number(), currency: z.string().length(3) });

// ── Actions (intent-bubbling) ───────────────────────────────────────────────
export const ActionSchema = z.object({
  kind: z.enum(['url', 'postback', 'call', 'buy', 'view', 'share']),
  label: z.string().min(1),
  url: SafeUrl.optional(),                    // url/call/share targets
  payload: z.string().max(2048).optional(),   // postback/buy/view payloads
  intent: z.string().min(1).optional(),       // bubbles to the loop as metadata.action.intent
}).refine(
  (a) => (a.kind === 'url' || a.kind === 'call' || a.kind === 'share' ? !!a.url : true),
  { message: 'url/call/share actions require url' },
).refine(
  (a) => (a.kind === 'postback' || a.kind === 'buy' || a.kind === 'view' ? !!a.payload : true),
  { message: 'postback/buy/view actions require payload' },
);
export type Action = z.infer<typeof ActionSchema>;

// Every block shares a mandatory fallback string.
const withFallback = { fallbackText: z.string().min(1) };

// ── Block variants ──────────────────────────────────────────────────────────
export const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
  ...withFallback,
});

export const ProductCardBlock = z.object({
  type: z.literal('product_card'),
  productId: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  price: Money.optional(),
  imageUrl: SafeUrl.optional(),
  description: z.string().optional(),
  actions: z.array(ActionSchema).max(3).default([]),
  ...withFallback,
});

export const CarouselBlock = z.object({
  type: z.literal('carousel'),
  items: z.array(ProductCardBlock).min(1).max(10),
  ...withFallback,
});

export const QuickRepliesBlock = z.object({
  type: z.literal('quick_replies'),
  prompt: z.string().optional(),
  replies: z.array(ActionSchema).min(1).max(13), // WhatsApp list-row cap
  ...withFallback,
});

export const ImageBlock = z.object({
  type: z.literal('image'),
  url: SafeUrl,
  caption: z.string().optional(),
  alt: z.string().optional(),
  ...withFallback,
});

export const VideoBlock = z.object({
  type: z.literal('video'),
  url: SafeUrl,
  caption: z.string().optional(),
  posterUrl: SafeUrl.optional(),
  ...withFallback,
});

export const WebviewBlock = z.object({
  type: z.literal('webview'),
  url: SafeUrl,                 // highest-risk block — https-only + whitelist-gateable
  title: z.string().optional(),
  heightHint: z.number().int().positive().optional(),
  ...withFallback,
});

const ChartPoint = z.object({ x: z.union([z.string(), z.number()]), y: z.number() });
export const ChartBlock = z.object({
  type: z.literal('chart'),
  chartType: z.enum(['line', 'bar', 'pie', 'area']),
  title: z.string().optional(),
  series: z.array(z.object({ name: z.string(), points: z.array(ChartPoint) })).min(1),
  imageUrl: SafeUrl.optional(), // optional pre-rendered fallback image
  ...withFallback,
});

const TableCell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const TableBlock = z.object({
  type: z.literal('table'),
  title: z.string().optional(),
  columns: z.array(z.object({ key: z.string(), label: z.string() })).min(1),
  rows: z.array(z.record(z.string(), TableCell)),
  ...withFallback,
});

export const ComparisonBlock = z.object({
  type: z.literal('comparison'),
  columns: z.array(z.object({ key: z.string(), label: z.string() })).min(2).max(4),
  rows: z.array(z.object({ feature: z.string(), values: z.record(z.string(), TableCell) })),
  ...withFallback,
});

export const InvoiceListBlock = z.object({
  type: z.literal('invoice_list'),
  invoices: z.array(z.object({
    id: z.string(),
    date: z.string(),
    amount: Money,
    status: z.string(),
    actions: z.array(ActionSchema).max(3).optional(),
  })).min(1),
  ...withFallback,
});

export const FormBlock = z.object({
  type: z.literal('form'),
  title: z.string().optional(),
  submitIntent: z.string().min(1),   // bubbles on submit
  submitLabel: z.string().default('Submit'),
  fields: z.array(z.object({
    name: z.string(),
    label: z.string(),
    inputType: z.enum(['text', 'number', 'email', 'tel', 'select', 'date', 'textarea']),
    required: z.boolean().default(false),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  })).min(1),
  ...withFallback,
});

export const ConfirmationBlock = z.object({
  type: z.literal('confirmation'),
  title: z.string(),
  body: z.string().optional(),
  confirm: ActionSchema,             // typically postback/buy
  cancel: ActionSchema.optional(),
  ...withFallback,
});

export const KpiCardBlock = z.object({
  type: z.literal('kpi_card'),
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  trend: z.enum(['up', 'down', 'flat']).optional(),
  deltaPct: z.number().optional(),
  ...withFallback,
});

export const TimelineBlock = z.object({
  type: z.literal('timeline'),
  events: z.array(z.object({
    ts: z.string(),
    title: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
  })).min(1),
  ...withFallback,
});

// ── Union + top-level content ───────────────────────────────────────────────
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlock, ProductCardBlock, CarouselBlock, QuickRepliesBlock,
  ImageBlock, VideoBlock, WebviewBlock, ChartBlock, TableBlock,
  ComparisonBlock, InvoiceListBlock, FormBlock, ConfirmationBlock,
  KpiCardBlock, TimelineBlock,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type ContentBlockType = ContentBlock['type'];

export const MessageContentSchema = z.object({
  blocks: z.array(ContentBlockSchema).min(1),
});
export type MessageContent = z.infer<typeof MessageContentSchema>;

// ── Validation + whitelist ──────────────────────────────────────────────────

/** Validate an untrusted block array; returns valid blocks + errors (drop-on-fail). */
export function validateBlocks(input: unknown): { blocks: ContentBlock[]; errors: string[] } {
  const arr = Array.isArray(input) ? input : [];
  const blocks: ContentBlock[] = [];
  const errors: string[] = [];
  for (const raw of arr) {
    const r = ContentBlockSchema.safeParse(raw);
    if (r.success) blocks.push(r.data);
    else errors.push(r.error.message);
  }
  return { blocks, errors };
}

/** Per-agent whitelist (Path-B guardrail). null/undefined = allow all. */
export function filterAllowedBlocks(
  blocks: ContentBlock[],
  allowed: readonly string[] | null | undefined,
): ContentBlock[] {
  if (!allowed) return blocks;
  const set = new Set(allowed);
  return blocks.filter((b) => set.has(b.type));
}

// ── Backward-compat helpers ─────────────────────────────────────────────────

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text, fallbackText: text.length > 0 ? text : ' ' };
}

/** Wrap any persisted content into { blocks } with NO migration. */
export function normalizeContent(raw: unknown): MessageContent {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.blocks)) {
      const { blocks } = validateBlocks(obj.blocks);
      if (blocks.length > 0) return { blocks };
    }
    if (typeof obj.text === 'string' && obj.text.length > 0) {
      return { blocks: [textBlock(obj.text)] };
    }
  }
  return { blocks: [textBlock('[media message]')] };
}

/** Collapse blocks → single plain string for model history + text-only channels. */
export function extractText(content: unknown): string {
  const { blocks } = normalizeContent(content);
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.fallbackText))
    .filter((s) => s.length > 0)
    .join('\n');
}
