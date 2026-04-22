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

import { useState, useEffect, useRef, useCallback } from 'react';
import { showError } from '../utils/errorMessages';

interface BaseWebSocketMessage {
  type: string;
  sessionId?: string;
}

interface AssistantMessageEvent extends BaseWebSocketMessage {
  type: 'assistant_message';
  content: string;
}

interface ToolUseEvent extends BaseWebSocketMessage {
  type: 'tool_use';
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface ResultEvent extends BaseWebSocketMessage {
  type: 'result';
}

interface ErrorEvent extends BaseWebSocketMessage {
  type: 'error';
  message?: string;
  error?: string;
}

interface UserMessageEvent extends BaseWebSocketMessage {
  type: 'user_message';
}

interface ExitPlanModeEvent extends BaseWebSocketMessage {
  type: 'exit_plan_mode';
  plan?: string;
}

interface PermissionModeChangedEvent extends BaseWebSocketMessage {
  type: 'permission_mode_changed';
  mode: string;
}

interface BackgroundProcessStartedEvent extends BaseWebSocketMessage {
  type: 'background_process_started';
  bashId: string;
  command: string;
  description: string;
}

interface BackgroundProcessKilledEvent extends BaseWebSocketMessage {
  type: 'background_process_killed';
  bashId: string;
}

interface BackgroundProcessExitedEvent extends BaseWebSocketMessage {
  type: 'background_process_exited';
  bashId: string;
  exitCode: number;
}

interface _LongRunningCommandStartedEvent extends BaseWebSocketMessage {
  type: 'long_running_command_started';
  bashId: string;
  command: string;
  commandType: 'install' | 'build' | 'test';
  description?: string;
  startedAt: number;
}

interface _CommandOutputChunkEvent extends BaseWebSocketMessage {
  type: 'command_output_chunk';
  bashId: string;
  output: string;
}

interface _LongRunningCommandCompletedEvent extends BaseWebSocketMessage {
  type: 'long_running_command_completed';
  bashId: string;
  exitCode: number;
}

interface _LongRunningCommandFailedEvent extends BaseWebSocketMessage {
  type: 'long_running_command_failed';
  bashId: string;
  error: string;
}

interface TimeoutWarningEvent extends BaseWebSocketMessage {
  type: 'timeout_warning';
  message: string;
  elapsedSeconds: number;
}

interface RetryAttemptEvent extends BaseWebSocketMessage {
  type: 'retry_attempt';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorType: string;
  message: string;
}

interface TokenUpdateEvent extends BaseWebSocketMessage {
  type: 'token_update';
  outputTokens: number;
}

interface ThinkingStartEvent extends BaseWebSocketMessage {
  type: 'thinking_start';
}

interface ThinkingDeltaEvent extends BaseWebSocketMessage {
  type: 'thinking_delta';
  content: string;
}

interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

interface SlashCommandsAvailableEvent extends BaseWebSocketMessage {
  type: 'slash_commands_available';
  commands: SlashCommand[];
}

interface CompactStartEvent extends BaseWebSocketMessage {
  type: 'compact_start';
  trigger: 'auto' | 'manual';
  preTokens: number;
}

interface CompactLoadingEvent extends BaseWebSocketMessage {
  type: 'compact_loading';
}

interface CompactCompleteEvent extends BaseWebSocketMessage {
  type: 'compact_complete';
  preTokens: number;
}

interface ContextUsageEvent extends BaseWebSocketMessage {
  type: 'context_usage';
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  contextPercentage: number;
}

interface KeepaliveEvent extends BaseWebSocketMessage {
  type: 'keepalive';
  elapsedSeconds: number;
}

interface ArtifactStartEvent extends BaseWebSocketMessage {
  type: 'artifact_start';
  artifact: {
    id: string;
    artifactType:
      | 'text/html'
      | 'image/svg+xml'
      | 'text/markdown'
      | 'application/vnd.ant.code'
      | 'application/vnd.ant.mermaid'
      | 'application/vnd.ant.react'
      | 'application/vnd.ant.chart'
      | 'application/json';
    title?: string;
    language?: string;
  };
}

interface ArtifactDeltaEvent extends BaseWebSocketMessage {
  type: 'artifact_delta';
  artifactId: string;
  content: string;
}

interface ArtifactEndEvent extends BaseWebSocketMessage {
  type: 'artifact_end';
  artifactId: string;
}

export type WebSocketMessage =
  | AssistantMessageEvent
  | ToolUseEvent
  | ResultEvent
  | ErrorEvent
  | UserMessageEvent
  | ExitPlanModeEvent
  | PermissionModeChangedEvent
  | BackgroundProcessStartedEvent
  | BackgroundProcessKilledEvent
  | BackgroundProcessExitedEvent
  | TimeoutWarningEvent
  | RetryAttemptEvent
  | TokenUpdateEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | SlashCommandsAvailableEvent
  | CompactStartEvent
  | CompactLoadingEvent
  | CompactCompleteEvent
  | ContextUsageEvent
  | KeepaliveEvent
  | ArtifactStartEvent
  | ArtifactDeltaEvent
  | ArtifactEndEvent
  | BaseWebSocketMessage; // Fallback for unknown types

export type { SlashCommand };

interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

export function useWebSocket({
  url,
  onMessage,
  onConnect,
  onDisconnect,
  onError,
  reconnectDelay = 1000,
  maxReconnectAttempts = Infinity,
}: UseWebSocketOptions) {
  const MAX_QUEUE_SIZE = 50;

  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messageQueueRef = useRef<string[]>([]);
  const reconnectAttemptsRef = useRef(0);
  const isMountedRef = useRef(false);
  const connectionIdRef = useRef(0);

  // Use refs for callbacks to prevent reconnections when they change
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  // Update refs when callbacks change
  useEffect(() => {
    onMessageRef.current = onMessage;
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [onMessage, onConnect, onDisconnect, onError]);

  const connect = useCallback(() => {
    // Don't attempt connection if already connected or if we've exceeded max attempts
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    // No max reconnect limit - always try to reconnect

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
        connectionIdRef.current += 1;
        onConnectRef.current?.();

        // Send any queued messages
        while (messageQueueRef.current.length > 0) {
          const msg = messageQueueRef.current.shift();
          if (msg) ws.send(msg);
        }
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          onMessageRef.current?.(message);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown parse error';
          showError('WEBSOCKET_PARSE', errorMsg);
        }
      };

      ws.onerror = (error) => {
        onErrorRef.current?.(error);
      };

      ws.onclose = () => {
        setIsConnected(false);
        onDisconnectRef.current?.();
        wsRef.current = null;

        // Always attempt reconnection with exponential backoff (never give up)
        if (isMountedRef.current) {
          reconnectAttemptsRef.current += 1;
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
          const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttemptsRef.current - 1), 30000);
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };
    } catch {
      // Failed to create WebSocket connection
    }
  }, [url, maxReconnectAttempts, reconnectDelay]);

  const sendMessage = useCallback((message: Record<string, unknown>) => {
    const messageStr = JSON.stringify(message);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(messageStr);
      } catch {
        // Send failed, queue for retry on reconnect
        if (messageQueueRef.current.length < MAX_QUEUE_SIZE) {
          messageQueueRef.current.push(messageStr);
        } else {
          console.warn('[WebSocket] Message queue full, dropping message');
        }
      }
    } else {
      // Queue the message if not connected
      if (messageQueueRef.current.length < MAX_QUEUE_SIZE) {
        messageQueueRef.current.push(messageStr);
      } else {
        console.warn('[WebSocket] Message queue full, dropping message');
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const stopGeneration = useCallback((sessionId: string) => {
    if (!sessionId) {
      console.warn('[WebSocket] stopGeneration called without sessionId');
      return;
    }
    // Send proper stop_generation message to trigger SDK AbortController
    sendMessage({
      type: 'stop_generation',
      sessionId: sessionId,
    });
  }, [sendMessage]);

  // Initialize connection and handle visibility changes (sleep/wake recovery)
  useEffect(() => {
    isMountedRef.current = true;
    connect();

    // When tab becomes visible again (e.g. after sleep/lock), immediately reconnect
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)) {
        // Clear any pending reconnect timeout and try immediately
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        reconnectAttemptsRef.current = 0; // Reset backoff
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Clear reconnection timeout on unmount
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    sendMessage,
    disconnect,
    reconnect: connect,
    stopGeneration,
  };
}