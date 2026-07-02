/**
 * Telegram renderer — inline keyboards + media, degrading everything else to
 * `fallbackText`. Pure mapper (`renderTelegram`) + `deliverTelegram` executor.
 */
import type { Action, ContentBlock } from '../../ui/content-blocks.js';
import { sendTelegramText, sendTelegramButtons, sendTelegramPhoto, sendTelegramVideo } from '../telegram/webhook.js';
import { encodeActionId } from './base.js';

export type TelegramSend =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: Array<{ text: string; callback_data: string }> }
  | { kind: 'photo'; url: string; caption?: string }
  | { kind: 'video'; url: string; caption?: string };

// Telegram callback_data hard cap is 64 bytes.
function actionButtons(actions: Action[]): Array<{ text: string; callback_data: string }> {
  return actions
    .filter((a) => a.kind === 'postback' || a.kind === 'buy' || a.kind === 'view')
    .map((a) => ({ text: a.label, callback_data: encodeActionId(a, 64) }));
}

export function renderTelegram(blocks: ContentBlock[]): TelegramSend[] {
  const sends: TelegramSend[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.trim()) sends.push({ kind: 'text', text: block.text });
        break;
      case 'image':
        sends.push({ kind: 'photo', url: block.url, caption: block.caption ?? block.fallbackText });
        break;
      case 'video':
        sends.push({ kind: 'video', url: block.url, caption: block.caption ?? block.fallbackText });
        break;
      case 'product_card': {
        const buttons = actionButtons(block.actions ?? []);
        if (block.imageUrl) sends.push({ kind: 'photo', url: block.imageUrl, caption: block.fallbackText });
        if (buttons.length > 0) sends.push({ kind: 'buttons', text: block.title, buttons });
        else if (!block.imageUrl) sends.push({ kind: 'text', text: block.fallbackText });
        break;
      }
      case 'quick_replies':
        sends.push({ kind: 'buttons', text: block.prompt ?? block.fallbackText, buttons: block.replies.map((a) => ({ text: a.label, callback_data: encodeActionId(a, 64) })) });
        break;
      case 'confirmation':
        sends.push({ kind: 'buttons', text: block.body ?? block.title, buttons: [block.confirm, ...(block.cancel ? [block.cancel] : [])].map((a) => ({ text: a.label, callback_data: encodeActionId(a, 64) })) });
        break;
      default:
        sends.push({ kind: 'text', text: block.fallbackText });
    }
  }
  return sends;
}

export async function deliverTelegram(botToken: string, chatId: string, blocks: ContentBlock[]): Promise<void> {
  for (const send of renderTelegram(blocks)) {
    switch (send.kind) {
      case 'text': await sendTelegramText(botToken, chatId, send.text); break;
      case 'buttons': await sendTelegramButtons(botToken, chatId, send.text, send.buttons); break;
      case 'photo': await sendTelegramPhoto(botToken, chatId, send.url, send.caption); break;
      case 'video': await sendTelegramVideo(botToken, chatId, send.url, send.caption); break;
    }
  }
}
