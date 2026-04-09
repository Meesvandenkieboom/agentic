/**
 * Shared types and state for WebSocket message handlers
 */

import type { ServerWebSocket } from "bun";
import { AVAILABLE_MODELS } from "../../client/config/models";

export interface ChatWebSocketData {
  type: 'hot-reload' | 'chat';
  sessionId?: string;
}

export type ChatWebSocket = ServerWebSocket<ChatWebSocketData>;

// --- AskUserQuestion support ---
// Blocks SDK execution until user answers via WebSocket
export interface PendingQuestion {
  resolve: (answer: string) => void;
  toolId: string;
}

export const pendingQuestions = new Map<string, PendingQuestion>();

// Build model mapping from configuration
export const MODEL_MAP: Record<string, { apiModelId: string; provider: string }> = {};
AVAILABLE_MODELS.forEach(model => {
  MODEL_MAP[model.id] = {
    apiModelId: model.apiModelId,
    provider: model.provider,
  };
});
