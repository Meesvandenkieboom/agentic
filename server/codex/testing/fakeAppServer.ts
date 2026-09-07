// A deterministic JSONL peer for transport/turn integration tests. Never launches a model.
import { createInterface } from 'node:readline';
const received: Record<string, unknown>[] = [];
let threads = 0;
let turns = 0;
let holdStop = false;
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params: p = {} } = message;
  if (!method?.startsWith('test/')) received.push(message);
  if (!method || id === undefined) return;
  switch (method) {
    case 'initialize': send({ id, result: { userAgent: 'fake-codex' } }); break;
    case 'thread/start': send({ id, result: { thread: { id: `thread-${++threads}` } } }); break;
    case 'thread/resume': send({ id, result: { thread: { id: p.threadId } } }); break;
    case 'turn/start': {
      const turn = { id: `turn-${++turns}`, items: [], status: 'inProgress' };
      send({ method: 'turn/started', params: { threadId: p.threadId, turn } });
      send({ id, result: { turn } });
      break;
    }
    case 'turn/steer':
      if (p.input[0]?.text === 'reject') { send({ id, error: { code: -32602, message: 'Turn changed' } }); break; }
      send({ method: 'item/completed', params: { threadId: p.threadId, turnId: p.expectedTurnId, item: { id: p.clientUserMessageId, type: 'userMessage', clientId: p.clientUserMessageId } } });
      send({ id, result: { turnId: p.expectedTurnId } }); break;
    case 'turn/interrupt':
      send({ id, result: {} });
      if (!holdStop) send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', items: [] } } }); break;
    case 'test/emit':
      for (const event of p.events) send(event);
      send({ id, result: {} }); break;
    case 'test/received': send({ id, result: received }); break;
    case 'test/holdStop': holdStop = true; send({ id, result: {} }); break;
    case 'test/hang': break;
    case 'test/crash': process.exit(17); break;
    case 'test/malformed': process.stdout.write('invalid-json\n'); break;
    default: send({ id, result: {} });
  }
});
