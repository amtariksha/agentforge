import { describe, it, expect } from 'vitest';
import {
  ContentBlockSchema, MessageContentSchema, validateBlocks, filterAllowedBlocks,
  textBlock, normalizeContent, extractText,
} from '../../src/ui/content-blocks.js';

describe('ContentBlock schema', () => {
  it('parses each representative block type', () => {
    const blocks = [
      { type: 'text', text: 'hi', fallbackText: 'hi' },
      { type: 'product_card', productId: 'p1', title: 'Widget', price: { amount: 9, currency: 'INR' }, fallbackText: 'Widget ₹9' },
      { type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }], fallbackText: 'table' },
      { type: 'form', submitIntent: 'create_task', fields: [{ name: 'title', label: 'Title', inputType: 'text' }], fallbackText: 'form' },
      { type: 'confirmation', title: 'Sure?', confirm: { kind: 'postback', label: 'Yes', payload: 'ok' }, fallbackText: 'Confirm?' },
    ];
    for (const b of blocks) {
      expect(ContentBlockSchema.safeParse(b).success).toBe(true);
    }
  });

  it('rejects a block missing the mandatory fallbackText', () => {
    const r = ContentBlockSchema.safeParse({ type: 'text', text: 'hi' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown block type', () => {
    const r = ContentBlockSchema.safeParse({ type: 'hologram', fallbackText: 'x' });
    expect(r.success).toBe(false);
  });

  it('enforces https on URL fields (blocks javascript:/http:/relative)', () => {
    const bad = ['javascript:alert(1)', 'http://insecure.test/x.png', '/relative.png', 'data:image/png;base64,AAAA'];
    for (const url of bad) {
      expect(ContentBlockSchema.safeParse({ type: 'image', url, fallbackText: 'img' }).success).toBe(false);
    }
    expect(ContentBlockSchema.safeParse({ type: 'image', url: 'https://cdn.test/x.png', fallbackText: 'img' }).success).toBe(true);
  });

  it('requires a payload for postback actions and a url for url actions', () => {
    expect(ContentBlockSchema.safeParse({ type: 'confirmation', title: 'x', confirm: { kind: 'postback', label: 'Yes' }, fallbackText: 'f' }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ type: 'confirmation', title: 'x', confirm: { kind: 'url', label: 'Open' }, fallbackText: 'f' }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ type: 'confirmation', title: 'x', confirm: { kind: 'url', label: 'Open', url: 'https://ok.test' }, fallbackText: 'f' }).success).toBe(true);
  });
});

describe('MessageContentSchema', () => {
  it('round-trips a { blocks } envelope', () => {
    const content = { blocks: [textBlock('hello')] };
    expect(MessageContentSchema.safeParse(content).success).toBe(true);
  });
  it('rejects an empty blocks array', () => {
    expect(MessageContentSchema.safeParse({ blocks: [] }).success).toBe(false);
  });
});

describe('validateBlocks', () => {
  it('keeps valid blocks and reports errors for invalid ones', () => {
    const { blocks, errors } = validateBlocks([
      { type: 'text', text: 'ok', fallbackText: 'ok' },
      { type: 'text', text: 'no-fallback' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
  it('returns empty for non-array input', () => {
    expect(validateBlocks('nope').blocks).toEqual([]);
    expect(validateBlocks(undefined).blocks).toEqual([]);
  });
});

describe('filterAllowedBlocks', () => {
  it('drops disallowed block types, allows all when whitelist is null', () => {
    const blocks = [textBlock('a'), { type: 'webview', url: 'https://x.test', fallbackText: 'wv' } as const];
    expect(filterAllowedBlocks(blocks, ['text'])).toHaveLength(1);
    expect(filterAllowedBlocks(blocks, null)).toHaveLength(2);
  });
});

describe('normalizeContent / extractText (backward compat)', () => {
  it('reads a new { blocks } row', () => {
    const c = { blocks: [textBlock('new')] };
    expect(normalizeContent(c).blocks[0]).toMatchObject({ type: 'text', text: 'new' });
    expect(extractText(c)).toBe('new');
  });
  it('reads a legacy { text } row', () => {
    expect(extractText({ text: 'legacy' })).toBe('legacy');
    expect(normalizeContent({ text: 'legacy' }).blocks[0]).toMatchObject({ type: 'text', text: 'legacy' });
  });
  it('reads a legacy { type:"text", text } row', () => {
    expect(extractText({ type: 'text', text: 'old' })).toBe('old');
  });
  it('falls back to a media placeholder for unreadable content', () => {
    expect(extractText({})).toBe('[media message]');
    expect(extractText(null)).toBe('[media message]');
  });
  it('uses fallbackText for non-text blocks when extracting', () => {
    const c = { blocks: [textBlock('answer'), { type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [], fallbackText: 'a table' }] };
    expect(extractText(c)).toBe('answer\na table');
  });
});
