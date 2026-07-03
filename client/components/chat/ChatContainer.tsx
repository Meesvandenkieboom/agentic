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

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { NewChatWelcome } from './NewChatWelcome';
import { Sidebar } from '../sidebar/Sidebar';
import { ChatHeader } from '../header/ChatHeader';
import { PlanApprovalModal } from '../plan/PlanApprovalModal';
import { BuildWizard } from '../build-wizard/BuildWizard';
import { ScrollButton } from './ScrollButton';
import { SearchContext } from './SearchContext';
import { BranchDialog } from './BranchDialog';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useBranching } from '../../hooks/useBranching';
import { useChatSearch } from '../../hooks/useChatSearch';
import { useChatMessages, generateMessageId } from '../../hooks/useChatMessages';
import { useChatSessions } from '../../hooks/useChatSessions';
import type { Message, FileAttachment } from '../message/types';
import { toast } from '../../utils/toast';
import { showError } from '../../utils/errorMessages';
import { handleWebSocketMessage } from './websocketHandler';
import { QUESTION_ANSWER_EVENT, type QuestionAnswerDetail } from '../../utils/questionEvents';
import { BRANCH_MESSAGE_EVENT, type BranchMessageDetail } from '../../utils/branchEvents';
import { resolveBranchPointId } from '../../utils/branchPoint';
import { QuestionInput, type PendingQuestionData } from '../question/QuestionInput';
import { dispatchQuestionAnswer } from '../../utils/questionEvents';
import type { ReasoningEffort } from './ReasoningEffortSelector';
import { DEFAULT_EFFORT } from './ReasoningEffortSelector';
import { ArtifactPanel } from '../artifact/ArtifactPanel';
import { ResizableDivider } from '../artifact/ResizableDivider';
import { useArtifactPanel } from '../../hooks/useArtifactPanel';
import { normalizeModelId } from '../../config/models';

export function ChatContainer() {
  // --- Extracted hooks for message + session state ---
  const msgHook = useChatMessages();
  const { messages, setMessages, switchMessages, mergeDbMessages, clearCache, createMessageUpdater } = msgHook;

  const sessionHook = useChatSessions();
  const {
    sessions, setSessions, currentSessionId, setCurrentSessionId, currentSessionIdRef,
    currentSessionMode, setCurrentSessionMode,
    availableCommands, setAvailableCommands: _setAvailableCommands,
    contextUsage, setContextUsage,
    backgroundProcesses, setBackgroundProcesses,
    isPlanMode, setIsPlanMode,
    pendingPlan, setPendingPlan,
    loadingSessions, setLoadingSessions,
    isSubmittingRef,
    sessionAPI,
    setSessionLoading, isSessionLoading,
    isAnySessionLoading, isCurrentSessionLoading,
    loadSessions, loadSlashCommands,
    handleChatDelete: baseHandleChatDelete,
    handleChatRename,
    persistSessionId,
  } = sessionHook;

  // --- Local UI state ---
  // Prompt text lives inside the input components (ChatInput/NewChatWelcome) so typing
  // doesn't re-render this container. Bumping this nonce remounts the input to clear a draft.
  const [newChatNonce, setNewChatNonce] = useState(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [liveTokenCount, setLiveTokenCount] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const stored = localStorage.getItem('agentic-model');
    const normalized = normalizeModelId(stored);
    if (stored !== normalized) {
      localStorage.setItem('agentic-model', normalized);
    }
    return normalized;
  });
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    const stored = localStorage.getItem('agentic-effort');
    const valid: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    return (valid as string[]).includes(stored || '') ? (stored as ReasoningEffort) : DEFAULT_EFFORT;
  });
  const handleEffortChange = (effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    localStorage.setItem('agentic-effort', effort);
  };
  const [isBuildWizardOpen, setIsBuildWizardOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<{ url: string; name: string } | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  // True while a GitHub repo is being cloned during chat creation.
  // Drives the send-button loading state so users know the UI isn't frozen.
  const [isCloning, setIsCloning] = useState(false);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchingSessionId, setBranchingSessionId] = useState<string | null>(null);
  // Set when branching from a specific message (per-message button); null = branch whole chat
  const [branchFromMessage, setBranchFromMessage] = useState<{ id: string; index: number; preview: string } | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestionData | null>(null);

  // --- Artifact panel state (zustand selectors) ---
  const artifactPanelOpen = useArtifactPanel(s => s.isOpen);
  const artifactPanelMaximized = useArtifactPanel(s => s.isMaximized);
  const artifactPanelWidth = useArtifactPanel(s => s.width);
  const artifactsMap = useArtifactPanel(s => s.artifacts);
  const setArtifactPanelWidth = useArtifactPanel(s => s.setWidth);
  const toggleArtifactPanel = useArtifactPanel(s => s.toggle);
  const closeArtifactPanel = useArtifactPanel(s => s.close);
  const listArtifactsForSession = useArtifactPanel(s => s.listForSession);
  const visibleArtifactCount = useMemo(
    () => listArtifactsForSession(currentSessionId).length,
    [artifactsMap, currentSessionId, listArtifactsForSession],
  );
  const shouldShowArtifactPanel = artifactPanelOpen && visibleArtifactCount > 0;
  const shouldMaximizeArtifactPanel = shouldShowArtifactPanel && artifactPanelMaximized;

  const scrollContainerRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
  const activeLongRunningCommandRef = useRef<string | null>(null);
  const lastAssistantContentRef = useRef<string>('');

  const isLoading = isAnySessionLoading;
  const { createBranch } = useBranching();
  const chatSearch = useChatSearch(messages);
  const allMatchesInfo = useMemo(() =>
    chatSearch.matches.map(m => ({ messageId: m.messageId, messageIndex: m.messageIndex, matchStart: m.matchStart })),
    [chatSearch.matches],
  );
  const searchContextValue = useMemo(() => ({
    query: isSearchOpen ? chatSearch.query : '',
    currentMatchMessageIndex: chatSearch.currentMatch?.messageIndex ?? null,
    currentMatchIndex: chatSearch.currentMatchIndex,
    currentMatch: chatSearch.currentMatch ? {
      messageId: chatSearch.currentMatch.messageId,
      messageIndex: chatSearch.currentMatch.messageIndex,
      matchStart: chatSearch.currentMatch.matchStart,
    } : null,
    allMatches: isSearchOpen ? allMatchesInfo : [],
  }), [isSearchOpen, chatSearch.query, chatSearch.currentMatch, chatSearch.currentMatchIndex, allMatchesInfo]);

  // --- Ctrl+F / Cmd+F keyboard shortcut for search ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (messages.length > 0) {
          e.preventDefault();
          if (isSearchOpen) {
            setSearchFocusKey(k => k + 1);
          } else {
            setIsSearchOpen(true);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [messages.length, isSearchOpen]);

  // --- Cmd/Ctrl + Shift + A toggles the artifact panel ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        toggleArtifactPanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleArtifactPanel]);

  // --- Persist session ID to localStorage ---
  useEffect(() => {
    persistSessionId(currentSessionId);
  }, [currentSessionId, persistSessionId]);

  // --- Load sessions on mount ---
  useEffect(() => {
    const init = async () => {
      const loaded = await loadSessions();
      const initialSessionId = currentSessionIdRef.current;
      if (initialSessionId && loaded.some(s => s.id === initialSessionId)) {
        handleSessionSelect(initialSessionId);
      } else if (initialSessionId) {
        setCurrentSessionId(null);
      }
    };
    init();
  }, []);

  // Auto-switch to hive mode if HIVE model is already selected
  useEffect(() => {
    if (selectedModel === 'hive') {
      setCurrentSessionMode('hive');
    }
  }, []);

  // --- Model selection ---
  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    localStorage.setItem('agentic-model', modelId);
    if (modelId === 'hive') {
      setCurrentSessionMode('hive');
    } else if (currentSessionMode === 'hive') {
      setCurrentSessionMode('general');
    }
  };

  // --- Session switching (CRITICAL: atomic state transitions) ---
  const handleSessionSelect = async (sessionId: string) => {
    const storedUsage = contextUsage.get(sessionId);
    const cachedMessages = switchMessages(
      currentSessionId,
      sessionId,
      messages,
      storedUsage?.outputTokens || 0,
      setLiveTokenCount,
    );

    setCurrentSessionId(sessionId);

    const fetchedSessions = await sessionAPI.fetchSessions();
    const session = fetchedSessions.find(s => s.id === sessionId);
    if (session) {
      const sessionModel = normalizeModelId(session.model);
      setSelectedModel(sessionModel);
      localStorage.setItem('agentic-model', sessionModel);
      setIsPlanMode(session.permission_mode === 'plan');
      setCurrentSessionMode(sessionModel === 'hive' ? 'hive' : session.mode);
    }

    await loadSlashCommands(sessionId);

    if (cachedMessages) return;

    const sessionMessages = await sessionAPI.fetchSessionMessages(sessionId);
    const convertedMessages: Message[] = sessionMessages.map(msg => {
      if (msg.type === 'user') {
        return { id: msg.id, type: 'user' as const, content: msg.content, timestamp: msg.timestamp };
      }
      let content;
      try {
        const parsed = JSON.parse(msg.content);
        content = Array.isArray(parsed) ? parsed : [{ type: 'text' as const, text: msg.content }];
      } catch {
        content = [{ type: 'text' as const, text: msg.content }];
      }
      return { id: msg.id, type: 'assistant' as const, content, timestamp: msg.timestamp };
    });

    // Rehydrate any artifact blocks found in restored messages into the artifact store.
    // This makes previously-generated artifacts available in the panel tabs when the
    // session is reopened. Runs inline (synchronously) to avoid racing with user input.
    const hydrate = useArtifactPanel.getState().hydrateArtifact;
    for (const msg of convertedMessages) {
      if (msg.type !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'artifact') {
          const ab = block as { type: 'artifact'; artifactId: string; artifactType: string; title?: string; language?: string; content: string };
          const createdAt = new Date(msg.timestamp).getTime() || Date.now();
          hydrate({
            id: ab.artifactId,
            // Cast is safe: server only emits valid types; invalid ones were filtered on the wire.
            artifactType: ab.artifactType as Parameters<typeof hydrate>[0]['artifactType'],
            title: ab.title,
            language: ab.language,
            content: ab.content,
            status: 'complete',
            sessionId,
            createdAt,
            updatedAt: createdAt,
          });
        }
      }
    }

    mergeDbMessages(convertedMessages, sessionId, currentSessionIdRef);
  };

  // --- New chat ---
  const handleNewChat = () => {
    setCurrentSessionId(null);
    setCurrentSessionMode('general');
    setMessages([]);
    setNewChatNonce(n => n + 1);
    setSelectedRepo(null);
    setSelectedDirectory(null);
    closeArtifactPanel();
  };

  // --- Chat deletion with cache + map cleanup ---
  const handleChatDelete = async (chatId: string) => {
    clearCache(chatId);
    if (chatId === currentSessionId) {
      setMessages([]);
      closeArtifactPanel();
    }
    await baseHandleChatDelete(chatId);
  };

  // --- Working directory change ---
  const handleChangeDirectory = async (sessionId: string, newDirectory: string) => {
    const result = await sessionAPI.updateWorkingDirectory(sessionId, newDirectory);
    if (result.success) {
      await loadSessions();
      await loadSlashCommands(sessionId);
      toast.success('Directory changed', { description: 'Context reset - conversation starts fresh' });
    } else {
      toast.error('Error', { description: result.error || 'Failed to change working directory' });
    }
  };

  // --- Plan mode ---
  const handleTogglePlanMode = async () => {
    const newPlanMode = !isPlanMode;
    const mode = newPlanMode ? 'plan' : 'bypassPermissions';
    setIsPlanMode(newPlanMode);
    if (currentSessionId) {
      const result = await sessionAPI.updatePermissionMode(currentSessionId, mode);
      if (result.success && isSessionLoading(currentSessionId)) {
        sendMessage({ type: 'set_permission_mode', sessionId: currentSessionId, mode });
      }
    }
  };

  const handleApprovePlan = () => {
    if (!currentSessionId) return;
    sendMessage({ type: 'approve_plan', sessionId: currentSessionId });
    setPendingPlan(null);
  };

  const handleRejectPlan = () => {
    setPendingPlan(null);
    if (currentSessionId) setSessionLoading(currentSessionId, false);
  };

  // --- Pre-chat selections ---
  const handleRepoSelected = (repoUrl: string, repoName: string) => {
    setSelectedRepo({ url: repoUrl, name: repoName });
    toast.success(`Selected ${repoName}`, { description: 'Repository will be cloned when chat starts' });
  };

  const handleDirectorySelected = (path: string) => {
    setSelectedDirectory(path);
    toast.success('Directory selected', { description: path.split('/').filter(Boolean).pop() || path });
  };

  // --- WebSocket ---
  const { isConnected, sendMessage, stopGeneration } = useWebSocket({
    url: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
    onConnect: async () => {
      const tabSessionId = currentSessionIdRef.current;

      try {
        const res = await fetch('/api/sessions/active-streams');
        const data = await res.json();
        const activeIds: string[] = data.sessionIds || [];
        const reconnectIds = new Set(activeIds);
        if (tabSessionId) reconnectIds.add(tabSessionId);

        for (const sid of reconnectIds) {
          sendMessage({ type: 'reconnect', sessionId: sid });
        }
        setLoadingSessions(new Set(activeIds));
      } catch {
        if (tabSessionId) {
          sendMessage({ type: 'reconnect', sessionId: tabSessionId });
        }
      }
    },
    onDisconnect: () => {
      console.log('🔌 WebSocket disconnected — will auto-reconnect');
    },
    onMessage: (message) => {
      handleWebSocketMessage(message, {
        currentSessionIdRef,
        createMessageUpdater,
        setMessages,
        setSessions,
        setSessionLoading,
        setLiveTokenCount,
        setContextUsage,
        setIsPlanMode,
        setPendingPlan,
        setPendingQuestion,
        setBackgroundProcesses,
        clearCache,
        lastAssistantContentRef,
        activeLongRunningCommandRef,
      });
    },
  });

  // --- Listen for AskUserQuestion answers from inline components ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { toolId, answers } = (e as CustomEvent<QuestionAnswerDetail>).detail;
      if (currentSessionId) {
        sendMessage({ type: 'answer_question', sessionId: currentSessionId, toolId, answers });
      }
    };
    window.addEventListener(QUESTION_ANSWER_EVENT, handler);
    return () => window.removeEventListener(QUESTION_ANSWER_EVENT, handler);
  }, [currentSessionId, sendMessage]);

  // --- Background process management ---
  const handleKillProcess = (bashId: string) => {
    if (!currentSessionId) return;
    sendMessage({ type: 'kill_background_process', bashId });
    setBackgroundProcesses(prev => {
      const newMap = new Map(prev);
      const processes = newMap.get(currentSessionId) || [];
      newMap.set(currentSessionId, processes.filter(p => p.bashId !== bashId));
      return newMap;
    });
  };

  // --- Submit with double-submit guard ---
  // Returns true when the message was accepted for sending, so the caller can clear its draft.
  const handleSubmit = async (text: string, files?: FileAttachment[], mode?: 'general' | 'coder' | 'intense-research' | 'spark' | 'hive'): Promise<boolean> => {
    const messageText = text;
    if (!messageText.trim() || !isConnected) return false;

    if (isSubmittingRef.current) return false;
    if (currentSessionId && isSessionLoading(currentSessionId)) {
      toast.info('This chat is already generating. Wait for it to complete or stop it first.');
      return false;
    }

    isSubmittingRef.current = true;
    const tempSessionId = currentSessionId || `temp-${Date.now()}`;
    setSessionLoading(tempSessionId, true);

    try {
      let sessionId = currentSessionId;
      if (!sessionId) {
        const newSession = await sessionAPI.createSession(undefined, mode || 'general', selectedRepo?.name, selectedDirectory || undefined, selectedModel);
        if (!newSession) {
          setSessionLoading(tempSessionId, false);
          return false;
        }
        sessionId = newSession.id;
        setCurrentSessionMode(newSession.mode);
        await loadSlashCommands(sessionId);

        const permissionMode = isPlanMode ? 'plan' : 'bypassPermissions';
        await sessionAPI.updatePermissionMode(sessionId, permissionMode);

        if (selectedRepo) {
          setIsCloning(true);
          try {
            const cloneResponse = await fetch('/api/github/clone', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoUrl: selectedRepo.url, sessionId }),
            });
            const cloneData = await cloneResponse.json();
            if (cloneData.success) {
              toast.success(`Cloned ${selectedRepo.name}`, { description: `Repository ready in ${cloneData.path}` });
            } else {
              toast.error('Failed to clone repository', { description: cloneData.error });
            }
          } catch (error) {
            console.error('Clone error:', error);
            toast.error('Failed to clone repository');
          } finally {
            setIsCloning(false);
          }
          setSelectedRepo(null);
        }

        if (selectedDirectory) setSelectedDirectory(null);
        setCurrentSessionId(sessionId);
        await loadSessions();
        setSessionLoading(tempSessionId, false);
        setSessionLoading(sessionId, true);
      }

      const userMessage: Message = {
        id: generateMessageId(),
        type: 'user',
        content: messageText,
        timestamp: new Date().toISOString(),
        attachments: files,
      };

      setMessages(prev => [...prev, userMessage]);
      if (currentSessionId) setSessionLoading(sessionId, true);

      let messageContent: string | Array<Record<string, unknown>> = messageText;
      if (files && files.length > 0) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (messageText.trim()) contentBlocks.push({ type: 'text', text: messageText });
        for (const file of files) {
          if (file.preview && file.type.startsWith('image/')) {
            const base64Match = file.preview.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] } });
            }
          } else if (file.preview) {
            contentBlocks.push({ type: 'document', name: file.name, data: file.preview });
          }
        }
        messageContent = contentBlocks;
      }

      sendMessage({
        type: 'chat',
        content: messageContent,
        sessionId,
        model: selectedModel,
        effort: reasoningEffort,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      showError('SEND_MESSAGE', errorMsg);
      setSessionLoading(tempSessionId, false);
      if (currentSessionId) setSessionLoading(currentSessionId, false);
      return false;
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const handleStop = () => {
    if (currentSessionId && isSessionLoading(currentSessionId)) {
      stopGeneration(currentSessionId);
      setSessionLoading(currentSessionId, false);
    }
  };

  // --- Build wizard ---
  const handleBuildComplete = (prompt: string) => {
    setIsBuildWizardOpen(false);
    setCurrentSessionId(null);
    setCurrentSessionMode('coder');
    setMessages([]);
    setTimeout(() => handleSubmit(prompt, undefined, 'coder'), 100);
  };

  // --- Branching ---
  const handleChatBranch = (chatId: string) => {
    setBranchFromMessage(null);
    setBranchingSessionId(chatId);
    setBranchDialogOpen(true);
  };

  // Per-message "branch from here" buttons dispatch this event
  useEffect(() => {
    const handler = (e: Event) => {
      const { messageId } = (e as CustomEvent<BranchMessageDetail>).detail;
      if (!currentSessionId) return;
      const index = messages.findIndex(m => m.id === messageId);
      if (index === -1) return;
      const msg = messages[index];
      let preview = '';
      if (typeof msg.content === 'string') {
        preview = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find(b => b.type === 'text');
        preview = textBlock && 'text' in textBlock ? textBlock.text : '';
      }
      setBranchFromMessage({ id: messageId, index, preview });
      setBranchingSessionId(currentSessionId);
      setBranchDialogOpen(true);
    };
    window.addEventListener(BRANCH_MESSAGE_EVENT, handler);
    return () => window.removeEventListener(BRANCH_MESSAGE_EVENT, handler);
  }, [currentSessionId, messages]);

  const handleBranchConfirm = async (config: { model?: string; title?: string }) => {
    if (!branchingSessionId) return;
    const sessionMessages = await sessionAPI.fetchSessionMessages(branchingSessionId);
    if (sessionMessages.length === 0) {
      toast.error('Cannot branch empty chat', { description: 'Add some messages first before branching.' });
      return;
    }
    // Default (sidebar branch): branch from the last message.
    // Per-message branch: resolve the clicked message to its DB row, since
    // messages sent live in this tab have local IDs that don't exist in the DB.
    let branchPointId = sessionMessages[sessionMessages.length - 1].id;
    if (branchFromMessage) {
      const resolved = resolveBranchPointId(messages, sessionMessages, branchFromMessage.id);
      if (!resolved) {
        toast.error('Could not locate message', { description: 'Try branching from a different message.' });
        return;
      }
      branchPointId = resolved;
    }
    const branchedSession = await createBranch(branchingSessionId, {
      messageId: branchPointId,
      model: config.model,
      title: config.title,
    });
    if (branchedSession) {
      await loadSessions();
      handleSessionSelect(branchedSession.id);
      setBranchDialogOpen(false);
      setBranchingSessionId(null);
      setBranchFromMessage(null);
    }
  };

  // --- Import chat from exported file ---
  const handleChatImport = async (file: File) => {
    try {
      const text = await file.text();
      const response = await fetch('/api/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const result = await response.json() as { success: boolean; session?: { id: string; title: string }; error?: string };
      if (!response.ok || !result.success || !result.session) {
        toast.error('Failed to import chat', { description: result.error || 'Unknown error' });
        return;
      }
      await loadSessions();
      handleSessionSelect(result.session.id);
      toast.success('Chat imported', { description: result.session.title });
    } catch (error) {
      toast.error('Failed to import chat', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // --- Search helpers ---
  const handleToggleSearch = () => {
    if (isSearchOpen) {
      setSearchFocusKey(k => k + 1);
    } else {
      setIsSearchOpen(true);
    }
  };

  const handleCloseSearch = () => {
    setIsSearchOpen(false);
    chatSearch.clearSearch();
  };

  // --- Render ---
  return (
    <div className="flex h-screen">
      <Sidebar
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        chats={sessions.map(session => {
          const branchCount = sessions.filter(s => s.parent_session_id === session.id).length;
          return {
            id: session.id,
            title: session.title && session.title !== 'New Chat' ? session.title : 'New Chat',
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
        onChatImport={handleChatImport}
        currentSessionId={currentSessionId}
      />

      <div className="flex flex-row flex-1 h-screen min-w-0" style={{ marginLeft: isSidebarOpen ? '260px' : '0', transition: 'margin-left 0.2s ease-in-out' }}>
        {!shouldMaximizeArtifactPanel && (
        <div className="flex flex-col flex-1 min-w-0 h-screen">
        <ChatHeader
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          onNewChat={handleNewChat}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          hasMessages={messages.length > 0}
          currentSessionId={currentSessionId}
          sessions={sessions}
          onSessionSelect={handleSessionSelect}
          onChangeDirectory={handleChangeDirectory}
          isSearchOpen={isSearchOpen}
          onToggleSearch={handleToggleSearch}
          searchFocusKey={searchFocusKey}
          chatSearch={chatSearch}
          onCloseSearch={handleCloseSearch}
        />

        {messages.length === 0 ? (
          <NewChatWelcome
            key={currentSessionId || `new-${newChatNonce}`}
            onSubmit={handleSubmit}
            onStop={handleStop}
            disabled={!isConnected || isCloning}
            isGenerating={isCurrentSessionLoading}
            isCloning={isCloning}
            isPlanMode={isPlanMode}
            onTogglePlanMode={handleTogglePlanMode}
            availableCommands={availableCommands}
            onOpenBuildWizard={() => setIsBuildWizardOpen(true)}
            mode={currentSessionMode}
            onRepoSelected={handleRepoSelected}
            selectedRepo={selectedRepo}
            selectedModel={selectedModel}
            onDirectorySelected={handleDirectorySelected}
            selectedDirectory={selectedDirectory}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={handleEffortChange}
          />
        ) : (
          <>
            <SearchContext.Provider value={searchContextValue}>
              <MessageList
                messages={messages}
                isLoading={isCurrentSessionLoading}
                liveTokenCount={liveTokenCount}
                scrollContainerRef={scrollContainerRef}
              />
            </SearchContext.Provider>
            {pendingQuestion ? (
              <QuestionInput
                question={pendingQuestion}
                onAnswer={(answers) => {
                  dispatchQuestionAnswer(pendingQuestion.toolId, answers);
                  setPendingQuestion(null);
                }}
                onSkip={() => {
                  const skipped: Record<string, string> = {};
                  pendingQuestion.questions.forEach((qq, idx) => {
                    skipped[qq.header || `question_${idx}`] = 'Skipped';
                  });
                  dispatchQuestionAnswer(pendingQuestion.toolId, skipped);
                  setPendingQuestion(null);
                }}
              />
            ) : (
              <ChatInput
                key={currentSessionId || `new-${newChatNonce}`}
                onSubmit={handleSubmit}
                onStop={handleStop}
                disabled={!isConnected || isCurrentSessionLoading || isCloning}
                isGenerating={isCurrentSessionLoading}
                isCloning={isCloning}
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
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={handleEffortChange}
              />
            )}
          </>
        )}
        </div>
        )}

        {shouldShowArtifactPanel && (
          <>
            {!shouldMaximizeArtifactPanel && (
              <ResizableDivider
                width={artifactPanelWidth}
                onResize={setArtifactPanelWidth}
              />
            )}
            <div
              className="h-screen shrink-0"
              style={{ width: shouldMaximizeArtifactPanel ? '100%' : `${artifactPanelWidth}px` }}
            >
              <ArtifactPanel sessionId={currentSessionId} />
            </div>
          </>
        )}
      </div>

      {pendingPlan && (
        <PlanApprovalModal
          plan={pendingPlan}
          onApprove={handleApprovePlan}
          onReject={handleRejectPlan}
          isResponseInProgress={isLoading}
        />
      )}

      {isBuildWizardOpen && (
        <BuildWizard onComplete={handleBuildComplete} onClose={() => setIsBuildWizardOpen(false)} />
      )}

      {branchDialogOpen && branchingSessionId && (
        <BranchDialog
          isOpen={branchDialogOpen}
          onClose={() => { setBranchDialogOpen(false); setBranchingSessionId(null); setBranchFromMessage(null); }}
          onConfirm={handleBranchConfirm}
          parentSessionTitle={
            sessions.find(s => s.id === branchingSessionId)?.title || 'Chat'
          }
          messagePreview={branchFromMessage?.preview || undefined}
          messageIndex={branchFromMessage?.index}
          currentModel={normalizeModelId(sessions.find(s => s.id === branchingSessionId)?.model)}
        />
      )}

      {messages.length > 0 && <ScrollButton scrollContainerRef={scrollContainerRef} />}
    </div>
  );
}
