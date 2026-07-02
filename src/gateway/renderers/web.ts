/**
 * Web (and Flutter) renderer — full fidelity. The client renders blocks from
 * the same JSON descriptor, so the "renderer" is a validated pass-through; the
 * transport (WebSocket `ui` frame / SSE `ui` event) carries the array.
 */
import { validateBlocks, type ContentBlock } from '../../ui/content-blocks.js';

export function renderWeb(blocks: ContentBlock[]): { blocks: ContentBlock[] } {
  // Defensive re-validation so a malformed path never reaches the client.
  const { blocks: valid } = validateBlocks(blocks);
  return { blocks: valid };
}
