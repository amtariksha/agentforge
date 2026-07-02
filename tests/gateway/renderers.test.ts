import { describe, it, expect } from 'vitest';
import { renderWhatsApp } from '../../src/gateway/renderers/whatsapp.js';
import { renderTelegram } from '../../src/gateway/renderers/telegram.js';
import { renderWeb } from '../../src/gateway/renderers/web.js';
import { decodeActionId } from '../../src/gateway/renderers/base.js';
import { textBlock, type ContentBlock } from '../../src/ui/content-blocks.js';

const card: ContentBlock = {
  type: 'product_card', productId: 'p1', title: 'Widget',
  imageUrl: 'https://cdn.test/w.png', price: { amount: 9, currency: 'INR' },
  actions: [{ kind: 'postback', label: 'Buy', payload: 'buy:p1', intent: 'buy_product' }],
  fallbackText: 'Widget ₹9 — reply BUY',
};
const table: ContentBlock = {
  type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }], fallbackText: 'A: 1',
};
const confirmation: ContentBlock = {
  type: 'confirmation', title: 'Confirm order?',
  confirm: { kind: 'postback', label: 'Yes', payload: 'ok', intent: 'confirm' },
  cancel: { kind: 'postback', label: 'No', payload: 'cancel', intent: 'cancel' },
  fallbackText: 'Confirm order? Yes/No',
};

describe('web renderer', () => {
  it('passes valid blocks through', () => {
    const out = renderWeb([textBlock('hi'), card]);
    expect(out.blocks).toHaveLength(2);
  });
});

describe('whatsapp renderer', () => {
  it('sends a product card as image + interactive buttons carrying the encoded action', () => {
    const sends = renderWhatsApp([card]);
    expect(sends.some((s) => s.kind === 'image' && s.link === 'https://cdn.test/w.png')).toBe(true);
    const buttons = sends.find((s) => s.kind === 'buttons');
    expect(buttons).toBeDefined();
    if (buttons && buttons.kind === 'buttons') {
      expect(decodeActionId(buttons.buttons[0].id)).toEqual({ intent: 'buy_product', payload: 'buy:p1' });
    }
  });

  it('degrades a table to its fallbackText', () => {
    const sends = renderWhatsApp([table]);
    expect(sends).toEqual([{ kind: 'text', text: 'A: 1' }]);
  });

  it('maps confirmation to two reply buttons', () => {
    const sends = renderWhatsApp([confirmation]);
    const b = sends.find((s) => s.kind === 'buttons');
    expect(b && b.kind === 'buttons' && b.buttons.map((x) => x.title)).toEqual(['Yes', 'No']);
  });

  it('uses an interactive list when quick replies exceed the button cap', () => {
    const replies = Array.from({ length: 5 }, (_, i) => ({ kind: 'postback' as const, label: `Opt ${i}`, payload: `o${i}` }));
    const sends = renderWhatsApp([{ type: 'quick_replies', prompt: 'Pick', replies, fallbackText: 'pick one' }]);
    expect(sends[0].kind).toBe('list');
  });
});

describe('telegram renderer', () => {
  it('maps actions to inline keyboard buttons within the 64-byte callback cap', () => {
    const sends = renderTelegram([card]);
    const buttons = sends.find((s) => s.kind === 'buttons');
    expect(buttons).toBeDefined();
    if (buttons && buttons.kind === 'buttons') {
      expect(buttons.buttons[0].callback_data.length).toBeLessThanOrEqual(64);
      expect(decodeActionId(buttons.buttons[0].callback_data)).toEqual({ intent: 'buy_product', payload: 'buy:p1' });
    }
  });

  it('degrades unsupported blocks to fallbackText text', () => {
    expect(renderTelegram([table])).toEqual([{ kind: 'text', text: 'A: 1' }]);
  });
});
