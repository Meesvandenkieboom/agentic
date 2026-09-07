import { describe, expect, it } from 'bun:test';
import { CodexMessageStore } from './messageStore';
import type { SessionMessage } from '../database';

function fixture() {
  const rows: SessionMessage[] = [];
  const snapshots: SessionMessage[] = [];
  const db = {
    addMessage(sessionId: string, type: 'user' | 'assistant', content: string) {
      const row = { id: `m${rows.length}`, session_id: sessionId, type, content, timestamp: new Date().toISOString() };
      rows.push({ ...row }); return row;
    },
    updateMessage(id: string, content: string) { rows.find(r => r.id === id)!.content = content; return true; },
  };
  const store = new CodexMessageStore('chat', db, message => snapshots.push({ ...message }), error => { throw error; });
  return { rows, snapshots, db, store };
}

describe('Codex message persistence', () => {
  it('persists partial output before turn completion and coalesces deltas into a stable message', async () => {
    const { store, rows, snapshots } = fixture();
    store.update({ type: 'text', id: 'a', text: 'Hello' });
    store.update({ type: 'text', id: 'a', text: 'Hello world' });
    expect(snapshots).toHaveLength(0);
    await Bun.sleep(150);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toEqual([{ type: 'text', id: 'a', text: 'Hello world' }]);
    expect(snapshots).toHaveLength(1);
    store.update({ type: 'text', id: 'a', text: 'Hello world!' }); store.flush();
    expect(snapshots[1].id).toBe(snapshots[0].id);
  });

  it('keeps tool completions in their original row when a follow-up arrives mid-turn', () => {
    const { store, db, rows } = fixture();
    store.update({ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'test', status: 'inProgress' } });
    store.inputBoundary(); db.addMessage('chat', 'user', 'Follow-up');
    store.update({ type: 'text', id: 'reply', text: 'Understood' });
    store.update({ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'test', status: 'completed', output: 'Passed' } });
    store.flush(); store.flush();
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[0].content)[0].input.output).toBe('Passed');
    expect(rows[1].type).toBe('user');
    expect(JSON.parse(rows[2].content)[0].text).toBe('Understood');
  });

  it('does not publish unsaved output when the database fails', () => {
    const { store, db, snapshots } = fixture();
    db.updateMessage = () => { throw new Error('Disk full'); };
    store.update({ type: 'text', id: 'a', text: 'Work' });
    expect(() => store.flush()).toThrow('Disk full');
    expect(snapshots).toHaveLength(0);
  });
});
