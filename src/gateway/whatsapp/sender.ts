import { createChildLogger } from '../../shared/utils/logger.js';
import type { TenantConfig } from '../../shared/types/index.js';

const log = createChildLogger({ module: 'whatsapp-sender' });

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0';

interface SendTextOptions {
  to: string;
  text: string;
  previewUrl?: boolean;
}

interface SendInteractiveButtonOptions {
  to: string;
  bodyText: string;
  buttons: Array<{ id: string; title: string }>;
}

interface SendInteractiveListOptions {
  to: string;
  bodyText: string;
  buttonText: string;
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
}

export async function sendWhatsAppText(
  config: TenantConfig,
  options: SendTextOptions,
): Promise<{ messageId?: string; success: boolean }> {
  const wa = config.channels.whatsapp;
  if (!wa) {
    log.error('WhatsApp not configured for tenant');
    return { success: false };
  }

  const body = {
    messaging_product: 'whatsapp',
    to: options.to,
    type: 'text',
    text: {
      preview_url: options.previewUrl ?? false,
      body: options.text,
    },
  };

  return sendWhatsAppRequest(wa.phoneNumberId, wa.accessToken, body);
}

export async function sendWhatsAppInteractiveButtons(
  config: TenantConfig,
  options: SendInteractiveButtonOptions,
): Promise<{ messageId?: string; success: boolean }> {
  const wa = config.channels.whatsapp;
  if (!wa) return { success: false };

  const body = {
    messaging_product: 'whatsapp',
    to: options.to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: options.bodyText },
      action: {
        buttons: options.buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) }, // WhatsApp 20 char limit
        })),
      },
    },
  };

  return sendWhatsAppRequest(wa.phoneNumberId, wa.accessToken, body);
}

export async function sendWhatsAppInteractiveList(
  config: TenantConfig,
  options: SendInteractiveListOptions,
): Promise<{ messageId?: string; success: boolean }> {
  const wa = config.channels.whatsapp;
  if (!wa) return { success: false };

  const body = {
    messaging_product: 'whatsapp',
    to: options.to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: options.bodyText },
      action: {
        button: options.buttonText.slice(0, 20),
        sections: options.sections,
      },
    },
  };

  return sendWhatsAppRequest(wa.phoneNumberId, wa.accessToken, body);
}

async function sendWhatsAppRequest(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ messageId?: string; success: boolean }> {
  const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      log.error({ status: response.status, body: errorBody }, 'WhatsApp API error');
      return { success: false };
    }

    const data = await response.json() as { messages?: Array<{ id: string }> };
    const messageId = data.messages?.[0]?.id;

    log.info({ messageId, to: (body as Record<string, unknown>).to }, 'WhatsApp message sent');
    return { messageId, success: true };
  } catch (err) {
    log.error({ err }, 'WhatsApp send failed');
    return { success: false };
  }
}
