/**
 * Branch context injection
 *
 * Formats conversation history from a branched session for context injection.
 * When a branch is created, messages are copied to the DB but the SDK has no
 * transcript to resume from. This formats prior messages so Claude knows the
 * full conversation context.
 */

export function formatBranchHistory(messages: Array<{ type: string; content: string; timestamp: string }>): string {
  // Budget: cap at ~100k chars (~25k tokens) to leave room in context window
  const MAX_HISTORY_CHARS = 100_000;
  const MAX_MESSAGE_CHARS = 3_000;
  let totalChars = 0;

  // Work backwards to prioritize recent messages
  const formattedParts: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.type === 'user' ? 'Human' : 'Assistant';
    let content = msg.content;

    // For assistant messages, extract text from JSON content blocks
    if (msg.type === 'assistant') {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          const textParts = parsed
            .filter((block: Record<string, unknown>) => block.type === 'text')
            .map((block: Record<string, unknown>) => block.text as string);

          const toolUses = parsed.filter((block: Record<string, unknown>) => block.type === 'tool_use');

          content = textParts.join('\n');
          if (toolUses.length > 0) {
            const toolNames = toolUses.map((t: Record<string, unknown>) => t.name as string).join(', ');
            content += `\n[Used ${toolUses.length} tool(s): ${toolNames}]`;
          }
        }
      } catch {
        // Plain text content, use as-is
      }
    }

    // Truncate very long individual messages
    if (content.length > MAX_MESSAGE_CHARS) {
      content = content.slice(0, MAX_MESSAGE_CHARS) + '\n... [message truncated]';
    }

    const part = `${role}:\n${content}`;

    // Check budget
    if (totalChars + part.length > MAX_HISTORY_CHARS) {
      formattedParts.push('[... earlier messages omitted for brevity ...]');
      break;
    }

    formattedParts.unshift(part); // prepend to maintain chronological order
    totalChars += part.length;
  }

  return [
    '=== CONVERSATION HISTORY (branched from parent chat) ===',
    '',
    ...formattedParts,
    '',
    '=== END OF CONVERSATION HISTORY ===',
    '',
    'The user branched from the conversation above to explore a different direction. Continue naturally from this context. Your new message from the user follows:',
  ].join('\n');
}
