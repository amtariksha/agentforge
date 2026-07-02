/**
 * WhatsApp renderer — maps blocks to native interactive/media messages, and
 * degrades everything else to the block's mandatory `fallbackText`.
 *
 * Split into a PURE mapper (`renderWhatsApp` → send descriptors, unit-testable
 * with no network) and a `deliverWhatsApp` that executes descriptors via the
 * existing sender functions.
 */
import type { TenantConfig } from '../../shared/types/index.js';
import type { Action, ContentBlock } from '../../ui/content-blocks.js';
import {
  sendWhatsAppText, sendWhatsAppInteractiveButtons, sendWhatsAppInteractiveList,
  sendWhatsAppImage, sendWhatsAppVideo,
} from '../whatsapp/sender.js';
import { encodeActionId } from './base.js';

export type WhatsAppSend =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; body: string; buttons: Array<{ id: string; title: string }> }
  | { kind: 'list'; body: string; buttonText: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> }
  | { kind: 'image'; link: string; caption?: string }
  | { kind: 'video'; link: string; caption?: string };

const WA_MAX_BUTTONS = 3;

function actionsToButtons(actions: Action[]): Array<{ id: string; title: string }> {
  return actions
    .filter((a) => a.kind === 'postback' || a.kind === 'buy' || a.kind === 'view')
    .map((a) => ({ id: encodeActionId(a), title: a.label }));
}

export function renderWhatsApp(blocks: ContentBlock[]): WhatsAppSend[] {
  const sends: WhatsAppSend[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.trim()) sends.push({ kind: 'text', text: block.text });
        break;
      case 'image':
        sends.push({ kind: 'image', link: block.url, caption: block.caption ?? block.fallbackText });
        break;
      case 'video':
        sends.push({ kind: 'video', link: block.url, caption: block.caption ?? block.fallbackText });
        break;
      case 'product_card': {
        if (block.imageUrl) sends.push({ kind: 'image', link: block.imageUrl, caption: block.fallbackText });
        const buttons = actionsToButtons(block.actions ?? []);
        if (buttons.length > 0) sends.push({ kind: 'buttons', body: block.title, buttons: buttons.slice(0, WA_MAX_BUTTONS) });
        else if (!block.imageUrl) sends.push({ kind: 'text', text: block.fallbackText });
        break;
      }
      case 'quick_replies': {
        const buttons = block.replies.map((a) => ({ id: encodeActionId(a), title: a.label }));
        const body = block.prompt ?? block.fallbackText;
        if (buttons.length <= WA_MAX_BUTTONS) {
          sends.push({ kind: 'buttons', body, buttons });
        } else {
          sends.push({
            kind: 'list', body, buttonText: 'Choose',
            sections: [{ title: 'Options', rows: buttons.map((b) => ({ id: b.id, title: b.title.slice(0, 24) })) }],
          });
        }
        break;
      }
      case 'confirmation': {
        const buttons = [block.confirm, ...(block.cancel ? [block.cancel] : [])].map((a) => ({ id: encodeActionId(a), title: a.label }));
        sends.push({ kind: 'buttons', body: block.body ?? block.title, buttons });
        break;
      }
      default:
        // table, comparison, invoice_list, chart, kpi_card, timeline, form, webview, carousel → text fallback
        sends.push({ kind: 'text', text: block.fallbackText });
    }
  }
  return sends;
}

export async function deliverWhatsApp(config: TenantConfig, to: string, blocks: ContentBlock[]): Promise<void> {
  for (const send of renderWhatsApp(blocks)) {
    switch (send.kind) {
      case 'text': await sendWhatsAppText(config, { to, text: send.text }); break;
      case 'buttons': await sendWhatsAppInteractiveButtons(config, { to, bodyText: send.body, buttons: send.buttons }); break;
      case 'list': await sendWhatsAppInteractiveList(config, { to, bodyText: send.body, buttonText: send.buttonText, sections: send.sections }); break;
      case 'image': await sendWhatsAppImage(config, { to, link: send.link, caption: send.caption }); break;
      case 'video': await sendWhatsAppVideo(config, { to, link: send.link, caption: send.caption }); break;
    }
  }
}
