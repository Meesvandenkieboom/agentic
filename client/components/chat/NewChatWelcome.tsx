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

import React, { useRef, useState, useEffect } from 'react';
import { Send, Plus, Square, FileUp, Github, ChevronDown, GitBranch, FolderOpen, Loader2 } from 'lucide-react';
import type { FileAttachment } from '../message/types';
import { filesToAttachments, isCommandDraft } from '../../utils/attachments';
import { AttachmentChips } from './AttachmentChips';
import { ModeIndicator } from './ModeIndicator';
import type { SlashCommand } from '../../hooks/useWebSocket';
import { CommandTextRenderer } from '../message/CommandTextRenderer';
import { GitHubRepoSelector } from './GitHubRepoSelector';
import { ReasoningEffortSelector, type ReasoningEffort } from './ReasoningEffortSelector';
import { getModelConfig } from '../../config/models';

interface NewChatWelcomeProps {
  /** Returns true if the message was sent, so the input can clear its draft. */
  onSubmit: (text: string, files?: FileAttachment[], mode?: 'general' | 'coder' | 'intense-research' | 'spark' | 'hive') => Promise<boolean> | boolean;
  onStop?: () => void;
  disabled?: boolean;
  isGenerating?: boolean;
  /** True while a GitHub repo is being cloned during chat creation. Shows spinner on send button. */
  isCloning?: boolean;
  isPlanMode?: boolean;
  onTogglePlanMode?: () => void;
  availableCommands?: SlashCommand[];
  onOpenBuildWizard?: () => void;
  mode?: 'general' | 'coder' | 'intense-research' | 'spark' | 'hive';
  onRepoSelected?: (repoUrl: string, repoName: string) => void;
  selectedRepo?: { url: string; name: string } | null;
  selectedModel?: string;
  onDirectorySelected?: (path: string) => void;
  selectedDirectory?: string | null;
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
}

const CAPABILITIES = [
  "I can build websites for you",
  "I can research anything you want",
  "I can debug and fix your code",
  "I can automate repetitive tasks",
  "I can analyze data and files"
];

export function NewChatWelcome({ onSubmit, onStop, disabled, isGenerating, isCloning, isPlanMode, onTogglePlanMode, availableCommands = [], onOpenBuildWizard: _onOpenBuildWizard, mode, onRepoSelected, selectedRepo, selectedModel, onDirectorySelected, selectedDirectory, reasoningEffort, onReasoningEffortChange }: NewChatWelcomeProps) {
  const [inputValue, setInputValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<FileAttachment[]>([]);
  const [_isDraggingOver, setIsDraggingOver] = useState(false);
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [isRepoSelectorOpen, setIsRepoSelectorOpen] = useState(false);
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);

  const handlePickDirectory = async () => {
    if (!onDirectorySelected) return;
    setIsPickingDirectory(true);
    try {
      const response = await fetch(`${window.location.protocol}//${window.location.host}/api/pick-directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await response.json() as { success: boolean; path?: string; cancelled?: boolean; error?: string };
      if (result.success && result.path) {
        onDirectorySelected(result.path);
      }
    } catch (error) {
      console.error('Directory picker error:', error);
    } finally {
      setIsPickingDirectory(false);
    }
  };

  // Effective mode (falls back to 'general' if parent hasn't set one yet)
  const effectiveMode: 'general' | 'coder' | 'intense-research' | 'spark' | 'hive' = mode || 'general';
  const [modeIndicatorWidth, setModeIndicatorWidth] = useState(80);

  // Slash command autocomplete state
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);

  // Detect "/" at start of input for command autocomplete
  useEffect(() => {
    if (inputValue.startsWith('/') && availableCommands.length > 0) {
      const searchTerm = inputValue.slice(1).toLowerCase();
      const filtered = availableCommands.filter(cmd =>
        cmd.name.toLowerCase().includes(searchTerm)
      );
      setFilteredCommands(filtered);
      setShowCommandMenu(filtered.length > 0);
      setSelectedCommandIndex(0);
    } else {
      setShowCommandMenu(false);
    }
  }, [inputValue, availableCommands]);

  // Typewriter effect state
  const [currentCapabilityIndex, setCurrentCapabilityIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState('');
  const [isTyping, setIsTyping] = useState(true);

  // User config state
  const [userName, setUserName] = useState<string | null>(null);

  // Load user config on mount
  useEffect(() => {
    fetch('/api/user-config')
      .then(res => res.json())
      .then(data => {
        if (data.displayName) {
          setUserName(data.displayName);
        }
      })
      .catch(err => {
        console.error('Failed to load user config:', err);
      });
  }, []);

  // Auto-focus on mount with slight delay to ensure DOM is ready
  useEffect(() => {
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Close plus menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setIsPlusMenuOpen(false);
      }
    };

    if (isPlusMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isPlusMenuOpen]);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to recalculate
    textarea.style.height = '72px';

    // Set height based on scrollHeight, capped at max
    const newHeight = Math.min(textarea.scrollHeight, 360);
    textarea.style.height = `${newHeight}px`;
  }, [inputValue]);

  // Typewriter effect
  useEffect(() => {
    const currentText = CAPABILITIES[currentCapabilityIndex];

    if (isTyping) {
      if (displayedText.length < currentText.length) {
        const timer = setTimeout(() => {
          setDisplayedText(currentText.slice(0, displayedText.length + 1));
        }, 50);
        return () => clearTimeout(timer);
      } else {
        // Finished typing, wait before erasing
        const timer = setTimeout(() => {
          setIsTyping(false);
        }, 2000);
        return () => clearTimeout(timer);
      }
    } else {
      // Erasing
      if (displayedText.length > 0) {
        const timer = setTimeout(() => {
          setDisplayedText(displayedText.slice(0, -1));
        }, 30);
        return () => clearTimeout(timer);
      } else {
        // Finished erasing, move to next capability
        setCurrentCapabilityIndex((prev) => (prev + 1) % CAPABILITIES.length);
        setIsTyping(true);
      }
    }
  }, [displayedText, isTyping, currentCapabilityIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle command menu navigation
    if (showCommandMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCommandIndex(prev =>
          prev < filteredCommands.length - 1 ? prev + 1 : prev
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCommandIndex(prev => (prev > 0 ? prev - 1 : prev));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const selectedCommand = filteredCommands[selectedCommandIndex];
        if (selectedCommand) {
          const commandWithSlash = `/${selectedCommand.name} `;
          setInputValue(commandWithSlash);
          setShowCommandMenu(false);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowCommandMenu(false);
        return;
      }
    }

    // Normal submit handling
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handleSubmit = async () => {
    const sent = await onSubmit(inputValue, attachedFiles.length > 0 ? attachedFiles : undefined, effectiveMode);
    if (sent) {
      setInputValue('');
      setAttachedFiles([]);
    }
  };

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const attachments = await filesToAttachments(files);
    setAttachedFiles((prev) => [...prev, ...attachments]);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const attachments = await filesToAttachments(files);
    setAttachedFiles((prev) => [...prev, ...attachments]);
  };

  // Handle paste events for files (screenshots, copied files) — plain text falls through
  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;

    e.preventDefault();

    const attachments = await filesToAttachments(files);
    setAttachedFiles((prev) => [...prev, ...attachments]);
  };

  // Only real slash-command drafts get the pill overlay (see isCommandDraft)
  const commandDraft = isCommandDraft(inputValue, availableCommands);

  return (
    <div
      className="flex-1 flex items-center justify-center w-full"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="w-full max-w-4xl px-4">
        {/* Greeting */}
        <div className="flex flex-col gap-1 justify-center items-center mb-8">
          <div className="flex flex-row justify-center gap-3 w-fit px-5">
            <div className="text-[40px] font-semibold line-clamp-1 text-gradient">
              {userName ? `Hi, ${userName}. I'm Agentic` : "Hi. I'm Agentic"}
            </div>
          </div>

          {/* Typewriter capabilities */}
          <div className="flex justify-center items-center mt-2 h-8">
            <div className="text-lg text-gray-400 font-medium flex items-center">
              <span>{displayedText}</span>
              <span className="inline-block w-[3px] h-[18px] bg-gray-400 ml-0.5 animate-blink"></span>
            </div>
          </div>
        </div>

        {/* Input Container */}
        <div className="w-full max-w-[960px] mx-auto">
          {/* Slash Command Autocomplete Menu - Above input */}
          {showCommandMenu && filteredCommands.length > 0 && (
            <div className="mb-2 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden">
              <div className="max-h-[240px] overflow-y-auto scrollbar-hidden py-2">
                {filteredCommands.map((cmd, index) => (
                  <button
                    key={cmd.name}
                    type="button"
                    onClick={() => {
                      setInputValue(`/${cmd.name} `);
                      setShowCommandMenu(false);
                      textareaRef.current?.focus();
                    }}
                    onMouseEnter={() => setSelectedCommandIndex(index)}
                    className={`w-full text-left px-4 py-5 transition-colors cursor-pointer ${
                      index < filteredCommands.length - 1 ? 'border-b border-gray-700' : ''
                    } ${index === selectedCommandIndex ? 'bg-gray-700' : 'hover:bg-gray-700/50'}`}
                  >
                    <div className="font-mono text-sm text-blue-400">/{cmd.name}</div>
                    <div className="text-xs text-gray-400 mt-1">{cmd.description}</div>
                    {cmd.argumentHint && (
                      <div className="text-xs text-gray-500 mt-1 font-mono">{cmd.argumentHint}</div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-1.5 w-full">
            <div className="flex-1 flex flex-col relative w-full rounded-xl border-b-2 border-white/10 transition hover:bg-[#374151]" style={{ backgroundColor: 'rgb(38, 40, 42)' }}>
              {/* File attachments preview */}
              <AttachmentChips files={attachedFiles} onRemove={handleRemoveFile} />

              {/* Textarea */}
              <div className="overflow-hidden relative px-2.5">
                {/* Mode Indicator — hidden for default 'general' mode */}
                {effectiveMode !== 'general' && (
                  <ModeIndicator mode={effectiveMode} onWidthChange={setModeIndicatorWidth} />
                )}

                {/* Command Pill Overlay */}
                {commandDraft && (
                  <div
                    className="absolute px-1 pt-3 w-full text-sm pointer-events-none z-10 text-gray-100"
                    style={{
                      minHeight: '72px',
                      maxHeight: '360px',
                      overflowY: 'auto',
                      textIndent: effectiveMode !== 'general' ? `${modeIndicatorWidth}px` : '0px',
                      whiteSpace: 'pre-wrap',
                      wordWrap: 'break-word',
                    }}
                  >
                    <CommandTextRenderer content={inputValue} />
                  </div>
                )}

                <textarea
                  ref={textareaRef}
                  id="chat-input"
                  dir="auto"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder="How can I help you today?"
                  className="px-1 pt-3 w-full text-sm bg-transparent resize-none scrollbar-hidden outline-hidden placeholder:text-white/40"
                  style={{
                    minHeight: '72px',
                    maxHeight: '360px',
                    overflowY: 'auto',
                    textIndent: effectiveMode !== 'general' ? `${modeIndicatorWidth}px` : '0px',
                    color: commandDraft ? 'transparent' : 'rgb(243, 244, 246)',
                    caretColor: 'rgb(243, 244, 246)',
                  }}
                  disabled={disabled}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex justify-between items-center mx-3.5 mt-1.5 mb-3.5 max-w-full">
                <div className="self-end flex items-center gap-1.5">
                  {/* Plus button with dropdown menu */}
                  <div className="flex gap-1">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      onChange={handleFileChange}
                      style={{ display: 'none' }}
                    />

                    {/* Plus button dropdown */}
                    <div className="relative" ref={plusMenuRef}>
                      <button
                        onClick={() => setIsPlusMenuOpen(!isPlusMenuOpen)}
                        type="button"
                        className="border rounded-lg border-white/10 bg-transparent transition p-1.5 outline-none focus:outline-none text-white hover:bg-gray-800 flex items-center gap-0.5"
                        aria-label="Add files or repository"
                      >
                        <Plus className="size-4" />
                        <ChevronDown size={12} className={`transition-transform ${isPlusMenuOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {/* Dropdown menu */}
                      {isPlusMenuOpen && (
                        <div className="absolute bottom-full left-0 mb-2 w-48 bg-[#1a1c1e] border border-white/10 rounded-lg shadow-lg overflow-hidden z-50">
                          <button
                            onClick={() => {
                              handleFileClick();
                              setIsPlusMenuOpen(false);
                            }}
                            type="button"
                            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-200 hover:bg-white/5 transition-colors"
                          >
                            <FileUp size={18} className="text-gray-400" />
                            <span>Add Files</span>
                          </button>
                          <button
                            onClick={() => {
                              setIsRepoSelectorOpen(true);
                              setIsPlusMenuOpen(false);
                            }}
                            type="button"
                            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-200 hover:bg-white/5 transition-colors border-t border-white/5"
                          >
                            <Github size={18} className="text-gray-400" />
                            <span>GitHub Repository</span>
                          </button>
                          <button
                            onClick={() => {
                              handlePickDirectory();
                              setIsPlusMenuOpen(false);
                            }}
                            type="button"
                            disabled={isPickingDirectory}
                            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-200 hover:bg-white/5 transition-colors border-t border-white/5"
                          >
                            <FolderOpen size={18} className="text-gray-400" />
                            <span>{isPickingDirectory ? 'Selecting...' : 'Browse Directory'}</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Repository indicator */}
                    {selectedRepo && (
                      <div
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-gray-400"
                        title={selectedRepo.name}
                      >
                        <GitBranch size={12} className="text-gray-500" />
                        <span className="max-w-[120px] truncate">{selectedRepo.name.split('/')[1] || selectedRepo.name}</span>
                      </div>
                    )}

                    {/* Directory indicator */}
                    {selectedDirectory && (
                      <div
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-gray-400"
                        title={selectedDirectory}
                      >
                        <FolderOpen size={12} className="text-gray-500" />
                        <span className="max-w-[120px] truncate">{selectedDirectory.split('/').filter(Boolean).pop()}</span>
                      </div>
                    )}

                    {/* Plan Mode toggle button */}
                    {onTogglePlanMode && (
                      <button
                        onClick={onTogglePlanMode}
                        type="button"
                        className={`${isPlanMode ? 'send-button-active' : 'border border-white/10 bg-transparent text-white hover:bg-gray-800'} rounded-lg transition outline-none focus:outline-none`}
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          padding: '0.375rem 0.75rem',
                        }}
                        title={isPlanMode ? "Plan Mode Active - Click to deactivate" : "Activate Plan Mode"}
                        aria-label={isPlanMode ? "Deactivate Plan Mode" : "Activate Plan Mode"}
                      >
                        Plan Mode
                      </button>
                    )}

                    {/* Reasoning Effort selector */}
                    {reasoningEffort && onReasoningEffortChange && (
                      <ReasoningEffortSelector
                        effort={reasoningEffort}
                        onChange={onReasoningEffortChange}
                        provider={getModelConfig(selectedModel || '')?.provider}
                        welcomeStyle
                      />
                    )}
                  </div>
                </div>

                {/* Send/Stop Button */}
                <div className="flex self-end space-x-1 shrink-0">
                  {isGenerating ? (
                    <button
                      type="button"
                      onClick={onStop}
                      className="stop-button-active transition rounded-lg p-2 self-center"
                      aria-label="Stop Generating"
                    >
                      <Square className="size-4" fill="currentColor" />
                    </button>
                  ) : isCloning ? (
                    <button
                      type="button"
                      disabled
                      className="transition rounded-lg p-2 self-center bg-gray-500 text-white/60 cursor-not-allowed"
                      aria-label="Cloning repository"
                      aria-busy="true"
                      title="Cloning repository…"
                    >
                      <Loader2 className="size-4 animate-spin" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={disabled || !inputValue.trim()}
                      className={`transition rounded-lg p-2 self-center ${
                        !disabled && inputValue.trim()
                          ? 'send-button-active'
                          : 'bg-gray-500 text-white/40 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600'
                      }`}
                      aria-label="Send Message"
                    >
                      <Send className="size-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* GitHub Repository Selector Modal */}
      {isRepoSelectorOpen && (
        <GitHubRepoSelector
          onSelect={(repoUrl, repoName) => {
            setIsRepoSelectorOpen(false);
            onRepoSelected?.(repoUrl, repoName);
            // Focus textarea after modal closes
            setTimeout(() => {
              textareaRef.current?.focus();
            }, 100);
          }}
          onClose={() => setIsRepoSelectorOpen(false)}
        />
      )}
    </div>
  );
}
