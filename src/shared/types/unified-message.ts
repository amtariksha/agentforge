export interface UnifiedMessage {
  id: string;
  tenantId: string;
  channel: 'whatsapp' | 'telegram' | 'web' | 'app';
  channelMessageId: string;
  sender: {
    platformUserId: string;
    internalUserId?: string;
    displayName?: string;
  };
  content: {
    type: 'text' | 'image' | 'document' | 'audio' | 'video' |
          'location' | 'contact' | 'interactive_reply';
    text?: string;
    mediaUrl?: string;
    mediaMime?: string;
    location?: { lat: number; lng: number };
    interactiveReply?: { id: string; title: string };
  };
  metadata: {
    timestamp: Date;
    isReplyTo?: string;
    languageDetected?: string;
    context?: Record<string, unknown>;
    /**
     * Set when this inbound message is a rendered-UI action (button/list reply,
     * Telegram callback, or web intent). The loop treats it as a structured user
     * turn (intent-bubbling) rather than raw text.
     */
    action?: {
      intent?: string;
      payload: string;
      title?: string;
      source: 'button' | 'list' | 'callback' | 'form' | 'web';
    };
  };
}
