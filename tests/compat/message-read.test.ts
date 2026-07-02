import { describe, it, expect } from 'vitest';
import { extractText, normalizeContent, textBlock } from '../../src/ui/content-blocks.js';
import { makeCard } from '../helpers/block-factories.js';

/**
 * Backward-compat gate: the message content read path must handle every shape
 * the write sites have ever produced, so upgrading to the blocks format never
 * silently drops history.
 */
describe('message content read (zero-migration)', () => {
  it('reads a legacy inbound row { text, contentType }', () => {
    expect(extractText({ text: 'hello', contentType: 'text' })).toBe('hello');
  });

  it('reads a legacy agent row { type:"text", text }', () => {
    expect(extractText({ type: 'text', text: 'reply' })).toBe('reply');
  });

  it('reads the new persisted shape { type:"text", text, blocks } as text + block fallbacks', () => {
    const stored = { type: 'text', text: 'here', blocks: [textBlock('here'), makeCard()] };
    // Text block yields its text; the card yields its fallbackText.
    expect(extractText(stored)).toBe('here\nWidget ₹9');
    expect(normalizeContent(stored).blocks).toHaveLength(2);
  });

  it('never yields [media message] for a readable text/blocks row', () => {
    expect(extractText({ text: 'x' })).not.toBe('[media message]');
    expect(extractText({ blocks: [textBlock('y')] })).not.toBe('[media message]');
  });

  it('falls back to [media message] only for genuinely unreadable content', () => {
    expect(extractText({ mediaUrl: 'id123', contentType: 'image' })).toBe('[media message]');
  });
});
