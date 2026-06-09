/**
 * Context usage tracking
 *
 * Extracts and reports token usage from SDK result messages.
 * Handles three tiers: precise modelUsage, basic usage fallback, and estimation.
 */

import { sessionDb } from "../database";
import { sessionStreamManager } from "../sessionStreamManager";

interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ResultUsage {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, ModelUsageEntry>;
}

/**
 * Process context usage from a result message and send update to client.
 * Handles three scenarios:
 *   1. modelUsage available (most accurate)
 *   2. basic usage field fallback
 *   3. estimation from stored message character counts
 */
export function processContextUsage(
  resultMessage: ResultUsage,
  sessionId: string,
  apiModelId: string,
  baseOutputTokens: number,
  totalCharCount: number,
): void {
  if (resultMessage.modelUsage) {
    processModelUsage(resultMessage.modelUsage, sessionId, apiModelId, baseOutputTokens);
  } else if (resultMessage.usage?.input_tokens) {
    processBasicUsage(resultMessage.usage, sessionId, baseOutputTokens);
  } else {
    processEstimatedUsage(sessionId, baseOutputTokens, totalCharCount);
  }
}

function processModelUsage(
  modelUsage: Record<string, ModelUsageEntry>,
  sessionId: string,
  apiModelId: string,
  baseOutputTokens: number,
): void {
  let usage = modelUsage[apiModelId];

  // Fallback: If model ID doesn't match, use first available — but never
  // silently. A mismatch here means the API billed a different model than
  // the one we requested (or sub-agents dominated usage), so make it loud.
  if (!usage && Object.keys(modelUsage).length > 0) {
    const reportedModels = Object.keys(modelUsage);
    console.warn(
      `⚠️ MODEL MISMATCH in usage report: requested ${apiModelId}, ` +
      `API reported usage for: ${reportedModels.join(', ')} — ` +
      `using ${reportedModels[0]} for context tracking`
    );
    usage = modelUsage[reportedModels[0]];
  }

  if (!usage) {
    console.warn(`⚠️  Result message has modelUsage but no model entries`);
    return;
  }

  // Total context = uncached tokens + cached tokens (read + created)
  const totalInputTokens = (usage.inputTokens || 0)
    + (usage.cacheReadInputTokens || 0)
    + (usage.cacheCreationInputTokens || 0);

  const contextPercentage = Number(((totalInputTokens / usage.contextWindow) * 100).toFixed(1));
  const cumulativeOutput = baseOutputTokens + (usage.outputTokens || 0);

  console.log(`📊 Context usage: ${totalInputTokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens (${contextPercentage}%) [input: ${usage.inputTokens}, cache_read: ${usage.cacheReadInputTokens || 0}, cache_creation: ${usage.cacheCreationInputTokens || 0}]`);

  sessionDb.updateContextUsage(sessionId, totalInputTokens, usage.contextWindow, contextPercentage, cumulativeOutput);

  sessionStreamManager.safeSend(sessionId, JSON.stringify({
    type: 'context_usage',
    inputTokens: totalInputTokens,
    outputTokens: cumulativeOutput,
    contextWindow: usage.contextWindow,
    contextPercentage,
    sessionId,
  }));
}

function processBasicUsage(
  usage: NonNullable<ResultUsage['usage']>,
  sessionId: string,
  baseOutputTokens: number,
): void {
  const inputTokens = usage.input_tokens!;
  const outputTokens = usage.output_tokens || 0;
  const DEFAULT_CONTEXT_WINDOW = 200000;
  const contextPercentage = Number(((inputTokens / DEFAULT_CONTEXT_WINDOW) * 100).toFixed(1));
  const cumulativeOutput = baseOutputTokens + outputTokens;

  console.log(`📊 Context usage (estimated): ${inputTokens.toLocaleString()}/${DEFAULT_CONTEXT_WINDOW.toLocaleString()} tokens (${contextPercentage}%)`);

  sessionDb.updateContextUsage(sessionId, inputTokens, DEFAULT_CONTEXT_WINDOW, contextPercentage, cumulativeOutput);

  sessionStreamManager.safeSend(sessionId, JSON.stringify({
    type: 'context_usage',
    inputTokens,
    outputTokens: cumulativeOutput,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    contextPercentage,
    sessionId,
  }));
}

function processEstimatedUsage(
  sessionId: string,
  baseOutputTokens: number,
  totalCharCount: number,
): void {
  const storedMessages = sessionDb.getSessionMessages(sessionId);
  let totalChars = 0;
  for (const msg of storedMessages) {
    totalChars += msg.content.length;
  }
  const estimatedInputTokens = Math.floor(totalChars / 4);
  const estimatedCurrentOutput = Math.floor(totalCharCount / 4);
  const cumulativeOutput = baseOutputTokens + estimatedCurrentOutput;
  const DEFAULT_CONTEXT_WINDOW = 200000;
  const contextPercentage = Number(((estimatedInputTokens / DEFAULT_CONTEXT_WINDOW) * 100).toFixed(1));

  console.log(`📊 Context usage (estimated from messages): ${estimatedInputTokens.toLocaleString()}/${DEFAULT_CONTEXT_WINDOW.toLocaleString()} tokens (${contextPercentage}%)`);

  sessionDb.updateContextUsage(sessionId, estimatedInputTokens, DEFAULT_CONTEXT_WINDOW, contextPercentage, cumulativeOutput);

  sessionStreamManager.safeSend(sessionId, JSON.stringify({
    type: 'context_usage',
    inputTokens: estimatedInputTokens,
    outputTokens: cumulativeOutput,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    contextPercentage,
    sessionId,
  }));
}
