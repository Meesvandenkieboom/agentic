/**
 * Control message handlers
 *
 * Handles non-chat WebSocket messages: plan approval, permission mode changes,
 * stop generation, kill background processes, and user question answers.
 */

import { sessionDb } from "../database";
import { backgroundProcessManager } from "../backgroundProcessManager";
import { sessionStreamManager } from "../sessionStreamManager";
import type { ChatWebSocket } from "./types";
import { pendingQuestions } from "./types";

/** Resolve a pending AskUserQuestion promise with the user's answer */
export function handleAnswerQuestion(data: Record<string, unknown>): void {
  const { sessionId, answers } = data;
  if (!sessionId || typeof sessionId !== 'string') return;

  const pending = pendingQuestions.get(sessionId);
  if (pending) {
    console.log(`✅ User answered question for session ${sessionId.substring(0, 8)}`);
    pendingQuestions.delete(sessionId);
    pending.resolve(JSON.stringify(answers));
  } else {
    console.warn(`⚠️ No pending question for session ${sessionId.substring(0, 8)}`);
  }
}

export async function handleApprovePlan(
  ws: ChatWebSocket,
  data: Record<string, unknown>,
  activeQueries: Map<string, unknown>
): Promise<void> {
  const { sessionId } = data;

  if (!sessionId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId', sessionId }));
    return;
  }

  const activeQuery = activeQueries.get(sessionId as string);

  try {
    console.log('✅ Plan approved, switching to default mode (canUseTool handles permissions)');

    // CRITICAL FIX: Only try to switch mode if there's an active query
    // If no active query, the session will start in default mode on next message
    if (activeQuery) {
      console.log(`🔄 Switching SDK permission mode: plan → default`);
      await (activeQuery as { setPermissionMode: (mode: string) => Promise<void> }).setPermissionMode('default');
      console.log('✅ SDK mode switched successfully');
    } else {
      console.log('⚠️  No active query - mode will be applied on next message');
    }

    // Update database to default mode (canUseTool auto-approves, important for next session load)
    sessionDb.updatePermissionMode(sessionId as string, 'default');

    // Send confirmation to client
    ws.send(JSON.stringify({
      type: 'permission_mode_changed',
      mode: 'default',
      sessionId
    }));

    console.log('✅ Plan approved, database updated to default mode');
  } catch (error) {
    console.error('❌ Failed to handle plan approval:', error);

    // Still update database even if SDK switch fails
    sessionDb.updatePermissionMode(sessionId as string, 'default');

    ws.send(JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to approve plan',
      sessionId
    }));
  }
}

export async function handleSetPermissionMode(
  ws: ChatWebSocket,
  data: Record<string, unknown>,
  activeQueries: Map<string, unknown>
): Promise<void> {
  const { sessionId, mode } = data;

  if (!sessionId || !mode) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId or mode', sessionId }));
    return;
  }

  const activeQuery = activeQueries.get(sessionId as string);

  try {
    // If there's an active query, update it mid-stream
    if (activeQuery) {
      console.log(`🔄 Switching permission mode mid-stream: ${mode}`);
      await (activeQuery as { setPermissionMode: (mode: string) => Promise<void> }).setPermissionMode(mode as string);
    }

    // Always update database
    sessionDb.updatePermissionMode(sessionId as string, mode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan');

    ws.send(JSON.stringify({
      type: 'permission_mode_changed',
      mode,
      sessionId
    }));
  } catch (error) {
    console.error('Failed to update permission mode:', error);
    ws.send(JSON.stringify({
      type: 'error',
      error: 'Failed to update permission mode',
      sessionId
    }));
  }
}

export async function handleKillBackgroundProcess(
  ws: ChatWebSocket,
  data: Record<string, unknown>
): Promise<void> {
  const { bashId } = data;

  if (!bashId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing bashId', sessionId: data.sessionId }));
    return;
  }

  try {
    console.log(`🛑 Killing background process: ${bashId}`);

    const success = await backgroundProcessManager.kill(bashId as string);

    if (success) {
      ws.send(JSON.stringify({
        type: 'background_process_killed',
        bashId,
        sessionId: data.sessionId
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Process not found',
        sessionId: data.sessionId
      }));
    }
  } catch (error) {
    console.error('Failed to kill background process:', error);
    ws.send(JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to kill background process',
      sessionId: data.sessionId
    }));
  }
}

export async function handleStopGeneration(
  ws: ChatWebSocket,
  data: Record<string, unknown>
): Promise<void> {
  const { sessionId } = data;

  if (!sessionId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId', sessionId }));
    return;
  }

  try {
    console.log(`🛑 Stop generation requested for session: ${sessionId.toString().substring(0, 8)}`);

    const success = sessionStreamManager.abortSession(sessionId as string);

    if (success) {
      console.log(`✅ Generation stopped successfully: ${sessionId.toString().substring(0, 8)}`);
      ws.send(JSON.stringify({
        type: 'generation_stopped',
        sessionId
      }));
    } else {
      console.warn(`⚠️ Failed to stop generation (session not found): ${sessionId.toString().substring(0, 8)}`);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Session not found or already stopped',
        sessionId
      }));
    }
  } catch (error) {
    console.error('❌ Error stopping generation:', error);
    ws.send(JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to stop generation',
      sessionId
    }));
  }
}
