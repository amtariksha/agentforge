import { v4 as uuidv4 } from 'uuid';
import type { UnifiedMessage } from '../shared/types/index.js';

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type: string };
  video?: { id: string; mime_type: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: { formatted_name: string } }>;
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  context?: { message_id: string };
}

interface WhatsAppContact {
  profile: { name: string };
  wa_id: string;
}

export function normalizeWhatsAppMessage(
  msg: WhatsAppMessage,
  contact: WhatsAppContact | undefined,
  tenantId: string,
): UnifiedMessage {
  const unified: UnifiedMessage = {
    id: uuidv4(),
    tenantId,
    channel: 'whatsapp',
    channelMessageId: msg.id,
    sender: {
      platformUserId: msg.from,
      displayName: contact?.profile?.name,
    },
    content: {
      type: 'text',
    },
    metadata: {
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      isReplyTo: msg.context?.message_id,
    },
  };

  switch (msg.type) {
    case 'text':
      unified.content.type = 'text';
      unified.content.text = msg.text?.body;
      break;

    case 'image':
      unified.content.type = 'image';
      unified.content.mediaUrl = msg.image?.id; // Will be resolved to actual URL
      unified.content.mediaMime = msg.image?.mime_type;
      unified.content.text = msg.image?.caption;
      break;

    case 'document':
      unified.content.type = 'document';
      unified.content.mediaUrl = msg.document?.id;
      unified.content.mediaMime = msg.document?.mime_type;
      unified.content.text = msg.document?.caption;
      break;

    case 'audio':
      unified.content.type = 'audio';
      unified.content.mediaUrl = msg.audio?.id;
      unified.content.mediaMime = msg.audio?.mime_type;
      break;

    case 'video':
      unified.content.type = 'video';
      unified.content.mediaUrl = msg.video?.id;
      unified.content.mediaMime = msg.video?.mime_type;
      unified.content.text = msg.video?.caption;
      break;

    case 'location':
      unified.content.type = 'location';
      unified.content.location = {
        lat: msg.location?.latitude ?? 0,
        lng: msg.location?.longitude ?? 0,
      };
      break;

    case 'contacts':
      unified.content.type = 'contact';
      unified.content.text = msg.contacts?.map(c => c.name.formatted_name).join(', ');
      break;

    case 'interactive':
      unified.content.type = 'interactive_reply';
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      if (reply) {
        unified.content.interactiveReply = { id: reply.id, title: reply.title };
        unified.content.text = reply.title;
      }
      break;

    default:
      unified.content.type = 'text';
      unified.content.text = `[Unsupported message type: ${msg.type}]`;
  }

  return unified;
}
