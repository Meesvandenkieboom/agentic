import { afterEach, describe, expect, it } from 'bun:test';
import { AcpConnection } from '../gemini/acp';
import { GeminiSessions, toAcpMcpServers, toToolBlock } from './gemini';
import type { CodexEvent } from './codex';

const fake = new URL('../gemini/testing/fakeAgy.ts', import.meta.url).pathname;
const conns: AcpConnection[] = [];
const setup = () => {
  const acp = new AcpConnection(() => [process.execPath, fake], 2_000);
  conns.push(acp);
  return { acp, sessions: new GeminiSessions(acp, 500) };
};
afterEach(() => { for (const c of conns.splice(0)) c.stop(); });
type Sent = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: { outcome?: { optionId?: string } } };
const received = (acp: AcpConnection) => acp.request<Sent[]>('test/received', {});

async function turn(sessions: GeminiSessions, prompt: string, opts: { resume?: string | null; effort?: string; signal?: AbortSignal } = {}) {
  const events: CodexEvent[] = [];
  const ids: string[] = [];
  const done = sessions.run(prompt, '/tmp', e => events.push(e), {
    sessionId: 'chat', model: 'gemini-4-neon', effort: opts.effort, resumeSessionId: opts.resume, signal: opts.signal, onSessionId: id => ids.push(id),
  });
  return { events, ids, done };
}

describe('Gemini over ACP', () => {
  it('streams a turn as Codex-shaped blocks and approves tool permissions', async () => {
    const { acp, sessions } = setup();
    const { events, ids, done } = await turn(sessions, 'hello', { effort: 'xhigh' });
    await done;
    expect(ids).toEqual(['s1']);
    const blocks = events.flatMap(e => e.type === 'block' ? [e.block] : []);
    const last = new Map(blocks.map(b => [b.id, b]));
    expect([...last.values()]).toEqual([
      { type: 'thinking', id: expect.any(String), thinking: 'plan' },
      { type: 'text', id: expect.any(String), text: 'hello' },
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls', output: 'a.txt', status: 'completed' } },
      { type: 'tool_use', id: 'c2', name: 'Edit', input: { file_path: '/w/a.txt', old_string: 'x', new_string: 'y', status: 'completed' } },
      { type: 'text', id: expect.any(String), text: 'done' },
    ]);
    expect(events.filter(e => e.type !== 'block').map(e => e.type)).toEqual(['turn_started', 'token_update', 'result']);
    expect(events.at(-1)).toEqual({ type: 'result', success: true });
    const sent = await received(acp);
    expect(sent.find(m => m.id === 'p1')?.result?.outcome?.optionId).toBe('allow');
    expect(sent.filter(m => m.method === 'session/set_config_option').map(m => m.params?.value)).toEqual(['gemini-4-neon', 'xhigh']);
    expect(sessions.isActive('chat')).toBe(false);
  });

  it('resumes a saved session once per process and starts over when it is gone', async () => {
    const { acp, sessions } = setup();
    await (await turn(sessions, 'hello', { resume: 'saved' })).done;
    await (await turn(sessions, 'hello', { resume: 'saved' })).done;
    const resumed = (await received(acp)).filter(m => m.method === 'session/resume');
    expect(resumed).toHaveLength(1);
    const gone = await turn(sessions, 'hello', { resume: 'gone' });
    await gone.done;
    expect(gone.ids).toEqual(['s1']);
  });

  it('keeps the session default when a thinking level is not offered', async () => {
    const { sessions } = setup();
    const { events, done } = await turn(sessions, 'hello', { effort: 'max' });
    await done;
    expect(events.at(-1)).toEqual({ type: 'result', success: true });
  });

  it('cancels through session/cancel and reports an unsuccessful result', async () => {
    const { acp, sessions } = setup();
    const controller = new AbortController();
    const { events, done } = await turn(sessions, 'wait', { signal: controller.signal });
    for (let n = 0; !sessions.activeTurnId('chat'); n++) { if (n > 200) throw new Error('turn never started'); await Bun.sleep(5); }
    controller.abort();
    await done;
    expect(events.at(-1)).toEqual({ type: 'result', success: false });
    expect((await received(acp)).some(m => m.method === 'session/cancel')).toBe(true);
  });

  it('explains how to log in when agy is not authenticated', async () => {
    const { sessions } = setup();
    const { done } = await turn(sessions, 'auth');
    await expect(done).rejects.toThrow('agy acp --login');
  });

  it('steers mid-tool without interrupting the running tool and splits history after it finishes', async () => {
    const { sessions } = setup();
    const timeline: string[] = [];
    const done = sessions.run('steer-tool', '/tmp', e => {
      if (e.type === 'block') {
        if (e.block.type === 'tool_use') timeline.push(`tool:${e.block.id}:${e.block.input.status}`);
        else if (e.block.type === 'text') timeline.push(`text:${e.block.text}`);
      } else if (e.type === 'input_boundary' || e.type === 'result') {
        timeline.push(e.type === 'result' ? `result:${e.success}` : 'input_boundary');
      }
    }, { sessionId: 'chat', model: 'gemini-4-neon' });

    for (let n = 0; !timeline.includes('tool:c1:in_progress'); n++) {
      if (n > 200) throw new Error('tool never started');
      await Bun.sleep(5);
    }
    const turnId = sessions.activeTurnId('chat')!;
    let dropped = false;
    sessions.steer('chat', 'skip step 2', [], {
      turnId,
      clientMessageId: 'q1',
      onDelivered: () => timeline.push('delivered:q1'),
      onDropped: () => { dropped = true; },
    });

    await done;
    expect(dropped).toBe(false);
    expect(timeline).toEqual([
      'tool:c1:in_progress',
      'tool:c1:completed',
      'input_boundary',
      'delivered:q1',
      'text:after:skip step 2',
      'result:true',
    ]);
    expect(sessions.isActive('chat')).toBe(false);
  });

  it('steers mid-text, lets the first response finish, and splits on usage_update before the follow-up reply', async () => {
    const { sessions } = setup();
    const timeline: string[] = [];
    const done = sessions.run('steer-text', '/tmp', e => {
      if (e.type === 'block' && e.block.type === 'text') timeline.push(`text:${e.block.text}`);
      else if (e.type === 'input_boundary' || e.type === 'result') timeline.push(e.type === 'result' ? `result:${e.success}` : 'input_boundary');
    }, { sessionId: 'chat', model: 'gemini-4-neon' });

    for (let n = 0; !timeline.includes('text:part1 '); n++) {
      if (n > 200) throw new Error('text never started');
      await Bun.sleep(5);
    }
    sessions.steer('chat', 'add mango', [], {
      turnId: sessions.activeTurnId('chat')!,
      clientMessageId: 'q2',
      onDelivered: () => timeline.push('delivered:q2'),
    });

    await done;
    expect(timeline).toEqual([
      'text:part1 ',
      'text:part1 part2',
      'input_boundary',
      'delivered:q2',
      'text:reply:add mango',
      'result:true',
    ]);
  });

  it('drops undelivered steers when cancelled and rejects invalid turnIds or inactive sessions', async () => {
    const { sessions } = setup();
    expect(() => sessions.steer('chat', 'hi', [], { onDelivered: () => {} })).toThrow('no longer accepting input');

    const controller = new AbortController();
    const { events, done } = await turn(sessions, 'wait', { signal: controller.signal });
    for (let n = 0; !sessions.activeTurnId('chat'); n++) {
      if (n > 200) throw new Error('turn never started');
      await Bun.sleep(5);
    }
    expect(() => sessions.steer('chat', 'hi', [], { turnId: 'wrong', onDelivered: () => {} })).toThrow('active turn changed');

    let delivered = false, dropped = false;
    sessions.steer('chat', 'queued before cancel', [], {
      turnId: sessions.activeTurnId('chat')!,
      clientMessageId: 'q3',
      onDelivered: () => { delivered = true; },
      onDropped: () => { dropped = true; },
    });
    await Bun.sleep(20);
    controller.abort();
    await done;
    expect(delivered).toBe(false);
    expect(dropped).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'result', success: false });
  });
});

describe('Gemini mapping', () => {
  it('converts MCP servers to ACP entries', () => {
    expect(toAcpMcpServers({
      docs: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'k' } },
      local: { type: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' } },
      broken: { type: 'stdio' },
    })).toEqual([
      { type: 'http', name: 'docs', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', value: 'k' }] },
      { name: 'local', command: 'node', args: ['s.js'], env: [{ name: 'A', value: '1' }] },
    ]);
  });

  it('renders new files as Write, reads as Read, and unknown tools generically', () => {
    expect(toToolBlock({ toolCallId: 'w', status: 'completed', content: [{ type: 'diff', path: '/a', newText: 'hi' }] }).name).toBe('Write');
    expect(toToolBlock({ toolCallId: 'r', kind: 'read', locations: [{ path: '/a' }] }).input).toEqual({ file_path: '/a', status: '' });
    expect(toToolBlock({ toolCallId: 's', kind: 'search', name: 'grep_search', rawInput: { Query: 'x' }, status: 'completed' })).toEqual(
      { type: 'tool_use', id: 's', name: 'grep_search', input: { Query: 'x', status: 'completed' } });
  });
});
