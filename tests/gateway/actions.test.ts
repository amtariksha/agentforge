import { describe, it, expect } from 'vitest';
import { encodeActionId, decodeActionId } from '../../src/gateway/renderers/base.js';
import { normalizeWhatsAppMessage } from '../../src/gateway/normalizer.js';

describe('action id codec', () => {
  it('round-trips intent + payload', () => {
    const id = encodeActionId({ kind: 'postback', label: 'Buy', payload: 'buy:p1', intent: 'buy_product' });
    expect(decodeActionId(id)).toEqual({ intent: 'buy_product', payload: 'buy:p1' });
  });
  it('caps to the given byte budget', () => {
    const id = encodeActionId({ kind: 'postback', label: 'x', payload: 'y'.repeat(200), intent: 'i' }, 64);
    expect(id.length).toBeLessThanOrEqual(64);
  });
  it('decodes a bare token with no separator as payload-only', () => {
    expect(decodeActionId('rawtoken')).toEqual({ payload: 'rawtoken' });
  });
});

describe('WhatsApp interactive reply → metadata.action', () => {
  it('bubbles the decoded intent/payload from the reply id', () => {
    const replyId = encodeActionId({ kind: 'postback', label: 'Yes', payload: 'ok', intent: 'confirm_order' });
    const unified = normalizeWhatsAppMessage(
      {
        from: '15551234567', id: 'wamid.1', timestamp: '1700000000', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: replyId, title: 'Yes' } },
      },
      { profile: { name: 'Asha' }, wa_id: '15551234567' },
      't1',
    );
    expect(unified.content.type).toBe('interactive_reply');
    expect(unified.metadata.action).toEqual({
      intent: 'confirm_order', payload: 'ok', title: 'Yes', source: 'button',
    });
  });

  it('marks list replies with source=list', () => {
    const unified = normalizeWhatsAppMessage(
      {
        from: '1', id: 'wamid.2', timestamp: '1700000000', type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'pick#opt3', title: 'Option 3' } },
      },
      undefined,
      't1',
    );
    expect(unified.metadata.action?.source).toBe('list');
    expect(unified.metadata.action?.payload).toBe('opt3');
  });
});
