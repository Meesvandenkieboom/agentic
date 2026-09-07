// Isolated end-to-end server test: real handlers, fake Codex JSONL peer, no model/network calls.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
mock.module('../../providers.ts', () => ({ configureProvider: async () => {} }));
mock.module('../../mcpServers.ts', () => ({ getMcpServers: async () => ({}), toCodexMcpServers: () => ({}) }));
const sent: string[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  assert(String(url).startsWith('https://api.telegram.org/bot'));
  sent.push(JSON.parse(String(init.body)).text);
  return Response.json({ ok: true });
}) as typeof fetch;
const { sessionDb } = await import('../../database');
const { codexAppServer } = await import('../../codex/appServer');
const { codexSessions } = await import('../../providers/codex');
const { sessionStreamManager } = await import('../../sessionStreamManager');
const { handleWebSocketMessage } = await import('../../websocket/messageHandlers');
const { handleCodexRoutes } = await import('../../codex/routes');
const { startResponseLoop } = await import('../../websocket/responseLoop');
const { getTelegramNotifications, turnNotifications } = await import('../index');
const telegram = getTelegramNotifications();
telegram.update({ token: '123456:' + 'a'.repeat(32), userId: '123456789' });
Object.defineProperty(codexAppServer, 'command', { value: [process.execPath, new URL('../../codex/testing/fakeAppServer.ts', import.meta.url).pathname] });
const tickUntil = async (condition: () => boolean) => { for (let n = 0; !condition(); n++) { if (n > 400) throw new Error('Timed out waiting for lifecycle'); await Bun.sleep(5); } };
const wsMessages: Record<string, unknown>[] = [];
const ws = { data: { type: 'chat' }, readyState: 1, send: (data: string) => { wsMessages.push(JSON.parse(data)); return 1; } };
const active = new Map();
const emit = (events: unknown[]) => codexAppServer.request('test/emit', { events });
const identity = (id: string) => ({ threadId: sessionDb.getSession(id)!.sdk_session_id!, turnId: codexSessions.activeTurnId(id)! });
const begin = async (title: string) => {
  const chat = sessionDb.createSession(title, process.env.AGENTIC_WORKSPACE_DIR, 'general', undefined, 'codex-6-astra');
  const done = handleWebSocketMessage(ws as never, JSON.stringify({ type: 'chat', sessionId: chat.id, content: 'Work on this' }), active);
  await tickUntil(() => !!codexSessions.activeTurnId(chat.id));
  return { chat, done };
};
try {
  const a = await begin('Codex question'); const b = await begin('Codex error'); const c = await begin('Codex success');
  const question = (id: string) => ({ method: 'item/completed', params: { ...identity(a.chat.id), item: {
    id, type: 'agentMessage', text: '', delivery: 'async', questions: [{ title: 'Which files should I inspect?', options: ['All', 'Recent'] }],
  } } });
  await emit([question('answered')]);
  await tickUntil(() => !!codexSessions.pendingQuestion(a.chat.id));
  const q = codexSessions.pendingQuestion(a.chat.id)!;
  const response = await handleCodexRoutes(new Request(`http://localhost/api/sessions/${a.chat.id}/question`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId: q.toolId, answers: { question_0: 'All' } }),
  }), new URL(`http://localhost/api/sessions/${a.chat.id}/question`));
  assert.equal(response?.status, 200);
  await telegram.drain(); assert.equal(sent.length, 0, 'answered question was delivered');
  await emit([{ method: 'error', params: { ...identity(b.chat.id), willRetry: true, error: { message: 'Temporary failure' } } }]);
  await telegram.drain(); assert.equal(sent.length, 0, 'transient retry notified');
  await emit([question('pending'), question('pending'),
    { method: 'turn/completed', params: { threadId: identity(c.chat.id).threadId, turn: { id: identity(c.chat.id).turnId, status: 'completed', items: [] } } },
    { method: 'error', params: { ...identity(b.chat.id), willRetry: false, error: { message: 'Terminal failure' } } },
  ]);
  await Promise.all([b.done, c.done]);
  for (let i = 0; i < 5; i++) await telegram.drain();
  assert.equal(sent.length, 3);
  assert.equal(sent.filter(text => text.includes('💬 Question for you')).length, 1);
  assert(sent.some(text => text.includes('Codex success') && text.includes('✅ Turn finished')));
  assert(sent.some(text => text.includes('Codex error') && text.includes('⚠️ Chat error')));
  assert(sent.every(text => !text.includes('Terminal failure')), 'raw errors leaked');
  await handleWebSocketMessage(ws as never, JSON.stringify({ type: 'stop_generation', sessionId: a.chat.id }), active);
  await a.done; await telegram.drain(); assert.equal(sent.length, 3, 'Stop notified');

  // Real Claude response loop, fed deterministic SDK results. No browser attached.
  for (const [title, subtype] of [['Claude success', 'success'], ['Claude error', 'error_during_execution']]) {
    const chat = sessionDb.createSession(title, process.env.AGENTIC_WORKSPACE_DIR);
    sessionStreamManager.getOrCreateStream(chat.id); sessionStreamManager.setGenerating(chat.id, true);
    turnNotifications.begin(chat.id, title);
    startResponseLoop(chat.id, 'claude-opus-4-1-20250805', (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Saved output' }] } };
      yield { type: 'result', subtype, is_error: subtype !== 'success', usage: { input_tokens: 1, output_tokens: 1 } };
    })(), active);
    await tickUntil(() => !sessionStreamManager.isGenerating(chat.id));
    await telegram.drain();
    assert(sent.at(-1)?.includes(title));
    assert(sent.at(-1)?.includes(subtype === 'success' ? '✅ Turn finished' : '⚠️ Chat error'));
    assert(sessionDb.getSessionMessages(chat.id).length > 0, 'completion preceded persistence');
  }
  // A stopped iterator may unwind after the user has already begun a new turn.
  const reused = sessionDb.createSession('Claude replacement', process.env.AGENTIC_WORKSPACE_DIR);
  sessionStreamManager.getOrCreateStream(reused.id); sessionStreamManager.setGenerating(reused.id, true);
  turnNotifications.begin(reused.id, reused.title);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  startResponseLoop(reused.id, 'claude-opus-4-1-20250805', (async function* () {
    await held; yield { type: 'result', subtype: 'success' };
  })(), active);
  await handleWebSocketMessage(ws as never, JSON.stringify({ type: 'stop_generation', sessionId: reused.id }), active);
  sessionStreamManager.cleanupSession(reused.id, 'replace_after_stop');
  sessionStreamManager.getOrCreateStream(reused.id); sessionStreamManager.setGenerating(reused.id, true);
  turnNotifications.begin(reused.id, reused.title);
  const before = sent.length;
  release(); await Bun.sleep(25); await telegram.drain();
  assert.equal(sent.length, before, 'late stopped result notified the new turn');
  assert(sessionStreamManager.isGenerating(reused.id), 'late stopped result ended the new stream');
  turnNotifications.finish(reused.id, 'finished'); await telegram.drain();
  assert.equal(sent.length, before + 1, 'replacement turn lost its notification');
  console.log('TELEGRAM_LIFECYCLE_OK');
} finally {
  telegram.stop(); codexAppServer.stop(); sessionStreamManager.shutdown(); sessionDb.close();
}
