/** Valid ContentBlock factories (every block carries fallbackText) for tests. */
import type { ContentBlock } from '../../src/ui/content-blocks.js';

export function makeCard(over: Partial<Extract<ContentBlock, { type: 'product_card' }>> = {}): ContentBlock {
  return {
    type: 'product_card', productId: 'p1', title: 'Widget',
    price: { amount: 9, currency: 'INR' },
    actions: [{ kind: 'postback', label: 'Buy', payload: 'buy:p1', intent: 'buy_product' }],
    fallbackText: 'Widget ₹9', ...over,
  };
}

export function makeTable(over: Partial<Extract<ContentBlock, { type: 'table' }>> = {}): ContentBlock {
  return {
    type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }],
    fallbackText: 'A: 1', ...over,
  };
}

export function makeConfirmation(over: Partial<Extract<ContentBlock, { type: 'confirmation' }>> = {}): ContentBlock {
  return {
    type: 'confirmation', title: 'Confirm?',
    confirm: { kind: 'postback', label: 'Yes', payload: 'ok', intent: 'confirm' },
    fallbackText: 'Confirm? Yes/No', ...over,
  };
}

export function makeForm(over: Partial<Extract<ContentBlock, { type: 'form' }>> = {}): ContentBlock {
  return {
    type: 'form', submitIntent: 'create_task', submitLabel: 'Create',
    fields: [{ name: 'title', label: 'Title', inputType: 'text', required: true }],
    fallbackText: 'Fill the form', ...over,
  };
}
