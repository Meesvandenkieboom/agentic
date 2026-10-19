import { useCallback, useState } from 'react';
import type { FileAttachment } from '../components/message/types';

export interface QueuedInput { id: string; text: string; files?: FileAttachment[] }
interface SessionInputs { queued: QueuedInput[]; restored: QueuedInput[] }
const EMPTY: SessionInputs = { queued: [], restored: [] };

const moveToRestored = (s: SessionInputs, ids?: string[]): SessionInputs => {
  const back = s.queued.filter(q => !ids || ids.includes(q.id));
  return back.length ? { queued: s.queued.filter(q => !back.includes(q)), restored: [...s.restored, ...back] } : s;
};

/**
 * Follow-ups sent while Claude works. Shown until the server saves them at the point
 * Claude reads them; returned to the composer if the server drops them unread.
 */
export function useQueuedInputs() {
  const [bySession, setBySession] = useState<Record<string, SessionInputs>>({});
  // Server-confirmed running turns. The client marks a chat loading before the CLI starts,
  // and a follow-up can only be queued once it has.
  const [running, setRunningState] = useState<Record<string, true>>({});

  const setRunning = useCallback((sessionId: string, isRunning: boolean) =>
    setRunningState(prev => {
      if (!!prev[sessionId] === isRunning) return prev;
      const next = { ...prev };
      if (isRunning) next[sessionId] = true; else delete next[sessionId];
      return next;
    }), []);

  const update = useCallback((sessionId: string, fn: (s: SessionInputs) => SessionInputs) => {
    setBySession(prev => {
      const current = prev[sessionId] ?? EMPTY;
      const next = fn(current);
      if (next === current) return prev;
      const copy = { ...prev };
      if (next.queued.length || next.restored.length) copy[sessionId] = next;
      else delete copy[sessionId];
      return copy;
    });
  }, []);

  const add = useCallback((sessionId: string, input: QueuedInput) =>
    update(sessionId, s => ({ ...s, queued: [...s.queued, input] })), [update]);

  const remove = useCallback((sessionId: string, id: string) =>
    update(sessionId, s => s.queued.some(q => q.id === id) ? { ...s, queued: s.queued.filter(q => q.id !== id) } : s), [update]);

  // The CLI drains its queue before going idle, so anything left was just delivered.
  const clearQueued = useCallback((sessionId: string) =>
    update(sessionId, s => s.queued.length ? { ...s, queued: [] } : s), [update]);

  const restore = useCallback((sessionId: string, ids: string[]) =>
    update(sessionId, s => moveToRestored(s, ids)), [update]);

  // After a reconnect: chats no longer running (e.g. server restarted) lost their CLI queue.
  const restoreInactive = useCallback((activeIds: Set<string>) =>
    setBySession(prev => {
      let changed = false;
      const next = Object.fromEntries(Object.entries(prev).map(([id, s]) => {
        if (activeIds.has(id) || !s.queued.length) return [id, s];
        changed = true;
        return [id, moveToRestored(s)];
      }));
      return changed ? next : prev;
    }), []);

  const clearRestored = useCallback((sessionId: string) =>
    update(sessionId, s => s.restored.length ? { ...s, restored: [] } : s), [update]);

  return { bySession, running, setRunning, add, remove, clearQueued, restore, restoreInactive, clearRestored };
}
