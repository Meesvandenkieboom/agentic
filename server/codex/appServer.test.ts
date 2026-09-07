import { afterEach, describe, expect, it } from 'bun:test';
import { CodexAppServer, CodexRpcError } from './appServer';
import { CodexSessions, type CodexEvent } from '../providers/codex';

const command = [process.execPath, new URL('./testing/fakeAppServer.ts', import.meta.url).pathname];
const apps: CodexAppServer[] = [];
const makeApp = (timeout = 2_000) => { const app = new CodexAppServer(command, timeout); apps.push(app); return app; };
afterEach(() => { for (const app of apps.splice(0)) app.stop(); });
const tickUntil = async (condition: () => boolean) => { for (let n = 0; !condition(); n++) { if (n > 100) throw new Error('Expected event never arrived'); await Bun.sleep(5); } };
const emit = (app: CodexAppServer, events: unknown[]) => app.request('test/emit', { events });
const complete = (threadId: string, id: string, items: unknown[] = []) => ({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items } } });

async function begin(app: CodexAppServer, sessions: CodexSessions, sessionId: string, signal?: AbortSignal) {
  const events: CodexEvent[] = [];
  let threadId = '';
  const done = sessions.run('Work', '/tmp', e => events.push(e), { sessionId, signal, onThreadId: id => { threadId = id; } });
  void done.catch(() => {});
  await tickUntil(() => !!sessions.activeTurnId(sessionId));
  return { events, done, threadId, turnId: sessions.activeTurnId(sessionId)! };
}

describe('Codex App Server integration', () => {
  it('initializes once, correlates concurrent requests, and reports native RPC errors', async () => {
    const app = makeApp();
    await Promise.all([app.start(), app.start(), app.request('model/list', {})]);
    const received = await app.request<{ method?: string }[]>('test/received', {});
    expect(received.filter(r => r.method === 'initialize')).toHaveLength(1);
    expect(received.filter(r => r.method === 'initialized')).toHaveLength(1);
    await expect(app.request('turn/steer', { input: [{ text: 'reject' }] })).rejects.toBeInstanceOf(CodexRpcError);
    expect(app.connected).toBe(true);
  });

  it('routes simultaneous threads, replaces deltas with final snapshots, and ignores stale turns', async () => {
    const app = makeApp(); const sessions = new CodexSessions(app);
    const a = await begin(app, sessions, 'a'); const b = await begin(app, sessions, 'b');
    await emit(app, [
      { method: 'item/agentMessage/delta', params: { threadId: a.threadId, turnId: a.turnId, itemId: 'm1', delta: 'hel' } },
      { method: 'item/agentMessage/delta', params: { threadId: a.threadId, turnId: 'old-turn', itemId: 'm1', delta: 'stale' } },
      { method: 'item/agentMessage/delta', params: { threadId: b.threadId, turnId: b.turnId, itemId: 'm2', delta: 'other' } },
      complete(a.threadId, a.turnId, [{ type: 'agentMessage', id: 'm1', text: 'hello' }]),
      complete(b.threadId, b.turnId),
    ]);
    await Promise.all([a.done, b.done]);
    expect(a.events.filter(e => e.type === 'block')).toEqual([
      { type: 'block', block: { type: 'text', id: 'm1', text: 'hel' } },
      { type: 'block', block: { type: 'text', id: 'm1', text: 'hello' } },
    ]);
    expect(b.events.filter(e => e.type === 'block')).toHaveLength(1);
    expect(sessions.isActive('a')).toBe(false);
  });

  it('keeps a quiet turn alive beyond the RPC deadline and treats retries as nonterminal', async () => {
    const app = makeApp(250); const sessions = new CodexSessions(app); const a = await begin(app, sessions, 'a');
    await emit(app, [{ method: 'error', params: { threadId: a.threadId, turnId: a.turnId, willRetry: true, error: { message: 'Temporary network error' } } }]);
    await Bun.sleep(300);
    expect(sessions.isActive('a')).toBe(true);
    expect(a.events.some(e => e.type === 'retry_attempt')).toBe(true);
    await emit(app, [complete(a.threadId, a.turnId)]); await a.done;
  });

  it('steers the current turn once, saves on acknowledgement, and leaves rejected input unaccepted', async () => {
    const app = makeApp(); const sessions = new CodexSessions(app); const a = await begin(app, sessions, 'a');
    let saves = 0;
    await sessions.steer('a', 'Follow-up', ['/tmp/picture.png'], () => { saves++; });
    expect(saves).toBe(1);
    expect(a.events.filter(e => e.type === 'input_boundary')).toHaveLength(1);
    const received = await app.request<{ method?: string; params?: Record<string, unknown> }[]>('test/received', {});
    const steer = received.find(r => r.method === 'turn/steer')!;
    expect(steer.params?.expectedTurnId).toBe(a.turnId);
    expect(steer.params?.input).toEqual([{ type: 'text', text: 'Follow-up', text_elements: [] }, { type: 'localImage', path: '/tmp/picture.png' }]);
    await expect(sessions.steer('a', 'reject', [], () => { saves++; })).rejects.toThrow('Turn changed');
    expect(saves).toBe(1);
    await emit(app, [complete(a.threadId, a.turnId)]); await a.done;
    await expect(sessions.steer('a', 'too late', [], () => {})).rejects.toThrow('no longer accepting');
  });

  it('answers native questions with their request IDs and resolves nonblocking questions without stopping', async () => {
    const app = makeApp(); const sessions = new CodexSessions(app); const a = await begin(app, sessions, 'a');
    const question = (id: number, isBlocking: boolean) => ({ id, method: 'item/tool/requestUserInput', params: { threadId: a.threadId, turnId: a.turnId, itemId: `q${id}`, isBlocking, questions: [{ id: 'scope', header: 'Scope', question: 'Choose scope', options: null }] } });
    await emit(app, [question(91, false), question(92, true)]);
    expect(sessions.pendingQuestion('a')?.isBlocking).toBe(false);
    expect(a.events.filter(e => e.type === 'ask_user_question')).toHaveLength(1);
    await expect(sessions.answer('b', '91', { scope: 'Chats' })).rejects.toThrow('no longer active');
    let saves = 0;
    await sessions.answer('a', '91', { scope: 'Chats' }, () => { saves++; });
    expect(saves).toBe(1);
    expect(sessions.pendingQuestion('a')?.toolId).toBe('92');
    const received = await app.request<{ id?: number; result?: unknown }[]>('test/received', {});
    expect(received.find(r => r.id === 91)?.result).toEqual({ answers: { scope: { answers: ['Chats'] } } });
    await emit(app, [{ method: 'serverRequest/resolved', params: { threadId: a.threadId, requestId: 92 } }]);
    expect(sessions.pendingQuestion('a')).toBeNull();
    expect(sessions.isActive('a')).toBe(true);
    await emit(app, [complete(a.threadId, a.turnId)]); await a.done;
  });

  it('answers async agent questions through steering and does not reopen completed snapshots', async () => {
    const app = makeApp(); const sessions = new CodexSessions(app); const a = await begin(app, sessions, 'a');
    const item = { id: 'async-q', type: 'agentMessage', text: 'A preference', delivery: 'async', questions: [{ title: 'Which color?', options: ['Blue', 'Red'] }] };
    await emit(app, [{ method: 'item/completed', params: { threadId: a.threadId, turnId: a.turnId, item } }]);
    let saves = 0;
    await sessions.answer('a', 'async-q', { question_0: 'Blue' }, () => { saves++; });
    await emit(app, [complete(a.threadId, a.turnId, [item])]); await a.done;
    expect(saves).toBe(1);
    expect(a.events.filter(e => e.type === 'ask_user_question')).toHaveLength(1);
  });

  it('stops through turn/interrupt and allows the saved thread to resume on the next message', async () => {
    const app = makeApp(); const sessions = new CodexSessions(app); const abort = new AbortController();
    const a = await begin(app, sessions, 'a', abort.signal); abort.abort(); await a.done;
    expect(a.events).toContainEqual({ type: 'result', success: false });
    const received = await app.request<{ method?: string }[]>('test/received', {});
    expect(received.filter(r => r.method === 'turn/interrupt')).toHaveLength(1);
    const next = sessions.run('Continue', '/tmp', () => {}, { sessionId: 'a', resumeThreadId: a.threadId });
    await tickUntil(() => !!sessions.activeTurnId('a'));
    await emit(app, [complete(a.threadId, sessions.activeTurnId('a')!)]); await next;
    const after = await app.request<{ method?: string }[]>('test/received', {});
    expect(after.filter(r => r.method === 'thread/resume')).toHaveLength(1);
  });

  it('finishes cancellation even when Codex acknowledges Stop without completing the turn', async () => {
    const app = makeApp(); const sessions = new CodexSessions(app, 20); const abort = new AbortController();
    const a = await begin(app, sessions, 'a', abort.signal);
    await app.request('test/holdStop', {});
    abort.abort();
    await expect(a.done).rejects.toThrow('did not finish stopping');
    const received = await app.request<{ method?: string }[]>('test/received', {});
    expect(received.filter(r => r.method === 'thread/unsubscribe')).toHaveLength(1);
    expect(sessions.isActive('a')).toBe(false);
    expect(app.connected).toBe(true);
  });

  it('settles every affected turn after a process failure and restarts only on a new request', async () => {
    const app = makeApp(); const sessions = new CodexSessions(app);
    const a = await begin(app, sessions, 'a'); const b = await begin(app, sessions, 'b');
    await expect(app.request('test/crash', {})).rejects.toThrow('exited');
    await expect(a.done).rejects.toThrow('exited'); await expect(b.done).rejects.toThrow('exited');
    expect(app.connected).toBe(false);
    expect(sessions.isActive('a')).toBe(false);
    await app.request('model/list', {});
    expect(app.connected).toBe(true);
    const received = await app.request<{ method?: string }[]>('test/received', {});
    expect(received.some(r => r.method === 'turn/start')).toBe(false);
  });

  it('rejects unacknowledged and malformed requests without replaying them', async () => {
    const app = makeApp(100);
    await expect(app.request('test/hang', {})).rejects.toThrow('outcome is uncertain');
    expect(app.connected).toBe(false);
    await expect(app.request('test/malformed', {})).rejects.toThrow('invalid protocol');
    expect(app.connected).toBe(false);
  });
});
