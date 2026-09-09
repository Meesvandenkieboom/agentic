import { afterEach, describe, expect, it } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { startLoopbackRelay, windowsRelayArgs, type LoopbackRelay } from './windowsLoopbackRelay';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fakeWindows(port: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', `
    const {connect}=require('node:net');
    const upstream=connect({host:'127.0.0.1',port:${port},allowHalfOpen:true});
    upstream.on('connect',()=>process.stderr.write('AGENTIC_RELAY_READY\\n'));
    upstream.on('error',()=>process.exit(1));
    process.stdin.pipe(upstream);
    upstream.pipe(process.stdout);
    upstream.on('end',()=>process.exitCode=0);
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function relayFor(port: number): Promise<LoopbackRelay> {
  const relay = await startLoopbackRelay(() => fakeWindows(port));
  cleanup.push(() => relay.close());
  return relay;
}

function readSocket(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

describe('Windows loopback relay', () => {
  it('passes HTTP sessions, Unicode JSON, and SSE chunks without altering bytes', async () => {
    const received: Array<{ path: string; session: string | null; body: string }> = [];
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      received.push({ path, session: req.headers.get('mcp-session-id'), body: await req.text() });
      if (req.method === 'GET') return new Response(null, { status: 405 });
      if (path === '/stream') {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message\ndata: {"text":"héllo 🌍"}\n\n'));
          setTimeout(() => { controller.enqueue(new TextEncoder().encode('data: done\n\n')); controller.close(); }, 20);
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{"jsonrpc":"2.0","result":{}}', {
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-123' },
      });
    } });
    cleanup.push(() => upstream.stop(true));
    const relay = await relayFor(upstream.port!);
    const base = `http://127.0.0.1:${relay.port}`;
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', text: 'héllo 🌍' });
    const init = await fetch(`${base}/mcp`, { method: 'POST', body });
    expect(init.headers.get('mcp-session-id')).toBe('session-123');
    expect(await init.text()).toBe('{"jsonrpc":"2.0","result":{}}');
    const stream = await fetch(`${base}/stream`, {
      method: 'POST', headers: { 'Mcp-Session-Id': 'session-123' }, body: 'tools/list',
    });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(await stream.text()).toBe('event: message\ndata: {"text":"héllo 🌍"}\n\ndata: done\n\n');
    expect(received).toEqual([
      { path: '/mcp', session: null, body: '' },
      { path: '/mcp', session: null, body },
      { path: '/stream', session: 'session-123', body: 'tools/list' },
    ]);
  });

  it('drains a large response after the client half-closes its upload', async () => {
    const relay = await startLoopbackRelay(() => spawn('node', ['-e',
      'console.error("AGENTIC_RELAY_READY");process.stdin.pipe(process.stdout);',
    ], { stdio: ['pipe', 'pipe', 'pipe'] }));
    cleanup.push(() => relay.close());
    // Node is the real SDK client runtime; Bun's client-side end() differs here.
    const client = spawn('node', ['-e', `
      const socket=require('net').connect(${relay.port},'127.0.0.1');
      process.stdin.pipe(socket);socket.pipe(process.stdout);
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanup.push(() => client.kill());
    const result = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.stdout.on('data', data => chunks.push(data));
      client.on('error', reject);
      client.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Client exited ${code}`)));
    });
    const payload = Buffer.alloc(256 * 1024);
    for (let n = 0; n < payload.length; n++) payload[n] = n % 256;
    client.stdin.end(payload);
    const echoed = await result;
    expect(echoed.length).toBe(payload.length);
    expect(echoed.equals(payload)).toBe(true);
  });

  it('bounds a stalled Windows process startup and closes the client', async () => {
    let child!: ChildProcessWithoutNullStreams;
    const relay = await startLoopbackRelay(() => {
      child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    }, 50);
    cleanup.push(() => relay.close());
    const socket = connect(relay.port, '127.0.0.1');
    await readSocket(socket);
    expect(child.killed).toBe(true);
  });

  it('handles a missing relay executable without an unhandled process error', async () => {
    const relay = await startLoopbackRelay(() => spawn('/nonexistent/agentic-test-relay', [], { stdio: ['pipe', 'pipe', 'pipe'] }));
    cleanup.push(() => relay.close());
    const socket = connect(relay.port, '127.0.0.1');
    expect((await readSocket(socket)).length).toBe(0);
  });

  it('closes active sockets and children on shutdown', async () => {
    let child!: ChildProcessWithoutNullStreams;
    const relay = await startLoopbackRelay(() => {
      child = spawn(process.execPath, ['-e', 'console.error("AGENTIC_RELAY_READY");setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    });
    const socket = connect(relay.port, '127.0.0.1');
    const result = readSocket(socket);
    await new Promise<void>(resolve => socket.once('connect', resolve));
    await relay.close();
    await result;
    expect(child.killed).toBe(true);
    await expect(fetch(`http://127.0.0.1:${relay.port}`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  });

  it('rejects shell text, remote addresses, and invalid ports before invoking Windows', () => {
    for (const host of ["localhost'; evil", 'example.com', '0.0.0.0']) {
      expect(() => windowsRelayArgs(host, 8000)).toThrow('loopback');
    }
    for (const port of [0, -1, 65536, NaN, 1.5]) {
      expect(() => windowsRelayArgs('localhost', port)).toThrow('valid port');
    }
    const args = windowsRelayArgs('127.0.0.1', 8000);
    expect(args).toContain('-EncodedCommand');
    expect(Buffer.from(args.at(-1)!, 'base64').toString('utf16le')).toContain("ConnectAsync('127.0.0.1', 8000)");
  });
});
