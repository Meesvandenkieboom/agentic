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
import { ModelSelector } from '../header/ModelSelector';
import { WorkingDirectoryDisplay } from '../header/WorkingDirectoryDisplay';
import { GitHubRepoIndicator } from '../header/GitHubRepoIndicator';
import { ChatSearchButton } from '../header/ChatSearchButton';
import { ChatSearchBar } from '../header/ChatSearchBar';
import { NotificationToggle } from '../header/NotificationToggle';
import { PlanApprovalModal } from '../plan/PlanApprovalModal';
import { BuildWizard } from '../build-wizard/BuildWizard';
import { ScrollButton } from './ScrollButton';
import { SearchContext } from './SearchContext';
import { BranchDialog } from './BranchDialog';
import { BranchIndicator } from './BranchIndicator';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useBranching } from '../../hooks/useBranching';
import { useChatSearch } from '../../hooks/useChatSearch';
import { useChatMessages, generateMessageId } from '../../hooks/useChatMessages';
import { useChatSessions } from '../../hooks/useChatSessions';
import { Menu, Edit3 } from 'lucide-react';
import type { Message } from '../message/types';
import { toast } from '../../utils/toast';
import { showError } from '../../utils/errorMessages';
import { handleWebSocketMessage } from './websocketHandler';
import { QUESTION_ANSWER_EVENT, type QuestionAnswerDetail } from '../../utils/questionEvents';
import { QuestionInput, type PendingQuestionData } from '../question/QuestionInput';
import { dispatchQuestionAnswer } from '../../utils/questionEvents';

export function ChatContainer() {
  // --- Extracted hooks for message + session state ---
  const msgHook = useChatMessages();
  const { messages, setMessages, switchMessages, mergeDbMessages, clearCache, createMessageUpdater } = msgHook;

  const sessionHook = useChatSessions();
  const {
    sessions, setSessions, currentSessionId, setCurrentSessionId, currentSessionIdRef,
    currentSessionMode, setCurrentSessionMode,
    availableCommands, setAvailableCommands,
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
  const [inputValue, setInputValue] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [liveTokenCount, setLiveTokenCount] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return localStorage.getItem('agentic-model') || 'sonnet';
  });
  const [isBuildWizardOpen, setIsBuildWizardOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<{ url: string; name: string } | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchingSessionId, setBranchingSessionId] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestionData | null>(null);

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
            // Already open — re-focus input
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

  // --- Persist session ID to localStorage ---
  useEffect(() => {
    persistSessionId(currentSessionId);
  }, [currentSessionId, persistSessionId]);

  // --- Load sessions on mount ---
  useEffect(() => {
    const init = async () => {
      const loaded = await loadSessions();
      const persistedId = localStorage.getItem('agentic-active-session');
      if (persistedId && loaded.some(s => s.id === persistedId)) {
        handleSessionSelect(persistedId);
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to hive mode if HIVE model is already selected
  useEffect(() => {
    if (selectedModel === 'hive') {
      setCurrentSessionMode('hive');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Now set session ID (flushSync already applied inside switchMessages)
    setCurrentSessionId(sessionId);

    // Async: load session details + commands
    const fetchedSessions = await sessionAPI.fetchSessions();
    const session = fetchedSessions.find(s => s.id === sessionId);
    if (session) {
      setIsPlanMode(session.permission_mode === 'plan');
      setCurrentSessionMode(session.mode);
    }

    await loadSlashCommands(sessionId);

    // If we had cached messages, skip DB fetch
    if (cachedMessages) return;

    // Load from DB
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

    // Merge with deduplication (prevents the merge-duplication bug)
    mergeDbMessages(convertedMessages, sessionId, currentSessionIdRef);
  };

  // --- New chat ---
  const handleNewChat = () => {
    setCurrentSessionId(null);
    setCurrentSessionMode('general');
    setMessages([]);
    setInputValue('');
    setSelectedRepo(null);
    setSelectedDirectory(null);
  };

  // --- Chat deletion with cache + map cleanup ---
  const handleChatDelete = async (chatId: string) => {
    clearCache(chatId);
    if (chatId === currentSessionId) {
      setMessages([]);
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
      // Restore view for persisted session
      const persistedSessionId = localStorage.getItem('agentic-active-session');
      if (persistedSessionId) {
        await handleSessionSelect(persistedSessionId);
      }

      // Ask server which sessions are actively generating, then reconnect ALL of them
      try {
        const res = await fetch('/api/sessions/active-streams');
        const data = await res.json();
        const activeIds: string[] = data.sessionIds || [];

        // Reconnect ALL active sessions (not just the current one)
        for (const sid of activeIds) {
          sendMessage({ type: 'reconnect', sessionId: sid });
        }

        // Restore loading states from server truth
        setLoadingSessions(new Set(activeIds));
      } catch {
        // Fallback: reconnect just the persisted session
        if (persistedSessionId) {
          sendMessage({ type: 'reconnect', sessionId: persistedSessionId });
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
  const handleSubmit = async (files?: import('../message/types').FileAttachment[], mode?: 'general' | 'coder' | 'intense-research' | 'spark' | 'hive', messageOverride?: string) => {
    const messageText = messageOverride || inputValue;
    if (!messageText.trim() || !isConnected) return;

    // Guard: prevent double-submit
    if (isSubmittingRef.current) return;
    if (currentSessionId && isSessionLoading(currentSessionId)) {
      toast.info('This chat is already generating. Wait for it to complete or stop it first.');
      return;
    }

    isSubmittingRef.current = true;
    const tempSessionId = currentSessionId || `temp-${Date.now()}`;
    setSessionLoading(tempSessionId, true);

    try {
      let sessionId = currentSessionId;
      if (!sessionId) {
        const newSession = await sessionAPI.createSession(undefined, mode || 'general', selectedRepo?.name, selectedDirectory || undefined);
        if (!newSession) {
          setSessionLoading(tempSessionId, false);
          return;
        }
        sessionId = newSession.id;
        setCurrentSessionMode(newSession.mode);
        await loadSlashCommands(sessionId);

        const permissionMode = isPlanMode ? 'plan' : 'bypassPermissions';
        await sessionAPI.updatePermissionMode(sessionId, permissionMode);

        if (selectedRepo) {
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
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setInputValue('');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      showError('SEND_MESSAGE', errorMsg);
      setSessionLoading(tempSessionId, false);
      if (currentSessionId) setSessionLoading(currentSessionId, false);
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
    setTimeout(() => handleSubmit(undefined, 'coder', prompt), 100);
  };

  // --- Branching ---
  const handleChatBranch = (chatId: string) => {
    setBranchingSessionId(chatId);
    setBranchDialogOpen(true);
  };

  const handleBranchConfirm = async (config: { model?: string; title?: string }) => {
    if (!branchingSessionId) return;
    const sessionMessages = await sessionAPI.fetchSessionMessages(branchingSessionId);
    if (sessionMessages.length === 0) {
      toast.error('Cannot branch empty chat', { description: 'Add some messages first before branching.' });
      return;
    }
    const lastMessage = sessionMessages[sessionMessages.length - 1];
    const branchedSession = await createBranch(branchingSessionId, {
      messageId: lastMessage.id,
      model: config.model,
      title: config.title,
    });
    if (branchedSession) {
      await loadSessions();
      handleSessionSelect(branchedSession.id);
      setBranchDialogOpen(false);
      setBranchingSessionId(null);
    }
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
        currentSessionId={currentSessionId}
      />

      <div className="flex flex-col flex-1 h-screen" style={{ marginLeft: isSidebarOpen ? '260px' : '0', transition: 'margin-left 0.2s ease-in-out' }}>
        <nav className="header">
          <div className="header-content">
            <div className="header-inner">
              <div className="header-left">
                {!isSidebarOpen && (
                  <>
                    <button className="header-btn" aria-label="Toggle Sidebar" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
                      <Menu />
                    </button>
                    <button className="header-btn" aria-label="New Chat" onClick={handleNewChat}>
                      <Edit3 />
                    </button>
                  </>
                )}
              </div>

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
                          setTimeout(() => { e.currentTarget.src = '/client/agentic-icon.svg?' + Date.now(); }, 100);
                        }}
                      />
                    )}
                    <div className="header-title text-gradient">Agentic</div>
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

            <div className="header-right">
              {currentSessionId && sessions.find(s => s.id === currentSessionId)?.parent_session_id && (
                <BranchIndicator
                  parentSessionTitle={
                    sessions.find(s => s.id === sessions.find(c => c.id === currentSessionId)?.parent_session_id)?.title || 'Parent'
                  }
                  parentSessionId={sessions.find(s => s.id === currentSessionId)?.parent_session_id || ''}
                  onNavigateToParent={() => {
                    const parentId = sessions.find(s => s.id === currentSessionId)?.parent_session_id;
                    if (parentId) handleSessionSelect(parentId);
                  }}
                  compact
                />
              )}
              {currentSessionId && sessions.find(s => s.id === currentSessionId)?.github_repo && (
                <GitHubRepoIndicator repoName={sessions.find(s => s.id === currentSessionId)?.github_repo || ''} />
              )}
              {currentSessionId && sessions.find(s => s.id === currentSessionId)?.working_directory && (
                <WorkingDirectoryDisplay
                  directory={sessions.find(s => s.id === currentSessionId)?.working_directory || ''}
                  sessionId={currentSessionId}
                  onChangeDirectory={handleChangeDirectory}
                />
              )}
              <NotificationToggle />
              <div style={{ position: 'relative' }}>
                <ChatSearchButton onClick={() => {
                  if (isSearchOpen) {
                    setSearchFocusKey(k => k + 1);
                  } else {
                    setIsSearchOpen(true);
                  }
                }} />
                {isSearchOpen && (
                  <ChatSearchBar
                    query={chatSearch.query}
                    onQueryChange={chatSearch.setQuery}
                    currentMatchIndex={chatSearch.currentMatchIndex}
                    totalMatches={chatSearch.totalMatches}
                    onNext={chatSearch.goToNext}
                    onPrevious={chatSearch.goToPrevious}
                    onClose={() => {
                      setIsSearchOpen(false);
                      chatSearch.clearSearch();
                    }}
                    focusTrigger={searchFocusKey}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

        {messages.length === 0 ? (
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
            onOpenBuildWizard={() => setIsBuildWizardOpen(true)}
            mode={currentSessionMode}
            onRepoSelected={handleRepoSelected}
            selectedRepo={selectedRepo}
            selectedModel={selectedModel}
            onDirectorySelected={handleDirectorySelected}
            selectedDirectory={selectedDirectory}
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
            )}
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
          onClose={() => { setBranchDialogOpen(false); setBranchingSessionId(null); }}
          onConfirm={handleBranchConfirm}
          parentSessionTitle={
            sessions.find(s => s.id === branchingSessionId)?.title || 'Chat'
          }
          currentModel={selectedModel}
        />
      )}

      {messages.length > 0 && <ScrollButton scrollContainerRef={scrollContainerRef} />}
    </div>
  );
}
