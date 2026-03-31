import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Message } from '../components/message/types';

export interface SearchMatch {
  messageId: string;
  messageIndex: number;
  text: string;
  matchStart: number;
  matchEnd: number;
}

interface UseChatSearchResult {
  query: string;
  setQuery: (q: string) => void;
  matches: SearchMatch[];
  currentMatchIndex: number;
  totalMatches: number;
  activeMessageId: string | null;
  goToNext: () => void;
  goToPrevious: () => void;
  currentMatch: SearchMatch | null;
  clearSearch: () => void;
}

/** Only extract visible user text and assistant text blocks (no tool_use, no thinking) */
function extractTextFromMessage(message: Message): string {
  if (message.type === 'user') {
    return typeof message.content === 'string' ? message.content : '';
  }
  if (message.type === 'assistant') {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(block.text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

export function useChatSearch(messages: Message[]): UseChatSearchResult {
  const [query, setQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const matches = useMemo(() => {
    if (!query.trim()) return [];

    const results: SearchMatch[] = [];
    const lowerQuery = query.toLowerCase();

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const text = extractTextFromMessage(message);
      const lowerText = text.toLowerCase();

      let searchStart = 0;
      while (true) {
        const idx = lowerText.indexOf(lowerQuery, searchStart);
        if (idx === -1) break;
        results.push({
          messageId: message.id,
          messageIndex: i,
          text: text.slice(Math.max(0, idx - 30), idx + query.length + 30),
          matchStart: idx,
          matchEnd: idx + query.length,
        });
        searchStart = idx + 1;
      }
    }

    return results;
  }, [query, messages]);

  // Reset current match index when matches change
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [matches.length]);

  const goToNext = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrevious = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setCurrentMatchIndex(0);
  }, []);

  const currentMatch = matches.length > 0 ? matches[currentMatchIndex] ?? null : null;
  const activeMessageId = currentMatch?.messageId ?? null;

  return {
    query,
    setQuery,
    matches,
    currentMatchIndex,
    totalMatches: matches.length,
    activeMessageId,
    goToNext,
    goToPrevious,
    currentMatch,
    clearSearch,
  };
}
