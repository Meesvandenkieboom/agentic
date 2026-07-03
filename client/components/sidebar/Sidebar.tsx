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

import React, { useState, useRef, useEffect } from 'react';
import { Menu, Edit3, Search, Trash2, Check, Edit, FolderOpen, Github, Loader2, LogOut, Settings as SettingsIcon, GitBranch, Download, Upload } from 'lucide-react';
import { toast } from '../../utils/toast';
import { GitHubOAuthSetupModal } from '../setup/GitHubOAuthSetupModal';
import { Settings } from '../settings/Settings';

interface Chat {
  id: string;
  title: string;
  timestamp: Date;
  isActive?: boolean;
  isLoading?: boolean;
  parentSessionId?: string;
  branchCount?: number;
}

interface GitHubStatus {
  connected: boolean;
  configured: boolean;
  user?: {
    login: string;
    name: string | null;
    avatar_url: string;
  };
  message?: string;
}

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  chats?: Chat[];
  onNewChat?: () => void;
  onChatSelect?: (chatId: string) => void;
  onChatDelete?: (chatId: string) => void;
  onChatRename?: (chatId: string, newTitle: string) => void;
  onChatBranch?: (chatId: string) => void;
  onChatImport?: (file: File) => void;
  currentSessionId?: string | null;
}

export function Sidebar({ isOpen, onToggle, chats = [], onNewChat, onChatSelect, onChatDelete, onChatRename, onChatBranch, onChatImport, currentSessionId: _currentSessionId }: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isAllChatsExpanded, setIsAllChatsExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [isLoadingGithub, setIsLoadingGithub] = useState(false);
  const [isHoveringGithub, setIsHoveringGithub] = useState(false);
  const [showGitHubSetup, setShowGitHubSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Check GitHub status on mount
  useEffect(() => {
    checkGithubStatus();
  }, []);


  const checkGithubStatus = async () => {
    try {
      const response = await fetch('/api/github/status');
      const data = await response.json() as GitHubStatus;
      setGithubStatus(data);
    } catch (error) {
      console.error('Failed to check GitHub status:', error);
    }
  };

  const handleGithubConnect = async () => {
    if (isLoadingGithub) return;

    if (githubStatus?.connected) {
      // Disconnect
      setIsLoadingGithub(true);
      try {
        await fetch('/api/github/disconnect', { method: 'POST' });
        setGithubStatus({ connected: false, configured: true });
        toast.success('Disconnected from GitHub');
      } catch {
        toast.error('Failed to disconnect from GitHub');
      } finally {
        setIsLoadingGithub(false);
      }
      return;
    }

    // Start OAuth flow
    setIsLoadingGithub(true);
    try {
      const response = await fetch('/api/github/auth');
      const data = await response.json() as { success: boolean; authUrl?: string; error?: string };

      if (data.success && data.authUrl) {
        // Open GitHub auth in same window (will redirect back)
        window.location.href = data.authUrl;
      } else {
        // OAuth not configured - show setup modal instead of error
        setShowGitHubSetup(true);
        setIsLoadingGithub(false);
      }
    } catch {
      toast.error('Failed to start GitHub connection');
      setIsLoadingGithub(false);
    }
  };

  // Check for OAuth callback in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const githubConnected = params.get('github_connected');
    const githubError = params.get('github_error');

    if (githubConnected === 'true') {
      toast.success('Connected to GitHub!');
      checkGithubStatus();
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (githubError) {
      toast.error('GitHub connection failed', {
        description: githubError
      });
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Group chats by date
  const groupChatsByDate = (chats: Chat[]) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const groups: { [key: string]: Chat[] } = {
      Today: [],
      Yesterday: [],
      'Previous 7 Days': [],
      'Previous 30 Days': [],
      Older: []
    };

    chats.forEach(chat => {
      const chatDate = new Date(chat.timestamp);
      const chatDay = new Date(chatDate.getFullYear(), chatDate.getMonth(), chatDate.getDate());

      const diffTime = today.getTime() - chatDay.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        groups.Today.push(chat);
      } else if (diffDays === 1) {
        groups.Yesterday.push(chat);
      } else if (diffDays <= 7) {
        groups['Previous 7 Days'].push(chat);
      } else if (diffDays <= 30) {
        groups['Previous 30 Days'].push(chat);
      } else {
        groups.Older.push(chat);
      }
    });

    return groups;
  };

  const filteredChats = chats.filter(chat =>
    chat.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const groupedChats = groupChatsByDate(filteredChats);

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const handleRenameClick = (chat: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(chat.id);
    setEditingTitle(chat.title);
  };

  const handleRenameSubmit = (chatId: string) => {
    const currentChat = chats.find(c => c.id === chatId);
    const newTitle = editingTitle.trim();

    if (!newTitle) {
      setEditingId(null);
      setEditingTitle('');
      return;
    }

    if (newTitle.length > 60) {
      toast.error('Title too long', {
        description: 'Title must be 60 characters or less'
      });
      return;
    }

    if (newTitle !== currentChat?.title) {
      onChatRename?.(chatId, newTitle);
    }

    setEditingId(null);
    setEditingTitle('');
  };

  const handleRenameCancel = () => {
    setEditingId(null);
    setEditingTitle('');
  };

  const handleDeleteClick = (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDeleteId === chatId) {
      setConfirmDeleteId(null);
      onChatDelete?.(chatId);
    } else {
      setConfirmDeleteId(chatId);
    }
  };

  const handleBranchClick = (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChatBranch?.(chatId);
  };

  const handleExportClick = async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await fetch(`/api/sessions/${chatId}/export`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      const filename = disposition?.match(/filename="(.+)"/)?.[1] || 'chat.agentic.json';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error('Failed to export chat', {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  };

  const handleImportFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onChatImport?.(file);
    e.target.value = ''; // allow re-importing the same file
  };

  const handleOpenChatFolder = async () => {
    try {
      const response = await fetch('/api/open-chat-folder', {
        method: 'POST',
      });

      const data = await response.json();

      if (data.success) {
        toast.success('Opened chat folder', {
          description: data.path
        });
      } else {
        toast.error('Failed to open chat folder', {
          description: data.error || 'Unknown error'
        });
      }
    } catch (error) {
      toast.error('Failed to open chat folder', {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  };

  return (
    <div className={`sidebar ${isOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <div className="sidebar-container">
        {/* Header */}
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <object type="image/svg+xml" data="/client/agentic-icon.svg" className="sidebar-logo-icon" aria-label="Agentic">Agentic</object>
          </div>
          <button className="sidebar-toggle-btn" onClick={onToggle} aria-label="Toggle Sidebar">
            <Menu size={24} opacity={0.8} className={isOpen ? '' : 'rotate-180'} />
          </button>
        </div>

        {/* New Chat Button */}
        <button className="sidebar-new-chat-btn" onClick={onNewChat}>
          <Edit3 size={20} opacity={0.8} />
          <span>New Chat</span>
        </button>

        {/* Open Chat Folder Button */}
        <button className="sidebar-new-chat-btn" onClick={handleOpenChatFolder} style={{ marginTop: '0.5rem' }}>
          <FolderOpen size={20} opacity={0.8} />
          <span>Open Chat Folder</span>
        </button>

        {/* Import Chat Button */}
        <button className="sidebar-new-chat-btn" onClick={() => importInputRef.current?.click()} style={{ marginTop: '0.5rem' }}>
          <Upload size={20} opacity={0.8} />
          <span>Import Chat</span>
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={handleImportFileSelected}
        />

        {/* GitHub Connect Button */}
        <button
          className={`sidebar-new-chat-btn ${githubStatus?.connected ? (isHoveringGithub ? 'sidebar-github-disconnect' : 'sidebar-github-connected') : ''}`}
          onClick={handleGithubConnect}
          onMouseEnter={() => setIsHoveringGithub(true)}
          onMouseLeave={() => setIsHoveringGithub(false)}
          style={{ marginTop: '0.5rem' }}
          disabled={isLoadingGithub}
        >
          {isLoadingGithub ? (
            <Loader2 size={20} opacity={0.8} className="animate-spin" />
          ) : githubStatus?.connected && isHoveringGithub ? (
            <LogOut size={20} opacity={0.8} />
          ) : (
            <Github size={20} opacity={0.8} />
          )}
          <span>
            {isLoadingGithub
              ? (githubStatus?.connected ? 'Disconnecting...' : 'Connecting...')
              : githubStatus?.connected
                ? (isHoveringGithub ? 'Disconnect' : `${githubStatus.user?.login || 'Connected'}`)
                : 'Connect to GitHub'}
          </span>
        </button>

        {/* Settings Button */}
        <button
          className="sidebar-new-chat-btn"
          onClick={() => setShowSettings(true)}
          style={{ marginTop: '0.5rem' }}
        >
          <SettingsIcon size={20} opacity={0.8} />
          <span>Settings</span>
        </button>

        {/* Search */}
        <div className="sidebar-search-container">
          <div className="sidebar-search">
            <div className="sidebar-search-icon">
              <Search size={16} />
            </div>
            <input
              className="sidebar-search-input"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Chat List */}
        <div className="sidebar-chat-list">
          {/* All Chats Dropdown */}
          <div className="sidebar-section-header">
            <button
              className="sidebar-section-toggle"
              onClick={() => setIsAllChatsExpanded(!isAllChatsExpanded)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="2.5"
                stroke="currentColor"
                className="sidebar-chevron"
                style={{ transform: isAllChatsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
              <span>All Chats</span>
            </button>
          </div>

          {/* Chat Groups */}
          {isAllChatsExpanded && (
            <div className="sidebar-chat-groups">
              {Object.entries(groupedChats).map(([groupName, groupChats]) => {
                if (groupChats.length === 0) return null;

                return (
                  <div key={groupName} className="sidebar-chat-group">
                    <div className="sidebar-group-label">{groupName}</div>
                    {groupChats.map((chat) => (
                      <div key={chat.id} className="sidebar-chat-item-wrapper group" style={{ position: 'relative' }}>
                        {editingId === chat.id ? (
                          <div style={{ padding: '0.5rem' }}>
                            <input
                              ref={inputRef}
                              type="text"
                              value={editingTitle}
                              maxLength={60}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  handleRenameSubmit(chat.id);
                                } else if (e.key === 'Escape') {
                                  handleRenameCancel();
                                }
                              }}
                              onBlur={() => handleRenameSubmit(chat.id)}
                              placeholder="Chat title"
                              style={{
                                width: '100%',
                                padding: '0.5rem',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '0.375rem',
                                color: 'rgb(var(--text-primary))',
                                fontSize: '0.875rem',
                              }}
                            />
                          </div>
                        ) : (
                          <>
                            <button
                              className={`sidebar-chat-item ${chat.isActive ? 'sidebar-chat-item-active' : ''}`}
                              onClick={() => onChatSelect?.(chat.id)}
                              title={chat.title}
                            >
                              <div className="sidebar-chat-title" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                {/* Branch indicator for branched chats */}
                                {chat.parentSessionId && (
                                  <GitBranch size={12} className="text-[rgb(165,180,252)] flex-shrink-0" />
                                )}
                                <span className="truncate">{chat.title}</span>
                                {/* Branch count badge */}
                                {chat.branchCount !== undefined && chat.branchCount > 0 && (
                                  <span style={{
                                    marginLeft: '0.25rem',
                                    padding: '0.125rem 0.375rem',
                                    fontSize: '0.625rem',
                                    fontWeight: 600,
                                    backgroundColor: 'rgba(99, 102, 241, 0.2)',
                                    color: 'rgb(165, 180, 252)',
                                    borderRadius: '9999px',
                                    flexShrink: 0,
                                  }}>
                                    {chat.branchCount}
                                  </span>
                                )}
                                {chat.isLoading && (
                                  <span style={{
                                    marginLeft: '0.5rem',
                                    display: 'inline-flex',
                                    gap: '2px',
                                    alignItems: 'center',
                                  }}>
                                    <span style={{
                                      width: '3px',
                                      height: '3px',
                                      backgroundColor: 'rgb(var(--text-secondary))',
                                      borderRadius: '50%',
                                      animation: 'pulse 1.4s ease-in-out infinite',
                                      animationDelay: '0s',
                                      opacity: 0.6,
                                    }}></span>
                                    <span style={{
                                      width: '3px',
                                      height: '3px',
                                      backgroundColor: 'rgb(var(--text-secondary))',
                                      borderRadius: '50%',
                                      animation: 'pulse 1.4s ease-in-out infinite',
                                      animationDelay: '0.2s',
                                      opacity: 0.6,
                                    }}></span>
                                    <span style={{
                                      width: '3px',
                                      height: '3px',
                                      backgroundColor: 'rgb(var(--text-secondary))',
                                      borderRadius: '50%',
                                      animation: 'pulse 1.4s ease-in-out infinite',
                                      animationDelay: '0.4s',
                                      opacity: 0.6,
                                    }}></span>
                                  </span>
                                )}
                              </div>
                            </button>
                            <div className={`sidebar-chat-menu ${chat.isActive ? '' : 'sidebar-chat-menu-hidden'}`} style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                              <button
                                className="sidebar-chat-menu-btn"
                                aria-label="Rename Chat"
                                onClick={(e) => handleRenameClick(chat, e)}
                                style={{
                                  padding: '0.25rem',
                                  background: chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))',
                                  border: 'none',
                                  borderRadius: '0.25rem',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: 'rgb(var(--text-secondary))',
                                  transition: 'all 0.15s',
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                                  e.currentTarget.style.color = 'rgb(var(--text-primary))';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))';
                                  e.currentTarget.style.color = 'rgb(var(--text-secondary))';
                                }}
                              >
                                <Edit size={14} />
                              </button>
                              <button
                                className="sidebar-chat-menu-btn"
                                aria-label="Branch Chat"
                                title="Create a branch from this chat"
                                onClick={(e) => handleBranchClick(chat.id, e)}
                                style={{
                                  padding: '0.25rem',
                                  background: chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))',
                                  border: 'none',
                                  borderRadius: '0.25rem',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: 'rgb(var(--text-secondary))',
                                  transition: 'all 0.15s',
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = 'rgba(99, 102, 241, 0.15)';
                                  e.currentTarget.style.color = 'rgb(165, 180, 252)';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))';
                                  e.currentTarget.style.color = 'rgb(var(--text-secondary))';
                                }}
                              >
                                <GitBranch size={14} />
                              </button>
                              <button
                                className="sidebar-chat-menu-btn"
                                aria-label="Export Chat"
                                title="Download this chat as a file"
                                onClick={(e) => handleExportClick(chat.id, e)}
                                style={{
                                  padding: '0.25rem',
                                  background: chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))',
                                  border: 'none',
                                  borderRadius: '0.25rem',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: 'rgb(var(--text-secondary))',
                                  transition: 'all 0.15s',
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                                  e.currentTarget.style.color = 'rgb(var(--text-primary))';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))';
                                  e.currentTarget.style.color = 'rgb(var(--text-secondary))';
                                }}
                              >
                                <Download size={14} />
                              </button>
                              <button
                                className="sidebar-chat-menu-btn"
                                aria-label={confirmDeleteId === chat.id ? 'Confirm Delete' : 'Delete Chat'}
                                title={confirmDeleteId === chat.id ? 'Click again to confirm' : 'Delete Chat'}
                                onClick={(e) => handleDeleteClick(chat.id, e)}
                                style={{
                                  padding: '0.25rem',
                                  background: confirmDeleteId === chat.id
                                    ? 'rgba(239, 68, 68, 0.25)'
                                    : chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))',
                                  border: 'none',
                                  borderRadius: '0.25rem',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: confirmDeleteId === chat.id ? '#ef4444' : 'rgb(var(--text-secondary))',
                                  transition: 'all 0.15s',
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
                                  e.currentTarget.style.color = '#ef4444';
                                }}
                                onMouseLeave={(e) => {
                                  setConfirmDeleteId(null);
                                  e.currentTarget.style.background = chat.isActive ? 'rgb(var(--bg-tertiary))' : 'rgb(var(--bg-secondary))';
                                  e.currentTarget.style.color = 'rgb(var(--text-secondary))';
                                }}
                              >
                                {confirmDeleteId === chat.id ? <Check size={14} /> : <Trash2 size={14} />}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* GitHub OAuth Setup Modal */}
      {showGitHubSetup && (
        <GitHubOAuthSetupModal
          onComplete={() => {
            setShowGitHubSetup(false);
            // Retry OAuth flow after successful setup
            handleGithubConnect();
          }}
          onClose={() => setShowGitHubSetup(false)}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
