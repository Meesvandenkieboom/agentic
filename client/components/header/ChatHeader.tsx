/**
 * ChatHeader — Top navigation bar
 *
 * Renders the logo, model selector, branch indicator, GitHub repo,
 * working directory, notification toggle, and search bar.
 */

import React from 'react';
import { ModelSelector } from './ModelSelector';
import { WorkingDirectoryDisplay } from './WorkingDirectoryDisplay';
import { GitHubRepoIndicator } from './GitHubRepoIndicator';
import { ChatSearchButton } from './ChatSearchButton';
import { ChatSearchBar } from './ChatSearchBar';
import { NotificationToggle } from './NotificationToggle';
import { BranchIndicator } from '../chat/BranchIndicator';
import { Menu, Edit3 } from 'lucide-react';
import type { Session } from '../../hooks/useSessionAPI';

interface ChatSearchAPI {
  query: string;
  setQuery: (q: string) => void;
  currentMatchIndex: number;
  totalMatches: number;
  goToNext: () => void;
  goToPrevious: () => void;
  clearSearch: () => void;
}

interface ChatHeaderProps {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  hasMessages: boolean;
  currentSessionId: string | null;
  sessions: Session[];
  onSessionSelect: (sessionId: string) => void;
  onChangeDirectory: (sessionId: string, newDir: string) => Promise<void>;
  isSearchOpen: boolean;
  onToggleSearch: () => void;
  searchFocusKey: number;
  chatSearch: ChatSearchAPI;
  onCloseSearch: () => void;
}

export function ChatHeader({
  isSidebarOpen,
  onToggleSidebar,
  onNewChat,
  selectedModel,
  onModelChange,
  hasMessages,
  currentSessionId,
  sessions,
  onSessionSelect,
  onChangeDirectory,
  isSearchOpen,
  onToggleSearch,
  searchFocusKey,
  chatSearch,
  onCloseSearch,
}: ChatHeaderProps) {
  const currentSession = sessions.find(s => s.id === currentSessionId);
  const parentSession = currentSession?.parent_session_id
    ? sessions.find(s => s.id === currentSession.parent_session_id)
    : null;

  return (
    <nav className="header">
      <div className="header-content">
        <div className="header-inner">
          <div className="header-left">
            {!isSidebarOpen && (
              <>
                <button className="header-btn" aria-label="Toggle Sidebar" onClick={onToggleSidebar}>
                  <Menu />
                </button>
                <button className="header-btn" aria-label="New Chat" onClick={onNewChat}>
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
                    onModelChange={onModelChange}
                    hasMessages={hasMessages}
                    disabled={hasMessages}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="header-right">
            {parentSession && (
              <BranchIndicator
                parentSessionTitle={parentSession.title || 'Parent'}
                parentSessionId={parentSession.id}
                onNavigateToParent={() => onSessionSelect(parentSession.id)}
                compact
              />
            )}
            {currentSession?.github_repo && (
              <GitHubRepoIndicator repoName={currentSession.github_repo} />
            )}
            {currentSessionId && currentSession?.working_directory && (
              <WorkingDirectoryDisplay
                directory={currentSession.working_directory}
                sessionId={currentSessionId}
                onChangeDirectory={onChangeDirectory}
              />
            )}
            <NotificationToggle />
            <div style={{ position: 'relative' }}>
              <ChatSearchButton onClick={onToggleSearch} />
              {isSearchOpen && (
                <ChatSearchBar
                  query={chatSearch.query}
                  onQueryChange={chatSearch.setQuery}
                  currentMatchIndex={chatSearch.currentMatchIndex}
                  totalMatches={chatSearch.totalMatches}
                  onNext={chatSearch.goToNext}
                  onPrevious={chatSearch.goToPrevious}
                  onClose={onCloseSearch}
                  focusTrigger={searchFocusKey}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
