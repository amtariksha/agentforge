/**
 * Channel renderer dispatcher. Web/app deliver via the WebSocket/SSE `ui` frame
 * (handled by the caller's sink), so only WhatsApp and Telegram send here.
 */
import type { TenantConfig } from '../../shared/types/index.js';
import type { ContentBlock } from '../../ui/content-blocks.js';
import { deliverWhatsApp } from './whatsapp.js';
import { deliverTelegram } from './telegram.js';

export { renderWhatsApp } from './whatsapp.js';
export { renderTelegram } from './telegram.js';
export { renderWeb } from './web.js';
export { encodeActionId, decodeActionId } from './base.js';

export interface RenderDeliverContext {
  tenantConfig: TenantConfig;
  to: string;
  botToken?: string;
}

/** Deliver blocks to a side-effecting channel (whatsapp/telegram). */
export async function deliverBlocks(
  channel: 'whatsapp' | 'telegram',
  blocks: ContentBlock[],
  ctx: RenderDeliverContext,
): Promise<void> {
  if (channel === 'whatsapp') {
    await deliverWhatsApp(ctx.tenantConfig, ctx.to, blocks);
  } else if (channel === 'telegram') {
    if (ctx.botToken) await deliverTelegram(ctx.botToken, ctx.to, blocks);
  }
}
