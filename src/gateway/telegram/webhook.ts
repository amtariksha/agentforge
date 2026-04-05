import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { resolveTenantBySlug } from '../../admin/tenants/routes.js';
import { processMessage } from '../../orchestrator/agent-loop.js';
import { createChildLogger } from '../../shared/utils/logger.js';
import type { UnifiedMessage } from '../../shared/types/index.js';

const log = createChildLogger({ module: 'telegram-webhook' });

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; last_name?: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string };
    audio?: { file_id: string; mime_type?: string };
    video?: { file_id: string; mime_type?: string };
    location?: { latitude: number; longitude: number };
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string };
    message: { message_id: number; chat: { id: number } };
    data: string;
  };
}

export async function telegramWebhookRoutes(app: FastifyInstance) {
  app.post<{ Params: { tenantSlug: string } }>(
    '/webhooks/telegram/:tenantSlug',
    async (request, reply) => {
      reply.status(200).send('OK');

      const tenant = await resolveTenantBySlug(request.params.tenantSlug);
      if (!tenant) {
        log.warn({ tenantSlug: request.params.tenantSlug }, 'Telegram webhook for unknown tenant');
        return;
      }

      const update = request.body as TelegramUpdate;

      if (update.message) {
        const msg = update.message;
        const unified = normalizeTelegramMessage(msg, tenant.id);

        log.info({
          tenantId: tenant.id,
          messageId: unified.id,
          from: unified.sender.platformUserId,
          type: unified.content.type,
        }, 'Processing Telegram message');

        processMessage(unified, tenant.id, tenant.config).catch((err) => {
          log.error({ err, messageId: unified.id }, 'Failed to process Telegram message');
        });
      }

      if (update.callback_query) {
        const cb = update.callback_query;
        const unified: UnifiedMessage = {
          id: uuidv4(),
          tenantId: tenant.id,
          channel: 'telegram',
          channelMessageId: cb.id,
          sender: {
            platformUserId: String(cb.from.id),
            displayName: cb.from.first_name,
          },
          content: {
            type: 'interactive_reply',
            text: cb.data,
            interactiveReply: { id: cb.data, title: cb.data },
          },
          metadata: { timestamp: new Date() },
        };

        // Answer callback query to remove loading indicator
        const botToken = tenant.config.channels.telegram?.botToken;
        if (botToken) {
          fetch(`${TELEGRAM_API_BASE}${botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id }),
          }).catch(() => {});
        }

        processMessage(unified, tenant.id, tenant.config).catch((err) => {
          log.error({ err }, 'Failed to process Telegram callback');
        });
      }
    },
  );
}

function normalizeTelegramMessage(
  msg: NonNullable<TelegramUpdate['message']>,
  tenantId: string,
): UnifiedMessage {
  const displayName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');

  const unified: UnifiedMessage = {
    id: uuidv4(),
    tenantId,
    channel: 'telegram',
    channelMessageId: String(msg.message_id),
    sender: {
      platformUserId: String(msg.from.id),
      displayName,
    },
    content: { type: 'text' },
    metadata: {
      timestamp: new Date(msg.date * 1000),
      isReplyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    },
  };

  if (msg.text) {
    unified.content.type = 'text';
    unified.content.text = msg.text;
  } else if (msg.photo) {
    unified.content.type = 'image';
    unified.content.mediaUrl = msg.photo[msg.photo.length - 1].file_id; // Largest photo
  } else if (msg.document) {
    unified.content.type = 'document';
    unified.content.mediaUrl = msg.document.file_id;
    unified.content.mediaMime = msg.document.mime_type;
  } else if (msg.audio) {
    unified.content.type = 'audio';
    unified.content.mediaUrl = msg.audio.file_id;
  } else if (msg.video) {
    unified.content.type = 'video';
    unified.content.mediaUrl = msg.video.file_id;
  } else if (msg.location) {
    unified.content.type = 'location';
    unified.content.location = { lat: msg.location.latitude, lng: msg.location.longitude };
  }

  return unified;
}

/**
 * Send a text message via Telegram Bot API.
 */
export async function sendTelegramText(
  botToken: string,
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    };
    if (replyMarkup) body['reply_markup'] = replyMarkup;

    const response = await fetch(`${TELEGRAM_API_BASE}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      log.error({ status: response.status, body: err }, 'Telegram API error');
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err }, 'Telegram send failed');
    return false;
  }
}

/**
 * Send inline keyboard buttons via Telegram.
 */
export async function sendTelegramButtons(
  botToken: string,
  chatId: string,
  text: string,
  buttons: Array<{ text: string; callback_data: string }>,
): Promise<boolean> {
  return sendTelegramText(botToken, chatId, text, {
    inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.callback_data }))],
  });
}
