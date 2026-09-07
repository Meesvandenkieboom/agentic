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

import React, { useState } from 'react';
import { FileText, GitBranch } from 'lucide-react';
import { UserMessage as UserMessageType, UserToolResultMessage } from './types';
import { showError } from '../../utils/errorMessages';
import { CommandTextRenderer } from './CommandTextRenderer';
import { dispatchBranchFromMessage } from '../../utils/branchEvents';

interface UserMessageProps {
  message: UserMessageType | UserToolResultMessage;
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

// Filter out hidden image and file path references
function filterImagePathReferences(text: string): string {
  return text
    .split('\n')
    .filter(line => {
      // Filter out image paths
      if (line.match(/^\[Image attached: \.\/pictures\/.*\]$/)) return false;
      // Filter out file paths
      if (line.match(/^\[File attached: \.\/files\/.*\]$/)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

export function UserMessage({ message }: UserMessageProps) {
  const [copied, setCopied] = useState(false);

  // Handle copy to clipboard
  const handleCopy = async () => {
    const userMessage = message as UserMessageType;
    const text = filterImagePathReferences(userMessage.content);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      showError('COPY_FAILED', errorMsg);
    }
  };
  const isToolResult = 'content' in message && Array.isArray(message.content) &&
    message.content.some(c => typeof c === 'object' && 'tool_use_id' in c);

  if (isToolResult) {
    const toolResultMessage = message as UserToolResultMessage;
    return (
      <div className="mb-3 p-3 bg-gray-50 border border-gray-300">
        <div className="flex justify-between items-start mb-2">
          <div className="flex items-center">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Tool Result</span>
          </div>
          <span className="text-xs text-gray-400">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
        
        {toolResultMessage.content.map((result, index) => (
          <div key={index} className="mt-2">
            <div className="text-xs text-gray-500 mb-1 font-mono">
              ID: {result.tool_use_id}
            </div>
            <pre className="text-xs bg-white p-2 border border-gray-200 overflow-x-auto whitespace-pre-wrap font-mono">
              {result.content}
            </pre>
          </div>
        ))}
      </div>
    );
  }

  const userMessage = message as UserMessageType;

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="message-container group">
      <div className="message-user-wrapper">
        <div className="message-user-content">
          <div className="message-user-inner">
            <div className="message-user-bubble-wrapper">
              {/* File attachments */}
              {userMessage.attachments && userMessage.attachments.length > 0 && (
                <div className="flex overflow-x-auto flex-col flex-wrap gap-1 justify-end mt-2.5 mb-1 w-full">
                  <div className="self-end">
                    {userMessage.attachments.map((file) => (
                      <a
                        key={file.id}
                        href={file.preview}
                        download={file.preview ? file.name : undefined}
                        aria-label={`Download ${file.name}`}
                        aria-disabled={!file.preview}
                        className="attachment-card"
                        title={file.name}
                      >
                        <span className="attachment-card-thumbnail">
                          {file.preview && file.type.startsWith('image/') ? (
                            <img src={file.preview} alt={file.name} loading="lazy" draggable="false" />
                          ) : <FileText size={24} aria-hidden="true" />}
                        </span>
                        <span className="attachment-card-details">
                          <span className="attachment-card-name">{file.name}</span>
                          <span className="attachment-card-meta">
                            <span>{file.name.includes('.') ? file.name.split('.').pop() : 'File'}</span>
                            <span>{formatFileSize(file.size)}</span>
                          </span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {filterImagePathReferences(userMessage.content) && (
                <div className="message-user-bubble-container">
                  <div className="message-user-bubble">
                    <CommandTextRenderer content={filterImagePathReferences(userMessage.content)} />
                  </div>
                </div>
              )}
              <div className="message-user-actions">
                <button
                  onClick={handleCopy}
                  className="message-action-btn"
                  aria-label={copied ? "Copied!" : "Copy"}
                  title={copied ? "Copied!" : "Copy message"}
                >
                  {copied ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="size-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 18 18" strokeWidth="1.5" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.875 4.66161V2.92944C4.875 2.34696 5.3472 1.87476 5.92969 1.87476H15.0703C15.6528 1.87476 16.125 2.34696 16.125 2.92944V12.0701C16.125 12.6526 15.6528 13.1248 15.0703 13.1248H13.3186" />
                      <path strokeLinejoin="round" d="M12.0703 4.87476H2.92969C2.3472 4.87476 1.875 5.34696 1.875 5.92944V15.0701C1.875 15.6526 2.3472 16.1248 2.92969 16.1248H12.0703C12.6528 16.1248 13.125 15.6526 13.125 15.0701V5.92944C13.125 5.34696 12.6528 4.87476 12.0703 4.87476Z" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={() => dispatchBranchFromMessage(message.id)}
                  className="message-action-btn"
                  aria-label="Branch from here"
                  title="Branch chat from here"
                >
                  <GitBranch className="size-4" strokeWidth={1.5} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}