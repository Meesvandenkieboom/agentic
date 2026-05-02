/**
 * Singleton MCP stdio→HTTP bridge.
 *
 * Some MCP servers (eg `rbxstudio-mcp`) ALSO open a TCP listener on a
 * fixed port for an external client. Only ONE instance can run system-
 * wide. But agentic spawns a separate SDK subprocess per chat session,
 * and each SDK subprocess wants to spawn its OWN MCP children. With N
 * chats, N-1 spawns die silently with EADDRINUSE.
 *
 * Claude Desktop avoids this because it's a single process — it spawns
 * each MCP child once and reuses it across all conversations.
 *
 * This module gives us the same model: spawn the stdio MCP child ONCE
 * inside the Bun server, expose it via a tiny per-MCP HTTP server on
 * 127.0.0.1:<random>, and rewrite each session's MCP config to point at
 * the bridge URL instead of spawning their own stdio child.
 *
 * The bridge multiplexes JSON-RPC traffic from many HTTP clients onto
 * the single stdio child by translating per-client request `id`s to
 * globally-unique IDs and routing responses back. The MCP `initialize`
 * handshake is performed once with the child and the response is cached
 * for replay to subsequent clients (server capabilities are static, so
 * this is safe).
 *
 * Constraints / known limits:
 * - We only proxy request/response pairs. Server-initiated notifications
 *   from the child are dropped (the port-bound MCPs we proxy don't send
 *   any). Adding broadcast SSE later is straightforward.
 * - Per-session state on the MCP server side is NOT supported. Fine for
 *   port-bound MCPs which by definition share an external resource and
 *   so don't have meaningful per-session state.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface BridgeStdioConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 1_500;

class McpStdioHttpBridge {
  private child?: ChildProcessWithoutNullStreams;
  private childReadyPromise?: Promise<void>;
  private cachedInitializeResponse?: JsonRpcMessage;

  private nextGlobalId = 1;
  private pending = new Map<
    number,
    {
      resolve: (msg: JsonRpcMessage) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private stdoutBuffer = '';
  private httpServer?: http.Server;
  public url?: string;

  constructor(public readonly id: string, public readonly stdio: BridgeStdioConfig) {}

  async start(): Promise<string> {
    if (this.url) return this.url;

    this.httpServer = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer?.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.httpServer?.removeListener('error', onError);
        resolve();
      };
      this.httpServer!.once('error', onError);
      this.httpServer!.once('listening', onListening);
      this.httpServer!.listen(0, '127.0.0.1');
    });

    const addr = this.httpServer.address() as AddressInfo;
    this.url = `http://127.0.0.1:${addr.port}/mcp`;
    return this.url;
  }

  private async ensureChild(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    if (this.childReadyPromise) return this.childReadyPromise;

    this.childReadyPromise = (async () => {
      const child = spawn(this.stdio.command, this.stdio.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.stdio.env ?? {}) },
      });

      this.child = child;

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => this.onChildStdout(chunk));

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        // Forward MCP child stderr — often has useful diagnostics
        process.stderr.write(`[mcp:${this.id}] ${chunk}`);
      });

      child.on('exit', (code, signal) => {
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        console.warn(`⚠️  MCP singleton '${this.id}' exited (${reason})`);
        this.child = undefined;
        this.childReadyPromise = undefined;
        this.cachedInitializeResponse = undefined;
        this.stdoutBuffer = '';
        for (const [, p] of this.pending) {
          clearTimeout(p.timeout);
          p.reject(new Error(`MCP singleton '${this.id}' exited (${reason})`));
        }
        this.pending.clear();
      });

      child.on('error', (err) => {
        console.error(`❌ MCP singleton '${this.id}' spawn error:`, err);
      });
    })();

    return this.childReadyPromise;
  }

  private onChildStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nlIdx;
    while ((nlIdx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, nlIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        this.dispatchChildMessage(msg);
      } catch {
        // Not JSON-RPC; many MCP servers print human-readable lines on
        // stdout during startup. Echo it through so it's debuggable.
        process.stderr.write(`[mcp:${this.id}] (stdout) ${line}\n`);
      }
    }
  }

  private dispatchChildMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timeout);
      p.resolve(msg);
      return;
    }
    // Server-initiated notification — silently drop. None of the port-
    // bound MCPs we proxy actually send these.
  }

  private async sendRequestToChild(msg: JsonRpcMessage): Promise<JsonRpcMessage> {
    await this.ensureChild();
    const child = this.child;
    if (!child) throw new Error(`MCP singleton '${this.id}' not running`);

    const globalId = this.nextGlobalId++;
    const wrapped = { ...msg, id: globalId };

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(globalId);
        reject(new Error(`MCP request timeout (${msg.method ?? 'unknown'})`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(globalId, { resolve, reject, timeout });
      child.stdin.write(JSON.stringify(wrapped) + '\n', (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(globalId);
          reject(err);
        }
      });
    });
  }

  private async sendNotificationToChild(msg: JsonRpcMessage): Promise<void> {
    await this.ensureChild();
    const child = this.child;
    if (!child) throw new Error(`MCP singleton '${this.id}' not running`);
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const path = req.url?.split('?')[0] ?? '';
    if (!path.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.method === 'GET') {
      // We don't support long-lived SSE streams from the server. Per the
      // Streamable HTTP spec, returning 405 is valid; the client falls
      // back to non-streaming POST.
      res.statusCode = 405;
      res.setHeader('Allow', 'POST, DELETE');
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      // Per-session teardown — we don't track sessions, so just ack.
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST, DELETE');
      res.end();
      return;
    }

    let body = '';
    try {
      for await (const chunk of req) body += chunk;
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }

    let reqMsg: JsonRpcMessage;
    try {
      reqMsg = JSON.parse(body) as JsonRpcMessage;
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      // initialize: cache and replay so all sessions see the same caps
      if (reqMsg.method === 'initialize') {
        const response = await this.handleInitialize(reqMsg);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(response));
        return;
      }

      // notifications/initialized: only the very first client's gets
      // forwarded to the child (during handleInitialize). For all
      // subsequent HTTP clients, just ack with 202.
      if (reqMsg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }

      if (reqMsg.id != null) {
        const childResponse = await this.sendRequestToChild(reqMsg);
        const restored = { ...childResponse, id: reqMsg.id };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(restored));
      } else {
        // Notification with no id — fire and forget
        await this.sendNotificationToChild(reqMsg);
        res.statusCode = 202;
        res.end();
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: reqMsg.id ?? null,
          error: { code: -32000, message: errorMsg },
        }),
      );
    }
  }

  private async handleInitialize(reqMsg: JsonRpcMessage): Promise<JsonRpcMessage> {
    if (this.cachedInitializeResponse) {
      // Subsequent client — replay cached response with this client's id
      return { ...this.cachedInitializeResponse, id: reqMsg.id ?? null };
    }

    // First-ever client — actually initialize the child and cache
    const response = await this.sendRequestToChild(reqMsg);
    this.cachedInitializeResponse = { ...response };

    // Complete the MCP handshake exactly once with the child
    await this.sendNotificationToChild({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    return { ...response, id: reqMsg.id ?? null };
  }

  /** Synchronous best-effort cleanup for `process.on('exit')`. */
  killChildSync(): void {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // Already gone, fine
      }
    }
    this.httpServer?.close();
  }

  async shutdown(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
    if (this.child && !this.child.killed) {
      const child = this.child;
      child.kill('SIGTERM');
      // Give it a moment, then SIGKILL if still alive
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone
          }
          resolve();
        }, SHUTDOWN_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      this.child = undefined;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('Bridge shutting down'));
    }
    this.pending.clear();
    this.childReadyPromise = undefined;
    this.cachedInitializeResponse = undefined;
    this.url = undefined;
  }
}

const registry = new Map<string, McpStdioHttpBridge>();
let cleanupHookRegistered = false;

function registerExitCleanup(): void {
  if (cleanupHookRegistered) return;
  cleanupHookRegistered = true;
  process.on('exit', () => {
    for (const bridge of registry.values()) {
      bridge.killChildSync();
    }
  });
}

/**
 * Get or create a singleton bridge for the given MCP id. Subsequent
 * calls return the same bridge (and same URL). Spawning of the underlying
 * stdio child is lazy — it happens on the first MCP `initialize` request
 * routed through the bridge, not when this function is called.
 */
export async function getOrCreateMcpBridge(
  id: string,
  config: BridgeStdioConfig,
): Promise<string> {
  registerExitCleanup();
  let bridge = registry.get(id);
  if (bridge) {
    return bridge.url ?? bridge.start();
  }
  bridge = new McpStdioHttpBridge(id, config);
  registry.set(id, bridge);
  try {
    return await bridge.start();
  } catch (err) {
    registry.delete(id);
    throw err;
  }
}

export async function shutdownAllMcpBridges(): Promise<void> {
  const bridges = [...registry.values()];
  registry.clear();
  await Promise.all(bridges.map((b) => b.shutdown().catch(() => {})));
}

/**
 * True if a bridge for this id has been registered (regardless of whether
 * its underlying child is currently alive — the bridge will respawn on
 * the next request). Use this to decide whether to skip a port-availability
 * check before calling getOrCreateMcpBridge.
 */
export function isMcpBridgeRegistered(id: string): boolean {
  return registry.has(id);
}

/** Test helper — exposed only for the smoke test in __tests__. */
export function _registrySize(): number {
  return registry.size;
}
