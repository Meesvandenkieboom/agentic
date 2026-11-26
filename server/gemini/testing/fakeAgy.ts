// Scripted stand-in for `agy acp`; the prompt text picks the scenario.
import { createInterface } from 'node:readline';

const received: unknown[] = [];
let sessions = 0;
const permissionWaiters = new Map<string, () => void>();
const cancelWaiters = new Map<string, () => void>();
const write = (message: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message as object }) + '\n');
const update = (sessionId: string, update: unknown) => write({ method: 'session/update', params: { sessionId, update } });

async function prompt(id: number, sessionId: string, text: string) {
  if (text.includes('auth')) return write({ id, error: { code: -32000, message: 'Authentication required' } });
  if (text.includes('wait')) {
    await new Promise<void>(resolve => cancelWaiters.set(sessionId, resolve));
    return write({ id, result: { stopReason: 'cancelled' } });
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', status: 'pending', title: 'ls', rawInput: { CommandLine: 'ls' } });
  await new Promise<void>(resolve => { permissionWaiters.set('p1', resolve); write({ id: 'p1', method: 'session/request_permission', params: { sessionId, options: [{ optionId: 'deny', kind: 'reject_once' }, { optionId: 'allow', kind: 'allow_once' }] } }); });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/w/a.txt', oldText: 'x', newText: 'y' }] });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
  write({ id, result: { stopReason: 'end_turn', usage: { outputTokens: 5 } } });
}

createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  received.push(msg);
  const { id, method, params } = msg;
  if (method === undefined) { permissionWaiters.get(id)?.(); return; }
  switch (method) {
    case 'initialize': return write({ id, result: { protocolVersion: 1 } });
    case 'session/new': return write({ id, result: { sessionId: `s${++sessions}` } });
    case 'session/resume': return params.sessionId === 'gone' ? write({ id, error: { code: -32602, message: 'Session not found' } }) : write({ id, result: {} });
    case 'session/set_config_option': return params.value === 'max' ? write({ id, error: { code: -32602, message: 'Invalid value' } }) : write({ id, result: {} });
    case 'session/prompt': return void prompt(id, params.sessionId, params.prompt.map((b: { text?: string }) => b.text ?? '').join(''));
    case 'session/cancel': cancelWaiters.get(params.sessionId)?.(); return;
    case 'test/received': return write({ id, result: received });
  }
});
