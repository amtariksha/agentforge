import { describe, it, expect } from 'vitest';
import { renderUiHandler, RENDER_UI_INPUT_SCHEMA, renderUiToolDef } from '../../src/tools/platform/render-ui.js';

const ctx = { tenantId: 't1' };

describe('renderUiHandler', () => {
  it('returns validated blocks as ui on success', async () => {
    const res = await renderUiHandler({ blocks: [{ type: 'text', text: 'hi', fallbackText: 'hi' }] }, ctx);
    expect(res.success).toBe(true);
    expect(res.ui).toHaveLength(1);
    expect(res.data).toMatchObject({ rendered: 1 });
  });

  it('fails softly (no throw) when all blocks are invalid', async () => {
    const res = await renderUiHandler({ blocks: [{ type: 'text', text: 'no-fallback' }] }, ctx);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_UI_BLOCKS');
    expect(res.ui).toBeUndefined();
  });

  it('handles missing/garbage input without throwing', async () => {
    await expect(renderUiHandler({}, ctx)).resolves.toMatchObject({ success: false });
    await expect(renderUiHandler({ blocks: 'nope' }, ctx)).resolves.toMatchObject({ success: false });
  });
});

describe('render_ui tool definition', () => {
  it('exposes the block type enum and requires fallbackText (schema stays in sync with the union)', () => {
    const def = renderUiToolDef();
    expect(def.name).toBe('render_ui');
    const itemSchema = RENDER_UI_INPUT_SCHEMA.properties.blocks.items as unknown as {
      required: readonly string[]; properties: { type: { enum: readonly string[] } };
    };
    expect(itemSchema.required).toContain('fallbackText');
    // Every discriminated-union member type must be listed for the model.
    expect(itemSchema.properties.type.enum).toEqual(expect.arrayContaining([
      'text', 'product_card', 'carousel', 'quick_replies', 'image', 'video', 'webview',
      'chart', 'table', 'comparison', 'invoice_list', 'form', 'confirmation', 'kpi_card', 'timeline',
    ]));
  });
});
