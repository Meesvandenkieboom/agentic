/**
 * Background response processing loop
 *
 * Continuously processes streamed responses from the Claude SDK.
 * Handles text deltas, tool use, thinking, compact boundaries,
 * turn completion, and error recovery.
 */

import type { SDKCompactBoundaryMessage } from "@anthropic-ai/claude-agent-sdk";
import { sessionDb } from "../database";
import { sessionStreamManager } from "../sessionStreamManager";
import { processContextUsage } from "./contextUsageHandler";

/**
 * Type guard to check if a message is a compact boundary message
 */
function isCompactBoundaryMessage(message: unknown): message is SDKCompactBoundaryMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'system' &&
    'subtype' in message &&
    message.subtype === 'compact_boundary'
  );
}

/**
 * Start the background response processing loop for a session.
 * This is a fire-and-forget async IIFE that runs until the SDK
 * stream ends or is aborted.
 */
export function startResponseLoop(
  sessionId: string,
  apiModelId: string,
  result: AsyncIterable<unknown>,
  activeQueries: Map<string, unknown>,
): void {
  (async () => {
    // Per-turn state (resets after each completion)
    let currentMessageContent: unknown[] = [];
    let currentTextResponse = '';
    let totalCharCount = 0;

    // Load previous cumulative output tokens from DB
    const sessionData = sessionDb.getSession(sessionId);
    const baseOutputTokens = sessionData?.output_tokens || 0;
    let currentMessageId: string | null = null;
    let exitPlanModeSentThisTurn = false;
    let toolUseCount = 0;

    const sessionStartTime = Date.now();

    // Heartbeat every 30 seconds to prevent WebSocket idle timeout
    const heartbeatInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
      sessionStreamManager.safeSend(sessionId, JSON.stringify({
        type: 'keepalive',
        elapsedSeconds: elapsed,
        sessionId,
      }));
    }, 30000);

    try {
      for await (const message of result as AsyncIterable<Record<string, unknown>>) {
        // Capture SDK's internal session ID from init message
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          const sdkSessionId = (message as { session_id?: string }).session_id;
          if (sdkSessionId && sdkSessionId !== sessionId) {
            sessionDb.updateSdkSessionId(sessionId, sdkSessionId as string);
          }
          continue;
        }

        // Detect compact boundary
        if (isCompactBoundaryMessage(message)) {
          handleCompactBoundary(message, sessionId);
          continue;
        }

        // Handle turn completion
        if (message.type === 'result') {
          handleTurnCompletion(
            message, sessionId, apiModelId,
            currentMessageContent, currentTextResponse,
            currentMessageId, baseOutputTokens, totalCharCount,
          );

          // Reset state for next turn
          currentMessageContent = [];
          currentTextResponse = '';
          currentMessageId = null;
          exitPlanModeSentThisTurn = false;
          toolUseCount = 0;
          continue;
        }

        // Handle stream events (text deltas, thinking, etc.)
        if (message.type === 'stream_event') {
          const event = message.event as Record<string, unknown>;
          const result = handleStreamEvent(
            event, sessionId,
            currentTextResponse, currentMessageContent,
            currentMessageId, totalCharCount, baseOutputTokens,
          );
          currentTextResponse = result.currentTextResponse;
          currentMessageId = result.currentMessageId;
          totalCharCount = result.totalCharCount;

          // Memory safeguard: abort if output exceeds 50MB
          const MAX_OUTPUT_CHARS = 50_000_000;
          if (totalCharCount > MAX_OUTPUT_CHARS) {
            console.warn(`⚠️ Session ${sessionId.substring(0, 8)} exceeded ${MAX_OUTPUT_CHARS / 1_000_000}MB output limit, aborting`);
            sessionStreamManager.abortSession(sessionId);
          }
          continue;
        }

        // Skip user messages (tool results processed by SDK)
        if (message.type === 'user') continue;

        // Handle assistant messages (tool use blocks, content)
        if (message.type === 'assistant') {
          const assistantResult = handleAssistantMessage(
            message, sessionId,
            currentMessageContent, currentMessageId,
            exitPlanModeSentThisTurn, toolUseCount,
          );
          currentMessageContent = assistantResult.currentMessageContent;
          currentMessageId = assistantResult.currentMessageId;
          exitPlanModeSentThisTurn = assistantResult.exitPlanModeSentThisTurn;
          toolUseCount = assistantResult.toolUseCount;
        }
      }
    } catch (error) {
      handleLoopError(error, sessionId, activeQueries, currentMessageContent, currentTextResponse, currentMessageId);
    } finally {
      clearInterval(heartbeatInterval);
    }
  })();
}

function handleCompactBoundary(message: SDKCompactBoundaryMessage, sessionId: string): void {
  const trigger = message.compact_metadata.trigger;
  const preTokens = message.compact_metadata.pre_tokens;

  if (trigger === 'auto') {
    console.log(`🗜️ Auto-compact: ${preTokens.toLocaleString()} tokens → summarized`);
    sessionDb.addMessage(sessionId, 'assistant', JSON.stringify([{
      type: 'text',
      text: `--- Auto-compact: Context reached limit (${preTokens.toLocaleString()} tokens). History was automatically summarized ---`
    }]));
    sessionStreamManager.safeSend(sessionId, JSON.stringify({
      type: 'compact_start', trigger: 'auto', preTokens, sessionId,
    }));
  } else {
    console.log(`🗜️ Manual compact: ${preTokens.toLocaleString()} tokens → summarized`);
    sessionDb.addMessage(sessionId, 'assistant', JSON.stringify([{
      type: 'text',
      text: `--- History compacted. Previous messages were summarized to reduce token usage (${preTokens.toLocaleString()} tokens before compact) ---`
    }]));
    sessionStreamManager.safeSend(sessionId, JSON.stringify({
      type: 'compact_complete', preTokens, sessionId,
    }));
  }
}

function handleTurnCompletion(
  message: Record<string, unknown>,
  sessionId: string,
  apiModelId: string,
  currentMessageContent: unknown[],
  currentTextResponse: string,
  currentMessageId: string | null,
  baseOutputTokens: number,
  totalCharCount: number,
): void {
  console.log(`✅ Turn completed: ${message.subtype}`);

  // Final save (if no content was saved incrementally)
  if (!currentMessageId) {
    if (currentMessageContent.length > 0) {
      sessionDb.addMessage(sessionId, 'assistant', JSON.stringify(currentMessageContent));
    } else if (currentTextResponse) {
      sessionDb.addMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text: currentTextResponse }]));
    }
  }

  // Process context usage
  processContextUsage(message, sessionId, apiModelId, baseOutputTokens, totalCharCount);

  // Mark session as idle
  sessionStreamManager.setIdle(sessionId);

  // Send completion signal
  sessionStreamManager.safeSend(sessionId, JSON.stringify({
    type: 'result', success: true, sessionId,
  }));
}

interface StreamEventResult {
  currentTextResponse: string;
  currentMessageId: string | null;
  totalCharCount: number;
}

function handleStreamEvent(
  event: Record<string, unknown>,
  sessionId: string,
  currentTextResponse: string,
  currentMessageContent: unknown[],
  currentMessageId: string | null,
  totalCharCount: number,
  baseOutputTokens: number,
): StreamEventResult {
  if (event.type === 'content_block_start') {
    const contentBlock = event.content_block as Record<string, unknown> | undefined;
    if (contentBlock?.type === 'thinking') {
      sessionStreamManager.safeSend(sessionId, JSON.stringify({
        type: 'thinking_start', sessionId,
      }));
    }
  } else if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    let deltaChars = 0;

    if (delta?.type === 'text_delta') {
      const text = delta.text as string;
      currentTextResponse += text;
      deltaChars = text.length;

      sessionStreamManager.safeSend(sessionId, JSON.stringify({
        type: 'assistant_message', content: text, sessionId,
      }));

      // Incremental save every 500 chars
      if (currentTextResponse.length % 500 < text.length) {
        if (!currentMessageId) {
          const msg = sessionDb.addMessage(sessionId, 'assistant',
            JSON.stringify([{ type: 'text', text: currentTextResponse }]));
          currentMessageId = msg.id;
        } else {
          const contentToSave = currentMessageContent.length > 0
            ? currentMessageContent.concat([{ type: 'text', text: currentTextResponse }])
            : [{ type: 'text', text: currentTextResponse }];
          sessionDb.updateMessage(currentMessageId, JSON.stringify(contentToSave));
        }
      }
    } else if (delta?.type === 'input_json_delta') {
      const jsonDelta = (delta.partial_json || '') as string;
      deltaChars = jsonDelta.length;
    } else if (delta?.type === 'thinking_delta') {
      const thinkingText = (delta.thinking || '') as string;
      deltaChars = thinkingText.length;
      sessionStreamManager.safeSend(sessionId, JSON.stringify({
        type: 'thinking_delta', content: thinkingText, sessionId,
      }));
    } else if (delta?.type === 'signature_delta') {
      // Silently ignore signature deltas
      deltaChars = 0;
    } else if (delta?.type) {
      console.log('⚠️ Unknown delta type:', delta.type);
    }

    totalCharCount += deltaChars;

    // Send token count update
    const estimatedTokens = Math.floor(totalCharCount / 4);
    const cumulativeTokens = baseOutputTokens + estimatedTokens;
    if (deltaChars > 0) {
      sessionStreamManager.safeSend(sessionId, JSON.stringify({
        type: 'token_update', outputTokens: cumulativeTokens, sessionId,
      }));
    }
  }

  return { currentTextResponse, currentMessageId, totalCharCount };
}

interface AssistantMessageResult {
  currentMessageContent: unknown[];
  currentMessageId: string | null;
  exitPlanModeSentThisTurn: boolean;
  toolUseCount: number;
}

function handleAssistantMessage(
  message: Record<string, unknown>,
  sessionId: string,
  currentMessageContent: unknown[],
  currentMessageId: string | null,
  exitPlanModeSentThisTurn: boolean,
  toolUseCount: number,
): AssistantMessageResult {
  const msgObj = message.message as Record<string, unknown>;
  const content = msgObj?.content;

  if (!Array.isArray(content)) {
    return { currentMessageContent, currentMessageId, exitPlanModeSentThisTurn, toolUseCount };
  }

  // Append blocks
  currentMessageContent.push(...content);

  // Incremental save
  if (!currentMessageId) {
    const msg = sessionDb.addMessage(sessionId, 'assistant', JSON.stringify(currentMessageContent));
    currentMessageId = msg.id;
  } else {
    sessionDb.updateMessage(currentMessageId, JSON.stringify(currentMessageContent));
  }

  // Process tool use blocks
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type !== 'tool_use') continue;

    toolUseCount++;
    const toolTimestamp = new Date().toISOString();
    console.log(`🔧 [${toolTimestamp}] Tool #${toolUseCount}: ${block.name}`);

    // Handle ExitPlanMode (deduplicate)
    if (block.name === 'ExitPlanMode') {
      if (!exitPlanModeSentThisTurn) {
        exitPlanModeSentThisTurn = true;
        sessionStreamManager.safeSend(sessionId, JSON.stringify({
          type: 'exit_plan_mode',
          plan: (block.input as Record<string, unknown>)?.plan || 'No plan provided',
          sessionId,
        }));
      }
      continue;
    }

    // Regular tool use
    sessionStreamManager.safeSend(sessionId, JSON.stringify({
      type: 'tool_use',
      toolId: block.id,
      toolName: block.name,
      toolInput: block.input,
      sessionId,
    }));
  }

  return { currentMessageContent, currentMessageId, exitPlanModeSentThisTurn, toolUseCount };
}

async function handleLoopError(
  error: unknown,
  sessionId: string,
  activeQueries: Map<string, unknown>,
  currentMessageContent: unknown[],
  currentTextResponse: string,
  currentMessageId: string | null,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // User-triggered abort (expected)
  if (errorMessage.includes('aborted by user') || errorMessage.includes('AbortError')) {
    console.log(`✅ Generation stopped by user: ${sessionId.substring(0, 8)}`);

    // Save partial response
    if (!currentMessageId) {
      if (currentMessageContent.length > 0) {
        sessionDb.addMessage(sessionId, 'assistant', JSON.stringify(currentMessageContent));
        console.log(`💾 Saved ${currentMessageContent.length} content blocks from aborted response`);
      } else if (currentTextResponse) {
        sessionDb.addMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text: currentTextResponse }]));
        console.log(`💾 Saved ${currentTextResponse.length} chars from aborted response`);
      }
    }

    sessionStreamManager.safeSend(sessionId, JSON.stringify({
      type: 'result', success: true, sessionId,
    }));

    // Wait for SDK to flush transcript
    await new Promise(resolve => setTimeout(resolve, 500));

    sessionStreamManager.cleanupSession(sessionId, 'user_aborted');
    activeQueries.delete(sessionId);
    return;
  }

  // Actual error
  console.error(`❌ Background response loop error for session ${sessionId}:`, error);
  sessionStreamManager.cleanupSession(sessionId, 'loop_error');
  activeQueries.delete(sessionId);

  sessionStreamManager.safeSend(sessionId, JSON.stringify({
    type: 'error',
    message: errorMessage || 'Response processing error',
    sessionId,
  }));
}
