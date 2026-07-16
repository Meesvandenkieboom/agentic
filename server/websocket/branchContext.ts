/** Provider-neutral, portable context for branches and imported chats. */

export interface PortableTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PortableBranchContext {
  fidelity: 'portable';
  turns: PortableTurn[];
}

type StoredMessage = { type: string; content: string; timestamp: string };
type ContentBlock = Record<string, unknown>;

const MAX_HISTORY_CHARS = 100_000;
const MAX_MESSAGE_CHARS = 3_000;
const MAX_TOOL_INPUT_CHARS = 800;

function compactValue(value: unknown, limit = MAX_TOOL_INPUT_CHARS): string {
  let rendered: string;
  if (typeof value === 'string') rendered = value;
  else {
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = String(value);
    }
  }
  return rendered.length > limit ? `${rendered.slice(0, limit)}…` : rendered;
}

function renderBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  const toolNames: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      toolNames.push(name);
      parts.push(`[Tool call: ${name}; input: ${compactValue(block.input ?? {})}]`);
    } else if (block.type === 'tool_result') {
      parts.push(`[Tool result: ${compactValue(block.content ?? block.result ?? '')}]`);
    } else if (block.type === 'artifact') {
      const title = typeof block.title === 'string' ? block.title : 'Untitled artifact';
      const kind = typeof block.artifactType === 'string' ? block.artifactType : 'artifact';
      const content = typeof block.content === 'string' ? `\n${block.content}` : '';
      parts.push(`[Artifact: ${title} (${kind})]${content}`);
    } else if (block.type === 'document') {
      const name = typeof block.name === 'string' ? block.name : 'attached file';
      parts.push(`[Attached file: ${name}]`);
    } else if (block.type === 'image') {
      parts.push('[Image attached in the original message]');
    }
    // Thinking/reasoning blocks are intentionally not portable.
  }

  if (toolNames.length > 0) {
    parts.push(`[Used ${toolNames.length} tool(s): ${toolNames.join(', ')}]`);
  }
  return parts.join('\n');
}

function renderStoredContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) return renderBlocks(parsed as ContentBlock[]);
  } catch {
    // Plain text is already portable.
  }
  return content;
}

function truncateMiddle(content: string): string {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  const marker = '\n... [message truncated] ...\n';
  const remaining = MAX_MESSAGE_CHARS - marker.length;
  const headLength = Math.ceil(remaining / 2);
  return `${content.slice(0, headLength)}${marker}${content.slice(-Math.floor(remaining / 2))}`;
}

export function buildPortableBranchContext(messages: StoredMessage[]): PortableBranchContext {
  return {
    fidelity: 'portable',
    turns: messages.map(message => ({
      role: message.type === 'user' ? 'user' : 'assistant',
      content: renderStoredContent(message.content),
    })),
  };
}

export function renderPortableBranchContext(context: PortableBranchContext): string {
  let totalChars = 0;
  const formattedParts: string[] = [];

  for (let index = context.turns.length - 1; index >= 0; index--) {
    const turn = context.turns[index];
    const role = turn.role === 'user' ? 'Human' : 'Assistant';
    const part = `${role}:\n${truncateMiddle(turn.content)}`;
    if (totalChars + part.length > MAX_HISTORY_CHARS) {
      formattedParts.unshift('[... earlier messages omitted for brevity ...]');
      break;
    }
    formattedParts.unshift(part);
    totalChars += part.length;
  }

  return [
    '=== CONVERSATION HISTORY (branched from parent chat) ===',
    'Portable fidelity: visible messages and available tool/artifact records only; provider-private reasoning is not included.',
    '',
    ...formattedParts,
    '',
    '=== END OF CONVERSATION HISTORY ===',
    '',
    'Continue naturally from this portable context. Your new message from the user follows:',
  ].join('\n');
}

export function formatBranchHistory(messages: StoredMessage[]): string {
  return renderPortableBranchContext(buildPortableBranchContext(messages));
}
