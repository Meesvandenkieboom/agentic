// Isolated end-to-end test: real steer route, stream queue and response loop; fake SDK peer, no model calls.
import assert from 'node:assert/strict';
import { sessionDb } from '../../database';
import { sessionStreamManager } from '../../sessionStreamManager';
import { startResponseLoop } from '../../websocket/responseLoop';
import { handleSessionRoutes } from '../sessions';
import { decodeStoredMessage, encodeUserMessage } from '../../../shared/storedMessage';

const tickUntil = async (condition: () => boolean) => { for (let n = 0; !condition(); n++) { if (n > 400) throw new Error('Timed out'); await Bun.sleep(5); } };
const wsMessages: Record<string, unknown>[] = [];
const ws = { readyState: 1, send: (data: string) => { wsMessages.push(JSON.parse(data)); return 1; } };
const steer = async (sessionId: string, body: unknown) => {
  const url = new URL(`http://localhost/api/sessions/${sessionId}/steer`);
  const response = await handleSessionRoutes(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), url, new Map());
  return { status: response?.status, body: await response?.json() };
};

try {
  const codex = sessionDb.createSession('Codex', process.env.AGENTIC_WORKSPACE_DIR, 'general', undefined, 'codex-6-astra');
  assert.match((await steer(codex.id, { content: 'x', turnId: 't' })).body.error, /turn has ended/, 'Codex chats must keep their own route');

  const chat = sessionDb.createSession('Steer', process.env.AGENTIC_WORKSPACE_DIR);
  sessionDb.addMessage(chat.id, 'user', 'Start');
  assert.equal((await steer(chat.id, { content: 'Too early' })).status, 409, 'accepted without a running turn');

  const input = sessionStreamManager.getOrCreateStream(chat.id)[Symbol.asyncIterator]();
  sessionStreamManager.updateWebSocket(chat.id, ws as never);
  sessionStreamManager.sendMessage(chat.id, 'Start');
  const first = await input.next();
  assert.equal(first.value.uuid, undefined, 'normal sends must stay uuid-less');

  let queued: IteratorResult<{ uuid?: string; message: { content: unknown } }> | undefined;
  startResponseLoop(chat.id, 'claude-sonnet-5-5', (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 1' } }] } };
    queued = await input.next(); // The follow-up arrives while the tool runs.
    const uuid = queued.value.uuid;
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } };
    yield { type: 'command_lifecycle', command_uuid: 'cli-internal', state: 'started' };
    yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started' };
    yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Read your follow-up' }] } };
    yield { type: 'command_lifecycle', command_uuid: uuid, state: 'completed' };
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
  })(), new Map());
  await tickUntil(() => wsMessages.some(m => m.type === 'tool_use'));

  assert.equal((await steer(chat.id, { content: '/compact' })).status, 409, 'slash commands must wait for the turn');
  assert.equal((await steer(chat.id, { content: '  ' })).status, 400);
  const image = { id: 'a', name: 'a.png', type: 'image/png', size: 8, preview: 'data:image/png;base64,iVBORw0KGgo=' };
  const accepted = await steer(chat.id, { content: encodeUserMessage('Steer', [image]), clientMessageId: 'client-1' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  await tickUntil(() => !sessionStreamManager.isGenerating(chat.id));

  assert.match(queued?.value.uuid ?? '', /^[0-9a-f-]{36}$/, 'follow-up needs a uuid for lifecycle frames');
  assert.deepEqual((queued?.value.message.content as Array<{ type: string; text?: string }>).map(b => b.text ?? b.type), ['image', 'Steer']);

  const rows = sessionDb.getSessionMessages(chat.id).map(m => [m.type, m.type === 'user' ? decodeStoredMessage(m.content).text : JSON.parse(m.content).map((b: { type: string }) => b.type).join('+')]);
  assert.deepEqual(rows, [['user', 'Start'], ['assistant', 'tool_use+tool_result'], ['user', 'Steer'], ['assistant', 'text']], 'history must split where Claude read the follow-up');

  const order = wsMessages.filter(m => m.sessionId === chat.id).map(m => m.type);
  const delivered = wsMessages.find(m => m.type === 'session_message');
  assert.equal(delivered?.clientMessageId, 'client-1');
  assert(order.indexOf('tool_use') < order.indexOf('session_message') && order.indexOf('session_message') < order.indexOf('assistant_message'), order.join(','));
  assert.equal(order.filter(t => t === 'result').length, 1);

  // Stopped before Claude read it: nothing is saved and clients get the draft back.
  const stopped = sessionDb.createSession('Stopped', process.env.AGENTIC_WORKSPACE_DIR);
  sessionStreamManager.getOrCreateStream(stopped.id);
  sessionStreamManager.updateWebSocket(stopped.id, ws as never);
  sessionStreamManager.sendMessage(stopped.id, 'Start');
  assert.equal((await steer(stopped.id, { content: '/var/log/app.log shows an error', clientMessageId: 'client-2' })).status, 200, 'a path is not a slash command');
  sessionStreamManager.abortSession(stopped.id);
  assert.deepEqual(wsMessages.find(m => m.type === 'queued_inputs_dropped' && m.sessionId === stopped.id)?.clientMessageIds, ['client-2']);
  assert.equal(sessionDb.getSessionMessages(stopped.id).length, 0);
  assert.equal((await steer(stopped.id, { content: 'Late' })).status, 409, 'queued into a stopped stream');
  console.log('CLAUDE_STEER_OK');
} finally {
  sessionStreamManager.shutdown(); sessionDb.close();
}
