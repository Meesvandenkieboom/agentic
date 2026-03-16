/**
 * useChatSessions - Session lifecycle management
 * Handles session CRUD, loading states, and context usage tracking.
 */

import { useState, useRef, useCallback } from 'react';
import { useSessionAPI, type Session } from './useSessionAPI';
import { toast } from '../utils/toast';
import type { BackgroundProcess } from '../components/process/BackgroundProcessMonitor';
import type { SlashCommand } from './useWebSocket';

export interface ContextUsageData {
  inputTokens: number;
  contextWindow: number;
  contextPercentage: number;
  outputTokens: number;
}

export function useChatSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    return localStorage.getItem('agentic-active-session');
  });
  const [currentSessionMode, setCurrentSessionMode] = useState<'general' | 'coder' | 'intense-research' | 'spark' | 'hive'>('general');
  const [availableCommands, setAvailableCommands] = useState<SlashCommand[]>([]);
  const [contextUsage, setContextUsage] = useState<Map<string, ContextUsageData>>(new Map());
  const [backgroundProcesses, setBackgroundProcesses] = useState<Map<string, BackgroundProcess[]>>(new Map());
  const [isPlanMode, setIsPlanMode] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  // Per-session loading states
  const [loadingSessions, setLoadingSessions] = useState<Set<string>>(new Set());

  // Ref tracking latest currentSessionId for use in async callbacks
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // Submit guard to prevent double-submit
  const isSubmittingRef = useRef(false);

  const sessionAPI = useSessionAPI();

  // Loading state helpers
  const setSessionLoading = useCallback((sessionId: string, loading: boolean) => {
    setLoadingSessions(prev => {
      const next = new Set(prev);
      if (loading) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }, []);

  const isSessionLoading = useCallback((sessionId: string | null): boolean => {
    return sessionId ? loadingSessions.has(sessionId) : false;
  }, [loadingSessions]);

  // Computed loading states
  const isAnySessionLoading = loadingSessions.size > 0;
  const isCurrentSessionLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;

  // Load all sessions from API
  const loadSessions = useCallback(async () => {
    const loadedSessions = await sessionAPI.fetchSessions();
    setSessions(loadedSessions);

    // Initialize context usage from loaded sessions
    const newContextUsage = new Map<string, ContextUsageData>();
    loadedSessions.forEach(session => {
      if (session.context_input_tokens && session.context_window && session.context_percentage !== undefined) {
        newContextUsage.set(session.id, {
          inputTokens: session.context_input_tokens,
          contextWindow: session.context_window,
          contextPercentage: session.context_percentage,
          outputTokens: session.output_tokens || 0,
        });
      }
    });
    setContextUsage(newContextUsage);

    return loadedSessions;
  }, [sessionAPI]);

  // Load slash commands for a session
  const loadSlashCommands = useCallback(async (sessionId: string) => {
    try {
      const commandsRes = await fetch(`/api/sessions/${sessionId}/commands`);
      if (commandsRes.ok) {
        const commandsData = await commandsRes.json();
        setAvailableCommands(commandsData.commands || []);
      }
    } catch (error) {
      console.error('Failed to load slash commands:', error);
    }
  }, []);

  // Delete session with cleanup
  const handleChatDelete = useCallback(async (chatId: string) => {
    const success = await sessionAPI.deleteSession(chatId);
    if (success) {
      if (chatId === currentSessionId) {
        setCurrentSessionId(null);
        setCurrentSessionMode('general');
      }
      // Clean up Maps
      setContextUsage(prev => {
        const next = new Map(prev);
        next.delete(chatId);
        return next;
      });
      setBackgroundProcesses(prev => {
        const next = new Map(prev);
        next.delete(chatId);
        return next;
      });
      await loadSessions();
    }
  }, [sessionAPI, currentSessionId, loadSessions]);

  // Rename session title
  const handleChatRename = useCallback(async (chatId: string, newTitle: string) => {
    const result = await sessionAPI.renameSessionTitle(chatId, newTitle);
    if (result.success) {
      // Update in-place for instant feedback (no full reload needed)
      setSessions(prev => prev.map(s => s.id === chatId ? { ...s, title: newTitle } : s));
    } else {
      toast.error('Error', {
        description: result.error || 'Failed to rename chat'
      });
    }
  }, [sessionAPI]);

  // Persist active session to localStorage
  const persistSessionId = useCallback((sessionId: string | null) => {
    if (sessionId) {
      localStorage.setItem('agentic-active-session', sessionId);
    } else {
      localStorage.removeItem('agentic-active-session');
    }
  }, []);

  return {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSessionIdRef,
    currentSessionMode,
    setCurrentSessionMode,
    availableCommands,
    setAvailableCommands,
    contextUsage,
    setContextUsage,
    backgroundProcesses,
    setBackgroundProcesses,
    isPlanMode,
    setIsPlanMode,
    pendingPlan,
    setPendingPlan,
    loadingSessions,
    setLoadingSessions,
    isSubmittingRef,
    sessionAPI,
    setSessionLoading,
    isSessionLoading,
    isAnySessionLoading,
    isCurrentSessionLoading,
    loadSessions,
    loadSlashCommands,
    handleChatDelete,
    handleChatRename,
    persistSessionId,
  };
}
