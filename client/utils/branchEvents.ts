/**
 * Event bus for per-message branch requests.
 * Uses CustomEvents on window to communicate from deeply nested
 * message components back to ChatContainer where branching lives.
 */

export const BRANCH_MESSAGE_EVENT = 'agentic:branch-from-message';

export interface BranchMessageDetail {
  messageId: string;
}

export function dispatchBranchFromMessage(messageId: string): void {
  window.dispatchEvent(
    new CustomEvent<BranchMessageDetail>(BRANCH_MESSAGE_EVENT, {
      detail: { messageId },
    })
  );
}
