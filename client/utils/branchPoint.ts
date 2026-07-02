/**
 * Maps a client-side message to its DB row for branching.
 *
 * Messages loaded from the DB share IDs with the server, but messages
 * created live in the current tab use local `msg-...` IDs that have no DB
 * counterpart. User messages are persisted exactly once per submit, so an
 * unmatched user message resolves by its ordinal among user messages.
 * An unmatched assistant message anchors to the next user message: the
 * branch point becomes the last DB row before it (end of that turn, which
 * may span multiple DB rows).
 */

interface ClientMsg {
  id: string;
  type: string;
  content: unknown;
}

interface DbMsg {
  id: string;
  type: string;
}

export function resolveBranchPointId(
  clientMessages: ClientMsg[],
  dbMessages: DbMsg[],
  targetMessageId: string,
): string | null {
  if (dbMessages.some(m => m.id === targetMessageId)) return targetMessageId;

  const targetIndex = clientMessages.findIndex(m => m.id === targetMessageId);
  if (targetIndex === -1 || dbMessages.length === 0) return null;

  // Only plain user messages are persisted 1:1 (tool results have array content)
  const isPlainUser = (m: ClientMsg) => m.type === 'user' && typeof m.content === 'string';
  const dbUsers = dbMessages.filter(m => m.type === 'user');

  // 1-based ordinal of user messages up to and including the given index
  const userOrdinalAt = (index: number): number =>
    clientMessages.slice(0, index + 1).filter(isPlainUser).length;

  if (isPlainUser(clientMessages[targetIndex])) {
    return dbUsers[userOrdinalAt(targetIndex) - 1]?.id ?? null;
  }

  const nextUserIndex = clientMessages.findIndex((m, i) => i > targetIndex && isPlainUser(m));
  if (nextUserIndex === -1) {
    return dbMessages[dbMessages.length - 1].id;
  }

  const nextUserDb = dbUsers[userOrdinalAt(nextUserIndex) - 1];
  if (!nextUserDb) return null;
  const dbIndex = dbMessages.findIndex(m => m.id === nextUserDb.id);
  return dbIndex > 0 ? dbMessages[dbIndex - 1].id : null;
}
