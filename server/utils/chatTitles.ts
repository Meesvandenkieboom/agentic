/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * AI-powered chat title generation using Claude Agent SDK
 * Uses the same auth flow as the main chat (OAuth/API key) via the SDK.
 */

import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';

const TITLE_PROMPT = `Generate a concise 3-6 word title for a chat that starts with this message. Be specific and descriptive. No quotes, no emoji, no punctuation, just the title text. Respond with ONLY the title, nothing else.

Message:`;

/**
 * Generate a chat title using the Claude Agent SDK.
 * Routes through the same auth as the main chat (handles OAuth automatically).
 * Falls back to a heuristic if the SDK call fails.
 */
export async function generateChatTitle(firstUserMessage: string): Promise<string> {
  try {
    const truncated = firstUserMessage.slice(0, 500);

    const result = await unstable_v2_prompt(
      `${TITLE_PROMPT}\n"${truncated}"`,
      { model: 'claude-haiku-4-5-20250514' }
    );

    if (result.subtype !== 'success') {
      return generateHeuristicTitle(firstUserMessage);
    }

    const title = result.result
      .trim()
      .replace(/^["']|["']$/g, '')     // Remove wrapping quotes
      .replace(/^Title:\s*/i, '')       // Remove "Title:" prefix
      .replace(/[.!?]+$/, '')           // Remove trailing punctuation
      .slice(0, 60);

    if (title.length > 0) {
      console.log(`🏷️  Generated AI title: "${title}"`);
      return title;
    }

    return generateHeuristicTitle(firstUserMessage);
  } catch (error) {
    console.log('📝 Title generation failed, using heuristic:', error instanceof Error ? error.message : 'Unknown error');
    return generateHeuristicTitle(firstUserMessage);
  }
}

/**
 * Simple heuristic fallback for title generation.
 * Used when the SDK call fails or is unavailable.
 */
function generateHeuristicTitle(content: string): string {
  const cleaned = content
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const firstSentence = cleaned.split(/[.!?]/)[0].trim();
  const title = firstSentence.slice(0, 50);

  return title.length < firstSentence.length ? `${title}...` : title;
}
