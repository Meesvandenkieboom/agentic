import type { Session, SessionMessage } from '../../client/hooks/useSessionAPI';

import { exampleChats } from './examples';

export const initialSessionId = 'preview-code-review';
const timestamp = new Date().toISOString();
export const sessions: Session[] = [
  ['preview-code-review', 'Review the message cache', 0],
  ...exampleChats.map(chat => [chat.id, chat.title, chat.hours]),
  ['preview-workspaces', 'Clean up missing workspaces', 1],
  ['preview-streaming', 'Streaming response handling', 2],
  ['preview-markdown', 'Markdown rendering examples', 3],
  ['preview-tests', 'Add regression coverage', 24],
  ['preview-database', 'SQLite write contention', 25],
  ['preview-branches', 'Shared history for branches', 48],
].map(([id, title, hours]) => ({
  id: String(id), title: String(title),
  created_at: new Date(Date.now() - Number(hours) * 3600000).toISOString(),
  updated_at: new Date(Date.now() - Number(hours) * 3600000).toISOString(),
  message_count: 2, working_directory: '/projects/agentic', workspace_path: '/projects/agentic',
  workspace_origin: 'external', workspace_status: 'ready', permission_mode: 'bypassPermissions',
  github_repo: 'Meesvandenkieboom/agentic',
  mode: 'general', model: 'codex-6-sol', context_input_tokens: 24300, context_window: 200000,
  context_percentage: 12.15, output_tokens: 1850,
}));
sessions[0].pinned_at = timestamp;

export const reviewText = `The cache is bounded now. **Large conversations stay on disk**, and switching chats only keeps a small working set in memory.

## What changed

- **32 MB total budget** across cached conversations.
- **8 MB per conversation** before it is dropped from the cache.
- The oldest inactive chat is evicted first. Reloading it fetches the saved messages again.

### The eviction check

\`estimateMessageBytes\` counts text, tool inputs, and tool results—not just the visible answer.

\`\`\`typescript
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

while (cacheBytes > MAX_CACHE_BYTES && cache.size > 0) {
  const oldestId = cache.keys().next().value;
  if (!oldestId) break;
  evict(oldestId);
}
\`\`\`

**Validation:** the cache tests cover oversized entries, eviction order, and growing tool output. TypeScript and lint checks pass.

> This limits browser-side history retention. Provider processes and WSL file caching are separate sources of memory use.`;

const examples: Record<string, [string, string]> = {
  ...Object.fromEntries(exampleChats.map(chat => [chat.id, [chat.prompt, chat.answer]])),
  'preview-code-review': ['Can you review the message cache changes and explain what changed?', reviewText],
  'preview-workspaces': ['How should we handle sessions whose workspace was removed?', `Keep the chat history readable and check the directory when the session is used.

## Expected behavior

1. Opening the sidebar loads session metadata only.
2. Opening a chat still shows its saved messages.
3. Sending a new message checks whether the workspace exists.

**A missing directory should not delete a conversation.** Show a clear path-selection prompt when the user wants to continue working.

\`\`\`text
Session history    available
Workspace          missing
Next step          select a directory
\`\`\``],
  'preview-streaming': ['Explain how partial output survives a reconnect.', `The server saves partial output during the turn. On reconnect, the client restores saved messages and subscribes to new events.

### Event sequence

| Event | Client behavior |
| --- | --- |
| \`reconnect_ack\` | Restore the active turn state |
| \`session_message\` | Update the saved message by ID |
| \`assistant_message\` | Append the next text chunk |
| \`result\` | Clear the running indicator |

**Use stable message IDs** so restoring output does not create duplicate answers.`],
  'preview-markdown': ['Show me a compact technical answer with Markdown formatting.', `## Implementation notes

Use **stable IDs**, keep the state update small, and return early when there is nothing to change.

### Checklist

- [x] Handle an empty result.
- [x] Preserve the existing selection.
- [ ] Add keyboard navigation.

An inline reference such as \`client/hooks/useChatSessions.ts\` should remain easy to distinguish from prose.

\`\`\`diff
- return sessions.sort(compare);
+ return [...sessions].sort(compare);
\`\`\`

| Operation | Result |
| --- | --- |
| Pin | Moves the chat into the pinned group |
| Rename | Updates the title in place |
| Delete | Removes the selected session |

> Mutating a shared array can reorder another view unexpectedly.

See the [React documentation](https://react.dev/) for more detail.`],
};
export const messages = new Map<string, SessionMessage[]>();
for (const session of sessions) {
  const [prompt, answer] = examples[session.id] || ['Review this implementation and its edge cases.', 'The main flow looks sound. **Check the failure path** before shipping.\n\n### Follow-up\n\n- Preserve partial output when the request fails.\n- Release the active runtime after completion.\n- Cover reconnects with a focused regression test.'];
  messages.set(session.id, [
    { id: `${session.id}-user`, session_id: session.id, type: 'user', content: prompt, timestamp },
    { id: `${session.id}-assistant`, session_id: session.id, type: 'assistant', timestamp,
      content: JSON.stringify([
        ...(session.id === initialSessionId ? [
          { type: 'thinking', thinking: 'I will check how messages are retained, how eviction works, and whether tool output is included in the estimate.' },
          { type: 'tool_use', id: 'preview-read', name: 'Read', input: { file_path: '/projects/agentic/client/utils/messageCache.ts' } },
        ] : []),
        { type: 'text', text: answer },
      ]),
    },
  ]);
}
