import type { ChatSearchFilter, ChatSearchResponse, ChatSearchResult } from '../../shared/chatSearch';
import { decodeStoredMessage } from '../../shared/storedMessage';

interface SearchSession {
  id: string;
  title: string;
  updated_at: string;
}

/** Encoded attachment data and tool payloads are never searchable prose. */
export function searchableMessageText(content: string): string {
  return decodeStoredMessage(content, false).text;
}

function previewFor(text: string, query: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const match = query ? compact.toLowerCase().indexOf(query) : 0;
  const start = Math.max(0, match - 60);
  const end = start + Math.max(220, query.length + 60);
  return `${start ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

/** Read effective history so shared branches retain searchable attachments too. */
export function searchSessions(
  sessions: SearchSession[],
  getMessages: (id: string) => { id?: string; content: string }[],
  rawQuery: string,
  offset = 0,
  limit = 50,
  filter: ChatSearchFilter = 'chats',
): ChatSearchResponse {
  const query = rawQuery.trim().replace(/\s+/g, ' ').toLowerCase();
  const results: ChatSearchResult[] = [];
  let skipped = 0;

  for (const session of sessions) {
    if (!query && filter === 'chats' && skipped < offset) { skipped++; continue; }
    const messages = getMessages(session.id);
    let latestText = '';
    let matchedText = '';
    let matchedMessageId: string | undefined;
    let matchedFileName = '';
    const files: ChatSearchResult[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const decoded = decodeStoredMessage(message.content, false);
      const text = decoded.text.replace(/\s+/g, ' ').trim();
      if (!latestText && text) latestText = text;
      if (!matchedText && text && (!query || text.toLowerCase().includes(query))) {
        matchedText = text;
        matchedMessageId = message.id;
      }
      for (const attachment of decoded.attachments) {
        if (query && !attachment.name.toLowerCase().includes(query)) continue;
        if (!matchedFileName) {
          matchedFileName = attachment.name;
          if (!matchedMessageId) matchedMessageId = message.id;
        }
        const kind = attachment.type.startsWith('image/') ? 'image' : 'file';
        if (filter === 'chats' || (filter === 'images' && kind !== 'image') || (filter === 'files' && kind !== 'file')) continue;
        files.push({
          id: `${session.id}:${message.id || i}:${attachment.id}`,
          sessionId: session.id,
          messageId: message.id,
          kind,
          title: attachment.name,
          preview: session.title,
          updatedAt: session.updated_at,
        });
      }
    }
    const candidates: ChatSearchResult[] = [];
    if ((filter === 'all' || filter === 'chats') &&
      (!query || session.title.toLowerCase().includes(query) || matchedText || matchedFileName)) {
      candidates.push({
        id: session.id,
        sessionId: session.id,
        messageId: query ? matchedMessageId : undefined,
        kind: 'chat',
        title: session.title,
        updatedAt: session.updated_at,
        preview: previewFor(matchedText || (matchedFileName ? `Attached: ${matchedFileName}` : latestText), query),
      });
    }
    candidates.push(...files);
    for (const candidate of candidates) {
      if (skipped < offset) { skipped++; continue; }
      if (results.length === limit) return { results, hasMore: true };
      results.push(candidate);
    }
  }
  return { results, hasMore: false };
}
