/**
 * Channel renderer contracts + action-id codec.
 *
 * Renderers map ContentBlock[] to a channel's native elements, degrading any
 * unsupported block to its mandatory `fallbackText`. Web/Flutter get full
 * fidelity (pass-through); WhatsApp/Telegram get interactive elements where the
 * platform supports them and plain text otherwise.
 *
 * Action ids carry the intent + payload back through a channel's tiny reply-id
 * field (WhatsApp reply id ≤256B, Telegram callback_data ≤64B). M2 encodes
 * small payloads inline (`intent#payload`); oversized payloads should be staged
 * in Redis (`ui:action:<tenantId>:<token>`) — see GENERATIVE-UI-CONTRACT.md.
 */
import type { Action } from '../../ui/content-blocks.js';

/** Encode an action into a channel reply-id token, capped to `max` bytes. */
export function encodeActionId(action: Action, max = 200): string {
  const intent = action.intent ?? 'postback';
  const payload = action.payload ?? action.url ?? '';
  return `${intent}#${payload}`.slice(0, max);
}

/** Decode a channel reply-id token back into intent + payload. */
export function decodeActionId(id: string): { intent?: string; payload: string } {
  const i = id.indexOf('#');
  if (i === -1) return { payload: id };
  return { intent: id.slice(0, i) || undefined, payload: id.slice(i + 1) };
}
