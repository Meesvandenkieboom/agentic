/**
 * useChatMessages - Message state management with session-aware caching
 * Extracted from ChatContainer to prevent race conditions and improve maintainability.
 */

import { useState, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import type { Message } from '../components/message/types';

// Monotonic message ID counter - prevents collisions that Date.now() causes
let messageIdCounter = 0;

export function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

const MAX_CACHE_SIZE = 20;

export function useChatMessages() {
  const [messages, setMessages] = useState<Message[]>([]);

  // LRU message cache: sessionId -> { messages, lastAccessed }
  const messageCache = useRef<Map<string, { messages: Message[]; lastAccessed: number }>>(new Map());

  /**
   * Evict oldest cache entries when over capacity
   */
  const evictCache = useCallback(() => {
    const cache = messageCache.current;
    if (cache.size <= MAX_CACHE_SIZE) return;

    // Sort by lastAccessed ascending (oldest first)
    const entries = Array.from(cache.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    // Remove oldest entries until at capacity
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
  }, []);

  /**
   * Explicitly cache messages for a session (call before session switch)
   */
  const cacheMessages = useCallback((sessionId: string, msgs: Message[]) => {
    if (!sessionId || msgs.length === 0) return;
    messageCache.current.set(sessionId, {
      messages: msgs,
      lastAccessed: Date.now(),
    });
    evictCache();
  }, [evictCache]);

  /**
   * Get cached messages for a session (returns undefined if not cached)
   */
  const getCachedMessages = useCallback((sessionId: string): Message[] | undefined => {
    const entry = messageCache.current.get(sessionId);
    if (entry) {
      entry.lastAccessed = Date.now();
      return entry.messages;
    }
    return undefined;
  }, []);

  /**
   * Update cached messages for a background session (used by WS handler)
   */
  const updateCachedMessages = useCallback((sessionId: string, updater: (prev: Message[]) => Message[]) => {
    const entry = messageCache.current.get(sessionId);
    if (!entry) return;
    messageCache.current.set(sessionId, {
      messages: updater(entry.messages),
      lastAccessed: Date.now(),
    });
  }, []);

  /**
   * Update cached messages with flushSync semantics for background sessions
   */
  const updateCachedMessagesSync = useCallback((sessionId: string, updater: (prev: Message[]) => Message[]) => {
    // For background sessions, flushSync is not needed since we're updating a ref
    updateCachedMessages(sessionId, updater);
  }, [updateCachedMessages]);

  /**
   * Clear cache for a session (call when messages are persisted to DB)
   */
  const clearCache = useCallback((sessionId: string) => {
    messageCache.current.delete(sessionId);
  }, []);

  /**
   * Clear messages and optionally cache the outgoing session's messages
   */
  const switchMessages = useCallback((
    outgoingSessionId: string | null,
    incomingSessionId: string,
    currentMessages: Message[],
    incomingOutputTokens: number,
    setLiveTokenCount: (count: number) => void,
  ): Message[] | undefined => {
    // Cache outgoing session's messages
    if (outgoingSessionId && currentMessages.length > 0) {
      cacheMessages(outgoingSessionId, currentMessages);
    }

    // Get cached messages for incoming session
    const cached = getCachedMessages(incomingSessionId);

    // Atomically set session messages + token count using flushSync
    flushSync(() => {
      setMessages(cached || []);
      setLiveTokenCount(incomingOutputTokens);
    });

    return cached;
  }, [cacheMessages, getCachedMessages]);

  /**
   * Merge DB messages with any streaming messages already in state.
   * Deduplicates by message ID to prevent the merge-duplication bug.
   */
  const mergeDbMessages = useCallback((dbMessages: Message[], sessionId: string, currentSessionIdRef: React.RefObject<string | null>) => {
    // Safety: only update if still on the same session
    if (sessionId !== currentSessionIdRef.current) {
      // Session changed during DB fetch - cache instead
      cacheMessages(sessionId, dbMessages);
      return;
    }

    setMessages(prev => {
      if (prev.length === 0) return dbMessages;

      // Deduplicate: streaming messages take priority over DB messages
      const existingIds = new Set(prev.map(m => m.id));
      const newFromDb = dbMessages.filter(m => !existingIds.has(m.id));
      return [...newFromDb, ...prev];
    });
  }, [cacheMessages]);

  /**
   * Apply a message updater to either current state or background cache
   */
  const createMessageUpdater = useCallback((activeSessionId: string | null) => {
    return {
      updateMsgs: (msgSessionId: string | null, isBackground: boolean, updater: (prev: Message[]) => Message[]) => {
        if (!isBackground) {
          setMessages(updater);
        } else if (msgSessionId) {
          updateCachedMessages(msgSessionId, updater);
        }
      },
      updateMsgsSync: (msgSessionId: string | null, isBackground: boolean, updater: (prev: Message[]) => Message[]) => {
        if (!isBackground) {
          flushSync(() => setMessages(updater));
        } else if (msgSessionId) {
          updateCachedMessagesSync(msgSessionId, updater);
        }
      },
    };
  }, [updateCachedMessages, updateCachedMessagesSync]);

  return {
    messages,
    setMessages,
    cacheMessages,
    getCachedMessages,
    clearCache,
    switchMessages,
    mergeDbMessages,
    createMessageUpdater,
  };
}
