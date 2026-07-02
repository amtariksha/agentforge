/**
 * `render_ui` — the model-driven generative-UI platform tool (emission path B).
 *
 * Registered globally (unqualified handler key) so any whitelisted agent can
 * call it. It validates the model-supplied blocks and returns them as `ui`;
 * executor.ts re-validates + applies the per-agent block whitelist, and the
 * agent loop attaches them to the assistant message exactly like path A. On
 * invalid input it fails softly (the loop keeps going and the model can fall
 * back to prose / fallbackText) — it never throws.
 *
 * Path A (tools returning { data, ui }) is preferred because it renders from
 * tool truth; render_ui is for model-composed views (comparisons, decision
 * aids) and is gated by the agent's allowed_block_types.
 */
import type { GatewayHandler } from '../tenant-gateway/registry.js';
import type { NormalisedTool } from '../../orchestrator/llm-provider.js';
import { validateBlocks } from '../../ui/content-blocks.js';

export const RENDER_UI_TOOL_NAME = 'render_ui';

export const renderUiHandler: GatewayHandler = async (params) => {
  const { blocks, errors } = validateBlocks((params as { blocks?: unknown }).blocks);
  if (blocks.length === 0) {
    return {
      success: false,
      data: { rendered: 0 },
      error: { code: 'INVALID_UI_BLOCKS', message: errors.join('; ') || 'no valid blocks' },
      durationMs: 0,
    };
  }
  // `data` is the model-visible acknowledgement; `ui` carries the blocks that
  // executor validates + attaches.
  return { success: true, data: { rendered: blocks.length }, ui: blocks, durationMs: 0 };
};

/**
 * Hand-authored JSON Schema for the Anthropic tool input_schema — kept in sync
 * with content-blocks.ts (a snapshot test guards drift). Loose on block-specific
 * props (additionalProperties) because the real contract is the server-side Zod
 * validation; this schema just guides the model to the block shape.
 */
export const RENDER_UI_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['type', 'fallbackText'],
        properties: {
          type: {
            type: 'string',
            enum: [
              'text', 'product_card', 'carousel', 'quick_replies', 'image', 'video',
              'webview', 'chart', 'table', 'comparison', 'invoice_list', 'form',
              'confirmation', 'kpi_card', 'timeline',
            ],
          },
          fallbackText: {
            type: 'string',
            description: 'Plain-text rendering used on channels that cannot show this block. Required.',
          },
        },
      },
    },
  },
  required: ['blocks'],
} as const;

export function renderUiToolDef(): NormalisedTool {
  return {
    name: RENDER_UI_TOOL_NAME,
    description:
      'Render rich UI (cards, tables, charts, forms, confirmations, etc.) inline in the chat. '
      + 'Provide an array of content blocks; every block MUST include a fallbackText string used on '
      + 'text-only channels. Prefer letting data-returning tools supply UI; use render_ui for composed '
      + 'views like comparisons or decision aids.',
    input_schema: RENDER_UI_INPUT_SCHEMA as unknown as Record<string, unknown>,
  };
}
