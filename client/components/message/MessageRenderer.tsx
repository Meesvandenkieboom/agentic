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

import React from 'react';
import { Message } from './types';
import { UserMessage } from './UserMessage';
import { SystemMessage } from './SystemMessage';
import { AssistantMessage } from './AssistantMessage';

interface MessageRendererProps {
  message: Message;
}

// Memoize MessageRenderer to prevent unnecessary re-renders
// Messages only re-render when their content actually changes
export const MessageRenderer = React.memo(function MessageRenderer({ message }: MessageRendererProps) {
  switch (message.type) {
    case 'user':
      return <UserMessage message={message} />;

    case 'system':
      return <SystemMessage message={message} />;

    case 'assistant':
      return <AssistantMessage message={message} />;

    default: {
      const unknownMessage = message as { type: string };
      return (
        <div className="mb-4 p-4 bg-red-50 border-l-4 border-red-400 rounded-r-lg">
          <div className="text-red-700">
            Unknown message type: {unknownMessage.type}
          </div>
          <pre className="text-sm mt-2 text-gray-600">
            {JSON.stringify(message, null, 2)}
          </pre>
        </div>
      );
    }
  }
}, (prevProps, nextProps) => {
  // Custom comparison: avoid JSON.stringify during streaming for performance
  if (prevProps.message.id !== nextProps.message.id) return false;
  if (prevProps.message.type !== nextProps.message.type) return false;

  // For assistant messages, use shallow + tail comparison instead of full JSON.stringify
  if (nextProps.message.type === 'assistant' && prevProps.message.type === 'assistant') {
    const prevContent = prevProps.message.content;
    const nextContent = nextProps.message.content;

    // Different number of blocks = definitely changed
    if (prevContent.length !== nextContent.length) return false;
    if (prevContent.length === 0) return true;

    // Compare the LAST block only (the one actively streaming)
    const prevLast = prevContent[prevContent.length - 1];
    const nextLast = nextContent[nextContent.length - 1];

    if (prevLast.type !== nextLast.type) return false;

    if (prevLast.type === 'text' && nextLast.type === 'text') {
      return prevLast.text === nextLast.text;
    }
    if (prevLast.type === 'thinking' && nextLast.type === 'thinking') {
      return prevLast.thinking === nextLast.thinking;
    }
    if (prevLast.type === 'tool_use' && nextLast.type === 'tool_use') {
      // Tool use blocks: compare id + nested tools length
      if (prevLast.id !== nextLast.id) return false;
      const prevNested = prevLast.nestedTools?.length ?? 0;
      const nextNested = nextLast.nestedTools?.length ?? 0;
      return prevNested === nextNested;
    }

    // For other block types, fall back to reference equality
    return prevLast === nextLast;
  }

  // For user/system messages, compare content directly
  return prevProps.message.content === nextProps.message.content;
});

export * from './types';
export { UserMessage } from './UserMessage';
export { SystemMessage } from './SystemMessage';
export { AssistantMessage } from './AssistantMessage';