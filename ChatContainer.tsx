/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import React, { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { NewChatWelcome } from './NewChatWelcome';
import { Sidebar } from '../sidebar/Sidebar';
import { ModelSelector } from '../header/ModelSelector';
import { WorkingDirectoryDisplay } from '../header/WorkingDirectoryDisplay';
import { GitHubRepoIndicator } from '../header/GitHubRepoIndicator';
import { AboutButton } from '../header/AboutButton';
import { NotificationToggle } from '../header/NotificationToggle';
import { areNotificationsEnabled } from '../../utils/notifications';
import { PlanApprovalModal } from '../plan/PlanApprovalModal';
import { BuildWizard } from '../build-wizard/BuildWizard';
import { ScrollButton } from './ScrollButton';
import { BranchDialog } from './BranchDialog';
import { BranchIndicator } from './BranchIndicator';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSessionAPI, type Session } from '../../hooks/useSessionAPI';
import { useBranching } from '../../hooks/useBranching';
import { Menu, Edit3, GitBranch } from 'lucide-react';
import type { Message } from '../message/types';
import { toast } from '../../utils/toast';
import { showError } from '../../utils/errorMessages';
import { showClaudeResponseNotification } from '../../utils/notifications';
import type { BackgroundProcess } from '../process/BackgroundProcessMonitor';
import type { SlashCommand } from '../../hooks/useWebSocket';

export function ChatContainer() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [loadingSessions, setLoadingSessions] = useState<Set<string>>(new Set());
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Ref for scroll container in MessageList
  const scrollContainerRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;

  // Session management
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    return localStorage.getItem('agentic-active-session');
  });
  const [_isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [currentSessionMode, setCurrentSessionMode] = useState<'general' | 'coder' | 'intense-research' | 'spark' | 'hive'>('general');

  // Slash commands available for current session
  const [availableCommands, setAvailableCommands] = useState<SlashCommand[]>([]);

  // Live token count during streaming (for loading indicator)
  const [liveTokenCount, setLiveTokenCount] = useState(0);

  // Context usage tracking (per-session)
  const [contextUsage, setContextUsage] = useState<Map<string, {
    inputTokens: number;
    contextWindow: number;
    contextPercentage: number;
    outputTokens: number;
  }>>(new Map());

  // Message cache to preserve streaming state across session switches
  const messageCache = useRef<Map<string, Message[]>>(new Map());

  // Ref tracking the latest currentSessionId for use in async callbacks
  // (avoids stale closures when session changes during async operations)
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // Persist active session ID to localStorage for sleep/wake recovery
  useEffect(() => {
    if (currentSessionId) {
      localStorage.setItem('agentic-active-session', currentSessionId);
    } else {
      localStorage.removeItem('agentic-active-session');
    }
  }, [currentSessionId]);

  // Automatically cache messages as they update during streaming
  // IMPORTANT: Only depend on messages, NOT currentSessionId
  // (otherwise it fires when session changes with old messages)
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      messageCache.current.set(currentSessionId, messages);
    }
  }, [messages]);

  // Save state signal on tab close to improve persistence
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Cache current messages to localStorage as a last resort
      if (currentSessionIdRef.current && messages.length > 0) {
        try {
          const cacheKey = `agentic-msg-cache-${currentSessionIdRef.current}`;
          localStorage.setItem(cacheKey, JSON.stringify(messages));
          console.log(`💾 Saved ${messages.length} messages to localStorage on unload`);
        } catch (e) {
          // localStorage might be full, ignore
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [messages]);

  // Model selection
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return localStorage.getItem('agentic-model') || 'sonnet';
  });

  // Permission mode (simplified to just plan mode on/off)
  const [isPlanMode, setIsPlanMode] = useState<boolean>(false);

  // Plan approval
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  // Background processes (per-session)
  const [backgroundProcesses, setBackgroundProcesses] = useState<Map<string, BackgroundProcess[]>>(new Map());

  // Track active long-running command by bashId for updates
  const activeLongRunningCommandRef = useRef<string | null>(null);

  // Track last assistant message content for notifications
  const lastAssistantContentRef = useRef<string>('');

  // Build wizard state
  const [isBuildWizardOpen, setIsBuildWizardOpen] = useState(false);

  // GitHub repository selected for session
  const [selectedRepo, setSelectedRepo] = useState<{ url: string; name: string } | null>(null);

  // Custom working directory selected before chat starts
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);

  // Branch dialog state
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchingSessionId, setBranchingSessionId] = useState<string | null>(null);

  const sessionAPI = useSessionAPI();
  const { createBranch, getBranches } = useBranching();

  // Per-session loading state helpers
  const isSessionLoading = (sessionId: string | null): boolean => {
    return sessionId ? loadingSessions.has(sessionId) : false;
  };

  const setSessionLoading = (sessionId: string, loading: boolean) => {
    setLoadingSessions(prev => {
      const next = new Set(prev);
      if (loading) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  };

  // Check if ANY session is loading (global loading state for input disabling)
  const isAnySessionLoading = loadingSessions.size > 0;
  const isLoading = isAnySessionLoading;

  // Check if CURRENT session is loading (for typing indicator)
  const isCurrentSessionLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;

  // Save model selection to localStorage
  // Auto-switch to hive mode when HIVE model is selected
  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    localStorage.setItem('agentic-model', modelId);

    // Auto-switch mode for HIVE model
    if (modelId === 'hive') {
      setCurrentSessionMode('hive');
    } else if (currentSessionMode === 'hive') {
      // If switching away from HIVE model while in hive mode, reset to general
      setCurrentSessionMode('general');
    }
  };

  // Load sessions on mount
  useEffect(() => {
    loadSessions();
  }, []);

  // Auto-switch to hive mode if HIVE model is already selected on mount
  useEffect(() => {
    if (selectedModel === 'hive') {
      setCurrentSessionMode('hive');
    }
  }, []);

  const loadSessions = async () => {
    setIsLoadingSessions(true);
    const loadedSessions = await sessionAPI.fetchSessions();
    setSessions(loadedSessions);

    // Initialize context usage from loaded sessions
    const newContextUsage = new Map<string, {
      inputTokens: number;
      contextWindow: number;
      contextPercentage: number;
      outputTokens: number;
    }>();

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
    setIsLoadingSessions(false);

    // Restore persisted active session on initial load (sleep/wake recovery)
    // Note: currentSessionId may already be set from localStorage initializer,
    // but messages are still empty on a fresh page load, so always restore.
    const persistedSessionId = localStorage.getItem('agentic-active-session');
    if (persistedSessionId && loadedSessions.some(s => s.id === persistedSessionId)) {
      handleSessionSelect(persistedSessionId);
    }
  };

  // Handle session switching
  // CRITICAL: All synchronous state (session ID + messages) must be set ATOMICALLY
  // before any async operations, to prevent streaming messages from the new session
  // being appended to the old session's messages during the async gap.
  const handleSessionSelect = async (sessionId: string) => {
    // IMPORTANT: Cache current session's messages BEFORE switching
    if (currentSessionId && messages.length > 0) {
      messageCache.current.set(currentSessionId, messages);
      console.log(`[Session Switch] Cached ${messages.length} messages for outgoing session ${currentSessionId}`);
    }

    // --- ATOMIC BLOCK: Set session ID and messages together, BEFORE any await ---
    const cachedMessages = messageCache.current.get(sessionId);
    const storedUsage = contextUsage.get(sessionId);

    // Use flushSync to ensure React processes both state updates synchronously
    // so there's no render frame where sessionId has changed but messages haven't
    flushSync(() => {
      setCurrentSessionId(sessionId);
      setMessages(cachedMessages || []);
      setLiveTokenCount(storedUsage?.outputTokens || 0);
    });

    console.log(`[Session Switch] Switched to ${sessionId} with ${cachedMessages?.length || 0} cached messages`);
    // --- END ATOMIC BLOCK ---

    // Now do async work (session details, commands, DB fetch)
    // At this point, messages are already correct for the new session,
    // so streaming messages arriving during these awaits will be appended correctly.

    // Load session details to get permission mode and mode
    const fetchedSessions = await sessionAPI.fetchSessions();
    const session = fetchedSessions.find(s => s.id === sessionId);
    if (session) {
      setIsPlanMode(session.permission_mode === 'plan');
      setCurrentSessionMode(session.mode);
      console.log('🎭 Session mode loaded:', session.mode, 'for session:', sessionId);
    }

    // Load slash commands for this session
    try {
      const commandsRes = await fetch(`/api/sessions/${sessionId}/commands`);
      if (commandsRes.ok) {
        const commandsData = await commandsRes.json();
        setAvailableCommands(commandsData.commands || []);
        console.log(`📋 Loaded ${commandsData.commands?.length || 0} slash commands for session`);
      }
    } catch (error) {
      console.error('Failed to load slash commands:', error);
    }

    // If we had cached messages, we're done — they're already in state
    if (cachedMessages) {
      return;
    }

    // Try localStorage cache first (saved on tab close)
    const localCacheKey = `agentic-msg-cache-${sessionId}`;
    const localCache = localStorage.getItem(localCacheKey);
    if (localCache) {
      try {
        const cachedMsgs = JSON.parse(localCache) as Message[];
        if (cachedMsgs.length > 0) {
          console.log(`[Session Switch] Restored ${cachedMsgs.length} messages from localStorage cache`);
          if (sessionId === currentSessionIdRef.current) {
            setMessages(cachedMsgs);
          }
          localStorage.removeItem(localCacheKey); // Clean up after use
          return;
        }
      } catch (e) {
        console.warn('Failed to parse localStorage message cache:', e);
      }
      localStorage.removeItem(localCacheKey); // Clean up invalid cache
    }

    // No cache — load messages from database
    const sessionMessages = await sessionAPI.fetchSessionMessages(sessionId);

    // Convert session messages to Message format
    const convertedMessages: Message[] = sessionMessages.map(msg => {
      if (msg.type === 'user') {
        return {
          id: msg.id,
          type: 'user' as const,
          content: msg.content,
          timestamp: msg.timestamp,
        };
      } else {
        // For assistant messages, try to parse content as JSON
        let content;
        try {
          // Try parsing as JSON (new format with full content blocks)
          const parsed = JSON.parse(msg.content);
          if (Array.isArray(parsed)) {
            content = parsed;
          } else {
            // If not an array, wrap as text block
            content = [{ type: 'text' as const, text: msg.content }];
          }
        } catch {
          // If parse fails, treat as plain text (legacy format)
          content = [{ type: 'text' as const, text: msg.content }];
        }

        return {
          id: msg.id,
          type: 'assistant' as const,
          content,
          timestamp: msg.timestamp,
        };
      }
    });

    // SAFETY: Only set DB messages if we're still on the same session
    // (user might have switched again during the DB fetch)
    // Use ref to get the LATEST session ID, not the stale closure value
    if (sessionId === currentSessionIdRef.current) {
      setMessages(prev => {
        // If streaming has already added messages, merge: DB messages + streaming messages
        // Deduplicate by checking content to prevent first-message duplication
        if (prev.length > 0) {
          const existingContents = new Set(prev.map(m =>
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          ));
          const newDbMessages = convertedMessages.filter(m => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return !existingContents.has(content);
          });
          console.log(`[Session Switch] Merging ${newDbMessages.length} new DB messages with ${prev.length} existing messages (filtered ${convertedMessages.length - newDbMessages.length} duplicates)`);
          return [...newDbMessages, ...prev];
        }
        return convertedMessages;
      });
    } else {
      // Session changed — put DB messages in cache instead
      messageCache.current.set(sessionId, convertedMessages);
      console.log(`[Session Switch] Session changed during DB fetch, cached ${convertedMessages.length} messages for ${sessionId}`);
    }
  };

  // Handle new chat creation
  const handleNewChat = async () => {
    // Don't create session yet - let handleSubmit create it with the user-selected mode
    setCurrentSessionId(null);
    setCurrentSessionMode('general'); // Reset to default for UI
    setMessages([]);
    setInputValue('');
    setSelectedRepo(null);
    setSelectedDirectory(null);
    // Session will be created in handleSubmit when user sends first message
  };

  // Handle chat deletion
  const handleChatDelete = async (chatId: string) => {
    const success = await sessionAPI.deleteSession(chatId);

    if (success) {
      // If deleting current session, clear messages and session
      if (chatId === currentSessionId) {
        setCurrentSessionId(null);
        setCurrentSessionMode('general');
        setMessages([]);
      }
      await loadSessions(); // Reload sessions to reflect deletion
    }
    // Error already shown by sessionAPI
  };

  // Handle chat rename
  const handleChatRename = async (chatId: string, newFolderName: string) => {
    const result = await sessionAPI.renameSession(chatId, newFolderName);

    if (result.success) {
      await loadSessions();
    } else {
      // Show error to user
      toast.error('Error', {
        description: result.error || 'Failed to rename folder'
      });
    }
  };

  // Handle working directory change
  const handleChangeDirectory = async (sessionId: string, newDirectory: string) => {
    const result = await sessionAPI.updateWorkingDirectory(sessionId, newDirectory);

    if (result.success) {
      await loadSessions();

      // Reload slash commands for new directory
      try {
        const commandsRes = await fetch(`/api/sessions/${sessionId}/commands`);
        if (commandsRes.ok) {
          const commandsData = await commandsRes.json();
          setAvailableCommands(commandsData.commands || []);
        }
      } catch (error) {
        console.error('Failed to load commands after directory change:', error);
      }

      toast.success('Directory changed', {
        description: 'Context reset - conversation starts fresh'
      });
    } else {
      toast.error('Error', {
        description: result.error || 'Failed to change working directory'
      });
    }
  };

  // Handle plan mode toggle
  const handleTogglePlanMode = async () => {
    const newPlanMode = !isPlanMode;
    const mode = newPlanMode ? 'plan' : 'bypassPermissions';

    // Always update local state
    setIsPlanMode(newPlanMode);

    // If session exists, update it in the database
    if (currentSessionId) {
      const result = await sessionAPI.updatePermissionMode(currentSessionId, mode);

      // If query is active, send WebSocket message to switch mode mid-stream
      if (result.success && isSessionLoading(currentSessionId)) {
        sendMessage({
          type: 'set_permission_mode',
          sessionId: currentSessionId,
          mode
        });
      }
    }
    // If no session exists yet, the mode will be applied when session is created
  };

  // Handle GitHub repository selection
  const handleRepoSelected = (repoUrl: string, repoName: string) => {
    setSelectedRepo({ url: repoUrl, name: repoName });
    toast.success(`Selected ${repoName}`, {
      description: 'Repository will be cloned when chat starts'
    });
  };

  // Handle pre-chat directory selection
  const handleDirectorySelected = (path: string) => {
    setSelectedDirectory(path);
    toast.success(`Directory selected`, {
      description: path.split('/').filter(Boolean).pop() || path
    });
  };

  // Handle plan approval
  const handleApprovePlan = () => {
    if (!currentSessionId) return;

    // Update database to bypassPermissions mode immediately
    sendMessage({
      type: 'approve_plan',
      sessionId: currentSessionId
    });

    // Close modal
    setPendingPlan(null);

    // Note: Don't send a follow-up message automatically
    // Let the user decide what to do next after approving the plan
    console.log('✅ Plan approved. Mode switched to bypassPermissions.');
  };

  // Handle plan rejection
  const handleRejectPlan = () => {
    setPendingPlan(null);
    if (currentSessionId) setSessionLoading(currentSessionId, false);
  };

  const { isConnected, sendMessage, stopGeneration } = useWebSocket({
    // Use dynamic URL based on current window location (works on any port)
    url: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
    onConnect: async () => {
      // On reconnection after sleep/wake, re-associate with the active session
      const persistedSessionId = localStorage.getItem('agentic-active-session');
      if (persistedSessionId) {
        console.log(`🔄 WebSocket reconnected — re-associating session ${persistedSessionId.substring(0, 8)}`);
        // Clear loading state for any sessions that were "loading" before disconnect
        setLoadingSessions(new Set());
        // IMPORTANT: Load messages from DB FIRST, so history is in state
        // before the server resumes streaming tokens into the WebSocket
        await handleSessionSelect(persistedSessionId);
        // NOW tell the server to re-associate this WebSocket with the session
        // This cancels the grace period timer and resumes streaming
        sendMessage({
          type: 'reconnect',
          sessionId: persistedSessionId,
        });
      }
    },
    onDisconnect: () => {
      console.log('🔌 WebSocket disconnected — will auto-reconnect');
    },
    onMessage: (message) => {
      // --- Multi-session message routing ---
      // Use the ref to get the LATEST session ID (avoids stale closures)
      const activeSessionId = currentSessionIdRef.current;
      // Determine which session this message belongs to
      const msgSessionId = (message.sessionId as string | undefined) || activeSessionId;
      const isBackgroundSession = msgSessionId !== activeSessionId;

      // Helper: apply a message updater to the correct session (state or cache)
      const updateMsgs = (updater: (prev: Message[]) => Message[]) => {
        if (!isBackgroundSession) {
          setMessages(updater);
        } else if (msgSessionId) {
          const cached = messageCache.current.get(msgSessionId) || [];
          messageCache.current.set(msgSessionId, updater(cached));
        }
      };

      // Helper: apply with flushSync for current session, normal for background
      const updateMsgsSync = (updater: (prev: Message[]) => Message[]) => {
        if (!isBackgroundSession) {
          flushSync(() => setMessages(updater));
        } else if (msgSessionId) {
          const cached = messageCache.current.get(msgSessionId) || [];
          messageCache.current.set(msgSessionId, updater(cached));
        }
      };

      // --- Session filter for non-content messages ---
      if (isBackgroundSession) {
        // Allow certain message types through for background session updates
        if (message.type === 'context_usage') {
          const usageMsg = message as {
            type: 'context_usage';
            inputTokens: number;
            outputTokens: number;
            contextWindow: number;
            contextPercentage: number;
            sessionId?: string;
          };

          const targetSessionId = usageMsg.sessionId || activeSessionId;
          if (targetSessionId) {
            setContextUsage(prev => {
              const newMap = new Map(prev);
              newMap.set(targetSessionId, {
                inputTokens: usageMsg.inputTokens,
                contextWindow: usageMsg.contextWindow,
                contextPercentage: usageMsg.contextPercentage,
                outputTokens: usageMsg.outputTokens || prev.get(targetSessionId)?.outputTokens || 0,
              });
              return newMap;
            });
          }
          return;
        }

        // For background result/error: clear loading, clear cache (messages now in DB)
        if (message.type === 'result' && msgSessionId) {
          setSessionLoading(msgSessionId, false);
          messageCache.current.delete(msgSessionId);
          return;
        }
        if (message.type === 'error' && msgSessionId) {
          setSessionLoading(msgSessionId, false);
          // Don't return - let error message be added to cache below
        }

        // Skip non-content messages for background sessions (toasts, UI-only)
        const backgroundContentTypes = [
          'assistant_message', 'thinking_start', 'thinking_delta',
          'tool_use', 'error',
        ];
        if (!backgroundContentTypes.includes(message.type as string)) {
          return; // Skip token_update, timeout_warning, compact, etc. for background
        }

        // Content messages (assistant_message, thinking, tool_use, error)
        // fall through to the handlers below which use updateMsgs/updateMsgsSync
      }

      // Handle incoming WebSocket messages
      if (message.type === 'assistant_message' && 'content' in message) {
        const assistantContent = message.content as string;

        // Track content for desktop notifications (current session only)
        if (!isBackgroundSession) {
          lastAssistantContentRef.current += assistantContent;
        }

        updateMsgs((prev) => {
          const lastMessage = prev[prev.length - 1];

          // Reset notification content on first assistant message (start of new response)
          // Note: liveTokenCount is NOT reset — it accumulates across all responses in the session
          if (!isBackgroundSession && (!lastMessage || lastMessage.type !== 'assistant')) {
            lastAssistantContentRef.current = assistantContent; // Reset on new response
          }

          // If last message is from assistant, append to the last text block
          if (lastMessage && lastMessage.type === 'assistant') {
            const content = Array.isArray(lastMessage.content) ? lastMessage.content : [];
            const lastBlock = content[content.length - 1];

            // If last block is text, append to it for smooth streaming
            if (lastBlock && lastBlock.type === 'text') {
              const updatedContent = [
                ...content.slice(0, -1),
                { type: 'text' as const, text: lastBlock.text + assistantContent }
              ];
              const updatedMessage = {
                ...lastMessage,
                content: updatedContent
              };
              return [...prev.slice(0, -1), updatedMessage];
            } else {
              // Otherwise add new text block
              const updatedMessage = {
                ...lastMessage,
                content: [...content, { type: 'text' as const, text: assistantContent }]
              };
              return [...prev.slice(0, -1), updatedMessage];
            }
          }

          // Otherwise create new assistant message
          return [
            ...prev,
            {
              id: Date.now().toString(),
              type: 'assistant' as const,
              content: [{ type: 'text' as const, text: assistantContent }],
              timestamp: new Date().toISOString(),
            },
          ];
        });
      } else if (message.type === 'thinking_start') {
        console.log('💭 Thinking block started');
        // Create a new thinking block when thinking starts
        updateMsgs((prev) => {
          const lastMessage = prev[prev.length - 1];

          if (lastMessage && lastMessage.type === 'assistant') {
            const content = Array.isArray(lastMessage.content) ? lastMessage.content : [];
            const updatedMessage = {
              ...lastMessage,
              content: [...content, { type: 'thinking' as const, thinking: '' }]
            };
            return [...prev.slice(0, -1), updatedMessage];
          }

          // Create new assistant message with thinking block
          return [
            ...prev,
            {
              id: Date.now().toString(),
              type: 'assistant' as const,
              content: [{ type: 'thinking' as const, thinking: '' }],
              timestamp: new Date().toISOString(),
            },
          ];
        });
      } else if (message.type === 'thinking_delta' && 'content' in message) {
        const thinkingContent = message.content as string;
        console.log('💭 Thinking delta:', thinkingContent.slice(0, 50) + (thinkingContent.length > 50 ? '...' : ''));

        updateMsgs((prev) => {
          const lastMessage = prev[prev.length - 1];

          if (lastMessage && lastMessage.type === 'assistant') {
            const content = Array.isArray(lastMessage.content) ? lastMessage.content : [];
            const lastBlock = content[content.length - 1];

            // If last block is thinking, append to it
            if (lastBlock && lastBlock.type === 'thinking') {
              const updatedContent = [
                ...content.slice(0, -1),
                { type: 'thinking' as const, thinking: lastBlock.thinking + thinkingContent }
              ];
              const updatedMessage = {
                ...lastMessage,
                content: updatedContent
              };
              return [...prev.slice(0, -1), updatedMessage];
            }
          }

          return prev; // No update if not in a thinking block
        });
      } else if (message.type === 'tool_use' && 'toolId' in message && 'toolName' in message && 'toolInput' in message) {
        // Handle tool use messages
        const toolUseMsg = message as { type: 'tool_use'; toolId: string; toolName: string; toolInput: Record<string, unknown> };

        // Use flushSync to prevent React batching from causing tools to be lost
        // When multiple tool_use messages arrive rapidly, React batches setState calls
        // causing all but the last update to be overwritten. flushSync forces synchronous updates.
        updateMsgsSync((prev) => {
          const lastMessage = prev[prev.length - 1];

          const toolUseBlock = {
            type: 'tool_use' as const,
            id: toolUseMsg.toolId,
            name: toolUseMsg.toolName,
            input: toolUseMsg.toolInput,
            // Initialize nestedTools array for Task tools
            ...(toolUseMsg.toolName === 'Task' ? { nestedTools: [] } : {}),
          };

          // If last message is assistant, check for Task tool nesting
          if (lastMessage && lastMessage.type === 'assistant') {
            const content = Array.isArray(lastMessage.content) ? lastMessage.content : [];

            // Check for duplicate tool_use blocks (prevents race condition issues)
            const isDuplicate = content.some(block =>
              block.type === 'tool_use' && block.id === toolUseMsg.toolId
            );

            if (isDuplicate) {
              return prev; // Skip duplicate
            }

            // Find all active Task tools (Tasks without a text block after them)
            const activeTaskIndices: number[] = [];
            let foundTextBlockAfterLastTask = false;

            for (let i = content.length - 1; i >= 0; i--) {
              const block = content[i];
              if (block.type === 'text') {
                foundTextBlockAfterLastTask = true;
              }
              if (block.type === 'tool_use' && block.name === 'Task') {
                if (!foundTextBlockAfterLastTask) {
                  activeTaskIndices.unshift(i); // Add to beginning to maintain order
                } else {
                  break; // Stop looking once we hit a text block context boundary
                }
              }
            }

            // If this is a Task tool OR we found no active Tasks to nest under, add normally
            if (toolUseMsg.toolName === 'Task' || activeTaskIndices.length === 0) {
              const updatedMessage = {
                ...lastMessage,
                content: [...content, toolUseBlock]
              };
              return [...prev.slice(0, -1), updatedMessage];
            }

            // Distribute tools across active Tasks using round-robin
            // Use total nested tool count as a counter for distribution
            const totalNestedTools = activeTaskIndices.reduce((sum, idx) => {
              const block = content[idx];
              return sum + (block.type === 'tool_use' ? (block.nestedTools?.length || 0) : 0);
            }, 0);

            const targetTaskIndex = activeTaskIndices[totalNestedTools % activeTaskIndices.length];

            // Nest this tool under the selected Task
            const updatedContent = content.map((block, index) => {
              if (index === targetTaskIndex && block.type === 'tool_use') {
                // Check for duplicate in nested tools as well
                const isNestedDuplicate = (block.nestedTools || []).some(
                  nested => nested.id === toolUseMsg.toolId
                );

                if (isNestedDuplicate) {
                  return block; // Don't add duplicate
                }

                return {
                  ...block,
                  nestedTools: [...(block.nestedTools || []), toolUseBlock]
                };
              }
              return block;
            });

            const updatedMessage = {
              ...lastMessage,
              content: updatedContent
            };
            return [...prev.slice(0, -1), updatedMessage];
          }

          // Otherwise create new assistant message with tool
          return [
            ...prev,
            {
              id: Date.now().toString(),
              type: 'assistant' as const,
              content: [toolUseBlock],
              timestamp: new Date().toISOString(),
            },
          ];
        });
      } else if (message.type === 'token_update' && 'outputTokens' in message) {
        // Update live token count during streaming
        const tokenUpdate = message as { type: 'token_update'; outputTokens: number };
        setLiveTokenCount(tokenUpdate.outputTokens);
      } else if (message.type === 'result') {
        const resultSessionId = msgSessionId || activeSessionId;
        if (resultSessionId) {
          setSessionLoading(resultSessionId, false);
          // Clear message cache for this session since messages are now saved to DB
          messageCache.current.delete(resultSessionId);
          console.log(`[Message Cache] Cleared cache for session ${resultSessionId} (stream completed)`);
          // Keep liveTokenCount (don't reset to 0) — it will be replaced by
          // the actual output token count from context_usage event

          // Show desktop notification if user is away and notifications are enabled (current session only)
          if (!isBackgroundSession) {
            console.log('[ChatContainer] Response complete, lastAssistantContent length:', lastAssistantContentRef.current.length);
            if (lastAssistantContentRef.current && areNotificationsEnabled()) {
              showClaudeResponseNotification({
                message: lastAssistantContentRef.current,
                title: 'Agentic',
              });
              lastAssistantContentRef.current = ''; // Reset for next response
            } else {
              console.log('[ChatContainer] Skipping notification - content empty or notifications disabled');
              lastAssistantContentRef.current = ''; // Still reset
            }
          }
        }
      } else if (message.type === 'timeout_warning') {
        // Handle timeout warning (60s elapsed)
        const warningMsg = message as { type: 'timeout_warning'; message: string; elapsedSeconds: number };
        toast.warning('Still thinking...', {
          description: warningMsg.message || 'The AI is taking longer than usual',
          duration: 5000,
        });
      } else if (message.type === 'retry_attempt') {
        // Handle retry attempt notification
        const retryMsg = message as { type: 'retry_attempt'; attempt: number; maxAttempts: number; message: string; errorType: string };
        toast.info(`Retrying (${retryMsg.attempt}/${retryMsg.maxAttempts})`, {
          description: retryMsg.message || `Attempting to recover from ${retryMsg.errorType}...`,
          duration: 3000,
        });
      } else if (message.type === 'error') {
        // Handle error messages from server
        const errorSessionId = msgSessionId || activeSessionId;
        if (errorSessionId) setSessionLoading(errorSessionId, false);
        // Don't reset liveTokenCount on error — it's cumulative across the session

        // Get error type and message
        const errorType = 'errorType' in message ? (message.errorType as string) : undefined;
        const errorMsg = 'message' in message ? message.message : ('error' in message ? message.error : undefined);
        const errorMessage = errorMsg || 'An error occurred';

        // Map error type to user-friendly error code
        const errorCodeMap: Record<string, string> = {
          'timeout_error': 'API_TIMEOUT',
          'rate_limit_error': 'API_RATE_LIMIT',
          'overloaded_error': 'API_OVERLOADED',
          'authentication_error': 'API_AUTHENTICATION',
          'permission_error': 'API_PERMISSION',
          'invalid_request_error': 'API_INVALID_REQUEST',
          'request_too_large': 'API_REQUEST_TOO_LARGE',
          'network_error': 'API_NETWORK',
        };

        // Show appropriate toast notification (current session only)
        if (!isBackgroundSession) {
          if (errorType && errorCodeMap[errorType]) {
            const errorCode = errorCodeMap[errorType] as keyof typeof import('../../utils/errorMessages').ErrorMessages;
            showError(errorCode, errorMessage);
          } else {
            toast.error('Error', {
              description: errorMessage
            });
          }
        }

        // Display error as assistant message
        const errorIcon = errorType === 'timeout_error' ? '⏱️' :
                         errorType === 'rate_limit_error' ? '🚦' :
                         errorType === 'authentication_error' ? '🔑' :
                         errorType === 'network_error' ? '🌐' : '❌';

        updateMsgs((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            type: 'assistant' as const,
            content: [{
              type: 'text' as const,
              text: `${errorIcon} Error: ${errorMessage}`
            }],
            timestamp: new Date().toISOString(),
          },
        ]);
      } else if (message.type === 'user_message') {
        // Echo back user message if needed
      } else if (message.type === 'exit_plan_mode') {
        // Handle plan mode exit - show approval modal
        const planText = 'plan' in message ? message.plan : undefined;
        setPendingPlan(planText || 'No plan provided');
        // CRITICAL FIX: Don't auto-deactivate plan mode here!
        // Wait for user approval and server confirmation before changing UI state
        // The permission_mode_changed event will update the UI state after server confirms
      } else if (message.type === 'permission_mode_changed') {
        // Handle permission mode change confirmation
        const mode = 'mode' in message ? message.mode : undefined;
        setIsPlanMode(mode === 'plan');
      } else if (message.type === 'background_process_started' && 'bashId' in message && 'command' in message && 'description' in message) {
        // Handle background process started
        const sessionId = message.sessionId || activeSessionId;
        if (sessionId) {
          setBackgroundProcesses(prev => {
            const newMap = new Map(prev);
            const processes = newMap.get(sessionId) || [];
            newMap.set(sessionId, [...processes, {
              bashId: message.bashId as string,
              command: message.command as string,
              description: message.description as string,
              startedAt: Date.now()
            }]);
            return newMap;
          });
        }
      } else if (message.type === 'background_process_killed' && 'bashId' in message) {
        // Handle background process killed confirmation
        const sessionId = message.sessionId || activeSessionId;
        if (sessionId) {
          setBackgroundProcesses(prev => {
            const newMap = new Map(prev);
            const processes = newMap.get(sessionId) || [];
            newMap.set(sessionId, processes.filter(p => p.bashId !== message.bashId));
            return newMap;
          });
        }
      } else if (message.type === 'background_process_exited' && 'bashId' in message && 'exitCode' in message) {
        // Handle background process that exited on its own
        const sessionId = message.sessionId || activeSessionId;
        if (sessionId) {
          console.log(`Background process exited: ${message.bashId}, exitCode: ${message.exitCode}`);
          setBackgroundProcesses(prev => {
            const newMap = new Map(prev);
            const processes = newMap.get(sessionId) || [];
            newMap.set(sessionId, processes.filter(p => p.bashId !== message.bashId));
            return newMap;
          });
        }
      } else if (message.type === 'long_running_command_started' && 'bashId' in message && 'command' in message && 'commandType' in message) {
        // Handle long-running command started - add as message block
        const longRunningMsg = message as {
          type: 'long_running_command_started';
          bashId: string;
          command: string;
          commandType: 'install' | 'build' | 'test';
          description?: string;
          startedAt: number;
        };

        activeLongRunningCommandRef.current = longRunningMsg.bashId;

        // Add a new assistant message with the long-running command block
        updateMsgs(prev => [
          ...prev,
          {
            id: `msg-${Date.now()}`,
            type: 'assistant' as const,
            timestamp: new Date().toISOString(),
            content: [{
              type: 'long_running_command' as const,
              bashId: longRunningMsg.bashId,
              command: longRunningMsg.command,
              commandType: longRunningMsg.commandType,
              output: '',
              status: 'running' as const,
              startedAt: longRunningMsg.startedAt,
            }],
          },
        ]);
      } else if (message.type === 'command_output_chunk' && 'bashId' in message && 'output' in message) {
        // Handle streaming output from long-running command - update message block
        const outputMsg = message as { type: 'command_output_chunk'; bashId: string; output: string };

        updateMsgs(prev => {
          const lastMessage = prev[prev.length - 1];
          if (lastMessage?.type === 'assistant' && lastMessage.content.length > 0) {
            const lastBlock = lastMessage.content[lastMessage.content.length - 1];
            if (lastBlock.type === 'long_running_command' && lastBlock.bashId === outputMsg.bashId) {
              // Update the output of the last long-running command block
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: [
                    ...lastMessage.content.slice(0, -1),
                    {
                      ...lastBlock,
                      output: lastBlock.output + outputMsg.output,
                    },
                  ],
                },
              ];
            }
          }
          return prev;
        });
      } else if (message.type === 'long_running_command_completed' && 'bashId' in message) {
        // Handle long-running command completion - update message block status
        const completedMsg = message as { type: 'long_running_command_completed'; bashId: string; exitCode: number };

        updateMsgs(prev => {
          const lastMessage = prev[prev.length - 1];
          if (lastMessage?.type === 'assistant' && lastMessage.content.length > 0) {
            const lastBlock = lastMessage.content[lastMessage.content.length - 1];
            if (lastBlock.type === 'long_running_command' && lastBlock.bashId === completedMsg.bashId) {
              if (!isBackgroundSession) {
                toast.success('Command completed', {
                  description: 'Installation finished successfully',
                  duration: 3000,
                });
              }

              activeLongRunningCommandRef.current = null;

              // Update status to completed
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: [
                    ...lastMessage.content.slice(0, -1),
                    {
                      ...lastBlock,
                      status: 'completed' as const,
                    },
                  ],
                },
              ];
            }
          }
          return prev;
        });
      } else if (message.type === 'long_running_command_failed' && 'bashId' in message && 'error' in message) {
        // Handle long-running command failure - update message block status
        const failedMsg = message as { type: 'long_running_command_failed'; bashId: string; error: string };

        updateMsgs(prev => {
          const lastMessage = prev[prev.length - 1];
          if (lastMessage?.type === 'assistant' && lastMessage.content.length > 0) {
            const lastBlock = lastMessage.content[lastMessage.content.length - 1];
            if (lastBlock.type === 'long_running_command' && lastBlock.bashId === failedMsg.bashId) {
              if (!isBackgroundSession) {
                toast.error('Command failed', {
                  description: failedMsg.error,
                  duration: 5000,
                });
              }

              activeLongRunningCommandRef.current = null;

              // Update status to failed
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: [
                    ...lastMessage.content.slice(0, -1),
                    {
                      ...lastBlock,
                      status: 'failed' as const,
                      output: lastBlock.output + '\n\nError: ' + failedMsg.error,
                    },
                  ],
                },
              ];
            }
          }
          return prev;
        });
      } else if (message.type === 'slash_commands_available' && 'commands' in message) {
        // SDK supportedCommands() returns built-in commands only, not custom .md files
        // We ignore this and use REST API instead
      } else if (message.type === 'compact_start' && 'trigger' in message && 'preTokens' in message) {
        // Handle auto-compact notification
        const compactMsg = message as { type: 'compact_start'; trigger: 'auto' | 'manual'; preTokens: number };
        if (compactMsg.trigger === 'auto') {
          const tokenCount = compactMsg.preTokens.toLocaleString();
          toast.info('Auto-compacting conversation...', {
            description: `Context reached limit (${tokenCount} tokens). Summarizing history...`,
            duration: 10000, // Show for 10 seconds (compaction takes time)
          });
        }
      } else if (message.type === 'compact_loading') {
        // Handle /compact loading state - add temporary loading message with shimmer effect
        const targetSessionId = message.sessionId || activeSessionId;
        if (targetSessionId === activeSessionId) {
          const loadingMessage: Message = {
            id: 'compact-loading',
            type: 'assistant',
            content: [{ type: 'text', text: 'Compacting conversation...' }],
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, loadingMessage]);
        }
      } else if (message.type === 'compact_complete' && 'preTokens' in message) {
        // Handle /compact completion - remove loading message and add final divider
        const targetSessionId = message.sessionId || activeSessionId;
        if (targetSessionId === activeSessionId) {
          const compactMsg = message as { type: 'compact_complete'; preTokens: number };
          const tokenCount = compactMsg.preTokens.toLocaleString();

          // Remove loading message
          setMessages((prev) => prev.filter(m => m.id !== 'compact-loading'));

          // Add final divider message
          const dividerMessage: Message = {
            id: Date.now().toString(),
            type: 'assistant',
            content: [{ type: 'text', text: `--- History compacted. Previous messages were summarized to reduce token usage (${tokenCount} tokens before compact) ---` }],
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, dividerMessage]);
        }
      } else if (message.type === 'context_usage' && 'inputTokens' in message && 'contextWindow' in message && 'contextPercentage' in message) {
        // Handle context usage update (for current session)
        const usageMsg = message as {
          type: 'context_usage';
          inputTokens: number;
          outputTokens: number;
          contextWindow: number;
          contextPercentage: number;
          sessionId?: string;
        };

        const targetSessionId = usageMsg.sessionId || activeSessionId;
        if (targetSessionId) {
          setContextUsage(prev => {
            const newMap = new Map(prev);
            newMap.set(targetSessionId, {
              inputTokens: usageMsg.inputTokens,
              contextWindow: usageMsg.contextWindow,
              contextPercentage: usageMsg.contextPercentage,
              outputTokens: usageMsg.outputTokens || prev.get(targetSessionId)?.outputTokens || 0,
            });
            return newMap;
          });

          // Update liveTokenCount with actual output tokens from server
          if (usageMsg.outputTokens && targetSessionId === activeSessionId) {
            setLiveTokenCount(usageMsg.outputTokens);
          }

          console.log(`📊 Context usage updated for session ${targetSessionId.substring(0, 8)}: ${usageMsg.contextPercentage}%`);
        }
      } else if (message.type === 'reconnect_ack') {
        // Server acknowledged our reconnection — restore loading state if generation is still active
        const ack = message as { type: 'reconnect_ack'; sessionId: string; isGenerating: boolean };
        if (ack.isGenerating && ack.sessionId) {
          console.log(`🔄 Server confirms generation still active for session ${ack.sessionId.substring(0, 8)}`);
          setSessionLoading(ack.sessionId, true);
        }
      } else if (message.type === 'generation_stopped') {
        // Server confirmed generation was stopped
        const stoppedSessionId = message.sessionId;
        if (stoppedSessionId) {
          setSessionLoading(stoppedSessionId as string, false);
          // Clear message cache for stopped session
          messageCache.current.delete(stoppedSessionId as string);
        }
      } else if (message.type === 'keepalive') {
        // Keepalive messages are sent every 30s to prevent WebSocket idle timeout
        // during long-running operations. No action needed - just acknowledge receipt.
        // Optionally log for debugging (commented out to reduce noise)
        // console.log(`💓 Keepalive received (${message.elapsedSeconds}s elapsed)`);
      }
    },
  });

  // Handle killing a background process
  const handleKillProcess = (bashId: string) => {
    if (!currentSessionId) return;

    sendMessage({
      type: 'kill_background_process',
      bashId
    });

    // Optimistically remove from UI
    setBackgroundProcesses(prev => {
      const newMap = new Map(prev);
      const processes = newMap.get(currentSessionId) || [];
      newMap.set(currentSessionId, processes.filter(p => p.bashId !== bashId));
      return newMap;
    });
  };

  const handleSubmit = async (files?: import('../message/types').FileAttachment[], mode?: 'general' | 'coder' | 'intense-research' | 'spark' | 'hive', messageOverride?: string) => {
    const messageText = messageOverride || inputValue;
    if (!messageText.trim()) return;

    if (!isConnected) return;

    // Block double-submit for the CURRENT session only (allow parallel chats)
    if (currentSessionId && isSessionLoading(currentSessionId)) {
      toast.info('This chat is already generating. Wait for it to complete or stop it first.');
      return;
    }

    // Set loading immediately to prevent double-submit and show loading state
    // Use a temporary ID for new sessions, will be replaced with real session ID
    const tempSessionId = currentSessionId || `temp-${Date.now()}`;
    setSessionLoading(tempSessionId, true);

    try {
      // Create new session if none exists
      let sessionId = currentSessionId;
      if (!sessionId) {
        // Pass GitHub repo if selected (selectedRepo.name is the full_name like "owner/repo")
        const newSession = await sessionAPI.createSession(undefined, mode || 'general', selectedRepo?.name, selectedDirectory || undefined);
        if (!newSession) {
          // Error already shown by sessionAPI
          setSessionLoading(tempSessionId, false);
          return;
        }

        sessionId = newSession.id;

        // Store mode immediately for UI display
        setCurrentSessionMode(newSession.mode);
        console.log('🎭 Session created with mode:', newSession.mode, '(requested:', mode, ')', selectedRepo ? `[GitHub: ${selectedRepo.name}]` : '');

        // Load slash commands for new session
        try {
          const commandsRes = await fetch(`/api/sessions/${sessionId}/commands`);
          if (commandsRes.ok) {
            const commandsData = await commandsRes.json();
            setAvailableCommands(commandsData.commands || []);
            console.log(`📋 Loaded ${commandsData.commands?.length || 0} commands for new session`);
          }
        } catch (error) {
          console.error('Failed to load commands for new session:', error);
        }

        // Apply current permission mode to new session
        const permissionMode = isPlanMode ? 'plan' : 'bypassPermissions';
        await sessionAPI.updatePermissionMode(sessionId, permissionMode);

        // Clone GitHub repo if selected (now that session exists with working directory)
        if (selectedRepo) {
          console.log(`🐙 Cloning GitHub repo ${selectedRepo.name} to session ${sessionId}...`);
          try {
            const cloneResponse = await fetch('/api/github/clone', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                repoUrl: selectedRepo.url,
                sessionId
              })
            });
            const cloneData = await cloneResponse.json();
            if (cloneData.success) {
              toast.success(`Cloned ${selectedRepo.name}`, {
                description: `Repository ready in ${cloneData.path}`
              });
            } else {
              toast.error('Failed to clone repository', {
                description: cloneData.error
              });
            }
          } catch (error) {
            console.error('Clone error:', error);
            toast.error('Failed to clone repository');
          }
          setSelectedRepo(null);
        }

        // Clear selected directory after session creation
        if (selectedDirectory) {
          setSelectedDirectory(null);
        }

        // Update state and load sessions
        // Use flushSync to ensure currentSessionId is set before loadSessions
        // which calls handleSessionSelect — prevents the session select from
        // re-fetching messages that are already in optimistic state
        setCurrentSessionId(sessionId);
        // Refresh session list without triggering handleSessionSelect
        const updatedSessions = await sessionAPI.fetchSessions();
        setSessions(updatedSessions);

        // Transfer loading state from temp ID to real session ID
        setSessionLoading(tempSessionId, false);
        setSessionLoading(sessionId, true);
      }

      const userMessage: Message = {
        id: Date.now().toString(),
        type: 'user',
        content: messageText,
        timestamp: new Date().toISOString(),
        attachments: files,
      };

      setMessages((prev) => [...prev, userMessage]);
      // Only set loading if we didn't already set it for a new session
      if (currentSessionId) {
        setSessionLoading(sessionId, true);
      }

      // Build content: if there are image files, send as array of blocks
      // Otherwise, send as plain string (existing behavior)
      let messageContent: string | Array<Record<string, unknown>> = messageText;

      if (files && files.length > 0) {
        // Convert to content blocks format (text + images)
        const contentBlocks: Array<Record<string, unknown>> = [];

        // Add text block if there's input
        if (messageText.trim()) {
          contentBlocks.push({
            type: 'text',
            text: messageText
          });
        }

        // Add image and file blocks from attachments
        for (const file of files) {
          if (file.preview && file.type.startsWith('image/')) {
            // Extract base64 data from data URL for images
            const base64Match = file.preview.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: base64Match[1],
                  data: base64Match[2]
                }
              });
            }
          } else if (file.preview) {
            // Non-image file (document, PDF, etc.)
            contentBlocks.push({
              type: 'document',
              name: file.name,
              data: file.preview  // Contains base64 data URL
            });
          }
        }

        messageContent = contentBlocks;
      }

      // Detect user's timezone
      const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Use local sessionId variable (guaranteed to be set)
      sendMessage({
        type: 'chat',
        content: messageContent,
        sessionId: sessionId,
        model: selectedModel,
        timezone: userTimezone,
      });

      setInputValue('');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      showError('SEND_MESSAGE', errorMsg);
      // Clear both temp and real session loading states
      setSessionLoading(tempSessionId, false);
      if (currentSessionId) setSessionLoading(currentSessionId, false);
    }
  };

  const handleStop = () => {
    // Stop the CURRENT session only (multi-chat: other sessions keep running)
    if (currentSessionId && isSessionLoading(currentSessionId)) {
      stopGeneration(currentSessionId);
      setSessionLoading(currentSessionId, false);
    }
  };

  // Build wizard handlers
  const handleOpenBuildWizard = () => {
    setIsBuildWizardOpen(true);
  };

  const handleCloseBuildWizard = () => {
    setIsBuildWizardOpen(false);
  };

  const handleBuildComplete = (prompt: string) => {
    // Close wizard
    setIsBuildWizardOpen(false);

    // Clear current session to force creation of new session with Coder mode
    setCurrentSessionId(null);
    setCurrentSessionMode('coder');
    setMessages([]);

    // Auto-submit immediately with prompt override (no need to wait for state)
    setTimeout(() => {
      handleSubmit(undefined, 'coder', prompt);
    }, 100);
  };

  // Handle chat branching from sidebar
  const handleChatBranch = (chatId: string) => {
    setBranchingSessionId(chatId);
    setBranchDialogOpen(true);
  };

  // Handle branch dialog confirmation
  const handleBranchConfirm = async (config: { model?: string; title?: string }) => {
    if (!branchingSessionId) return;

    // Get the last message of the session to branch from
    const sessionMessages = await sessionAPI.fetchSessionMessages(branchingSessionId);
    if (sessionMessages.length === 0) {
      toast.error('Cannot branch empty chat', {
        description: 'Add some messages first before branching.',
      });
      return;
    }

    const lastMessage = sessionMessages[sessionMessages.length - 1];

    const branchedSession = await createBranch(branchingSessionId, {
      messageId: lastMessage.id,
      model: config.model,
      title: config.title,
    });

    if (branchedSession) {
      // Reload sessions and switch to the new branch
      await loadSessions();
      handleSessionSelect(branchedSession.id);
      setBranchDialogOpen(false);
      setBranchingSessionId(null);
    }
  };

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <Sidebar
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        chats={sessions.map(session => {
          // Extract folder name from working_directory path
          const folderName = session.working_directory?.split('/').filter(Boolean).pop() || session.title;
          // Count branches for this session
          const branchCount = sessions.filter(s => s.parent_session_id === session.id).length;
          return {
            id: session.id,
            title: folderName,
            timestamp: new Date(session.updated_at),
            isActive: session.id === currentSessionId,
            isLoading: loadingSessions.has(session.id),
            parentSessionId: session.parent_session_id,
            branchCount,
          };
        })}
        onNewChat={handleNewChat}
        onChatSelect={handleSessionSelect}
        onChatDelete={handleChatDelete}
        onChatRename={handleChatRename}
        onChatBranch={handleChatBranch}
        currentSessionId={currentSessionId}
      />

      {/* Main Chat Area */}
      <div className="flex flex-col flex-1 h-screen" style={{ marginLeft: isSidebarOpen ? '260px' : '0', transition: 'margin-left 0.2s ease-in-out' }}>
        {/* Header - Always visible */}
        <nav className="header">
          <div className="header-content">
            <div className="header-inner">
              {/* Left side */}
              <div className="header-left">
                {!isSidebarOpen && (
                  <>
                    {/* Sidebar toggle */}
                    <button className="header-btn" aria-label="Toggle Sidebar" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
                      <Menu />
                    </button>

                    {/* New chat */}
                    <button className="header-btn" aria-label="New Chat" onClick={handleNewChat}>
                      <Edit3 />
                    </button>
                  </>
                )}
              </div>

            {/* Center - Logo and Model Selector */}
            <div className="header-center">
              <div className="flex flex-col items-start w-full">
                <div className="flex justify-between items-center w-full">
                  <div className="flex items-center gap-3">
                    {!isSidebarOpen && (
                      <img
                        src="/client/agentic-icon.svg"
                        alt="Agentic"
                        className="header-icon"
                        loading="eager"
                        onError={(e) => {
                          console.error('Failed to load agentic-icon.svg');
                          // Retry loading
                          setTimeout(() => {
                            e.currentTarget.src = '/client/agentic-icon.svg?' + Date.now();
                          }, 100);
                        }}
                      />
                    )}
                    <div className="header-title text-gradient">
                      Agentic
                    </div>
                    {/* Model Selector */}
                    <ModelSelector
                      selectedModel={selectedModel}
                      onModelChange={handleModelChange}
                      hasMessages={messages.length > 0}
                      disabled={messages.length > 0}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Right side */}
            <div className="header-right">
              {/* Branch Indicator */}
              {currentSessionId && sessions.find(s => s.id === currentSessionId)?.parent_session_id && (
                <BranchIndicator
                  parentSessionTitle={
                    sessions.find(s => s.id === sessions.find(c => c.id === currentSessionId)?.parent_session_id)?.working_directory?.split('/').filter(Boolean).pop() ||
                    'Parent'
                  }
                  parentSessionId={sessions.find(s => s.id === currentSessionId)?.parent_session_id || ''}
                  onNavigateToParent={() => {
                    const parentId = sessions.find(s => s.id === currentSessionId)?.parent_session_id;
                    if (parentId) handleSessionSelect(parentId);
                  }}
                  compact
                />
              )}
              {/* GitHub Repo Indicator */}
              {currentSessionId && sessions.find(s => s.id === currentSessionId)?.github_repo && (
                <GitHubRepoIndicator
                  repoName={sessions.find(s => s.id === currentSessionId)?.github_repo || ''}
                />
              )}
              {/* Working Directory Display */}
              {currentSessionId && sessions.find(s => s.id === currentSessionId)?.working_directory && (
                <WorkingDirectoryDisplay
                  directory={sessions.find(s => s.id === currentSessionId)?.working_directory || ''}
                  sessionId={currentSessionId}
                  onChangeDirectory={handleChangeDirectory}
                />
              )}
              {/* Notification Toggle */}
              <NotificationToggle />
              {/* About Button */}
              <AboutButton />
            </div>
          </div>
        </div>
      </nav>

        {messages.length === 0 ? (
          // New Chat Welcome Screen
          <NewChatWelcome
            key={currentSessionId || 'welcome'}
            inputValue={inputValue}
            onInputChange={setInputValue}
            onSubmit={handleSubmit}
            onStop={handleStop}
            disabled={!isConnected}
            isGenerating={isCurrentSessionLoading}
            isPlanMode={isPlanMode}
            onTogglePlanMode={handleTogglePlanMode}
            availableCommands={availableCommands}
            onOpenBuildWizard={handleOpenBuildWizard}
            mode={currentSessionMode}
            onRepoSelected={handleRepoSelected}
            selectedRepo={selectedRepo}
            selectedModel={selectedModel}
            onDirectorySelected={handleDirectorySelected}
            selectedDirectory={selectedDirectory}
          />
        ) : (
          // Chat Interface
          <>
            {/* Messages */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <MessageList
                messages={messages}
                isLoading={isCurrentSessionLoading}
                liveTokenCount={liveTokenCount}
                scrollContainerRef={scrollContainerRef}
              />
            </div>

            {/* Input */}
            <ChatInput
              key={currentSessionId || 'new-chat'}
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              onStop={handleStop}
              disabled={!isConnected || isCurrentSessionLoading}
              isGenerating={isCurrentSessionLoading}
              isPlanMode={isPlanMode}
              onTogglePlanMode={handleTogglePlanMode}
              backgroundProcesses={backgroundProcesses.get(currentSessionId || '') || []}
              onKillProcess={handleKillProcess}
              mode={currentSessionId ? currentSessionMode : undefined}
              availableCommands={availableCommands}
              selectedModel={selectedModel}
              sessionId={currentSessionId}
              onRepoSelected={handleRepoSelected}
              selectedRepo={selectedRepo}
              connectedRepo={currentSessionId ? sessions.find(s => s.id === currentSessionId)?.github_repo : null}
            />
          </>
        )}
      </div>

      {/* Plan Approval Modal */}
      {pendingPlan && (
        <PlanApprovalModal
          plan={pendingPlan}
          onApprove={handleApprovePlan}
          onReject={handleRejectPlan}
          isResponseInProgress={isLoading}
        />
      )}

      {/* Build Wizard */}
      {isBuildWizardOpen && (
        <BuildWizard
          onComplete={handleBuildComplete}
          onClose={handleCloseBuildWizard}
        />
      )}

      {/* Branch Dialog */}
      {branchDialogOpen && branchingSessionId && (
        <BranchDialog
          isOpen={branchDialogOpen}
          onClose={() => {
            setBranchDialogOpen(false);
            setBranchingSessionId(null);
          }}
          onConfirm={handleBranchConfirm}
          parentSessionTitle={
            sessions.find(s => s.id === branchingSessionId)?.working_directory?.split('/').filter(Boolean).pop() ||
            sessions.find(s => s.id === branchingSessionId)?.title ||
            'Chat'
          }
          currentModel={selectedModel}
        />
      )}

      {/* Scroll Button - only show when messages exist */}
      {messages.length > 0 && <ScrollButton scrollContainerRef={scrollContainerRef} />}
    </div>
  );
}
