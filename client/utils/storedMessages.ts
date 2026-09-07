import type { Message } from '../components/message/types';
import { decodeStoredMessage } from '../../shared/storedMessage';

export interface StoredChatMessage { id: string; type: string; content: string; timestamp: string }

/** The same rendering model for history loads, reconnects, and saved streaming snapshots. */
export function restoreMessage(msg: StoredChatMessage): Message {
  if (msg.type === 'user') {
    const decoded = decodeStoredMessage(msg.content);
    return { id: msg.id, type: 'user', content: decoded.text, attachments: decoded.attachments, timestamp: msg.timestamp };
  }
  let content;
  try { const parsed = JSON.parse(msg.content); content = Array.isArray(parsed) ? parsed : [{ type: 'text', text: msg.content }]; }
  catch { content = [{ type: 'text', text: msg.content }]; }
  return { id: msg.id, type: 'assistant', content, timestamp: msg.timestamp };
}

export function upsertSavedMessage(messages: Message[], saved: StoredChatMessage, clientMessageId?: string): Message[] {
  const message = restoreMessage(saved);
  const index = messages.findIndex(m => m.id === saved.id || (clientMessageId && m.id === clientMessageId));
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}
