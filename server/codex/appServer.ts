import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getCodexCommand } from './runtime';

export type RpcId = string | number;
export interface RpcNotification { method: string; params: Record<string, unknown> }
export interface RpcRequest extends RpcNotification { id: RpcId }
export class CodexRpcError extends Error {
  constructor(message: string, readonly code: number) { super(message); this.name = 'CodexRpcError'; }
}

/** One private stdio connection. RPC deadlines do not impose a time limit on agent turns. */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private notifications = new Set<(event: RpcNotification) => void>();
  private requests = new Set<(event: RpcRequest) => void>();
  private disconnects = new Set<(error: Error) => void>();

  constructor(private readonly command = getCodexCommand(), private readonly requestTimeoutMs = 60_000) {}

  get connected(): boolean { return this.child !== null; }

  onNotification(listener: (event: RpcNotification) => void) { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest(listener: (event: RpcRequest) => void) { this.requests.add(listener); return () => { this.requests.delete(listener); }; }
  onDisconnect(listener: (error: Error) => void) { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    const starting = this.launch();
    this.starting = starting;
    try { await starting; } catch (error) { if (this.starting === starting) this.starting = null; throw error; }
  }

  private async launch(): Promise<void> {
    const child = spawn(this.command[0], [...this.command.slice(1), 'app-server', '--listen', 'stdio://'], { stdio: 'pipe', windowsHide: true });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    // Consume stderr without leaking configuration, prompts, or credentials into chat errors.
    child.stderr.resume();
    child.stdin.on('error', () => this.fail(child, new Error('Lost the connection to Codex App Server.')));
    child.on('error', () => this.fail(child, new Error('Could not start Codex App Server. Reinstall the Codex runtime.')));
    child.on('exit', (code, signal) => {
      lines.close();
      this.fail(child, new Error(`Codex App Server exited (${signal ?? code ?? 'unknown'}). Send a message to resume from the saved conversation.`));
    });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (typeof message.method === 'string') {
          const event = { ...message, params: message.params || {} };
          if ('id' in message) {
            if (!this.requests.size) this.respondError(message.id, 'No active client can handle this request.');
            else for (const listener of this.requests) listener(event);
          } else for (const listener of this.notifications) listener(event);
        } else if ('id' in message) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new CodexRpcError(message.error.message || 'Codex request failed.', message.error.code));
          else pending.resolve(message.result);
        }
      } catch {
        this.fail(child, new Error('Codex App Server sent an invalid protocol message. The turn was stopped.'));
      }
    });
    try {
      await this.sendRequest('initialize', {
        clientInfo: { name: 'agentic', title: 'Agentic', version: '10.0.0' },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: 'initialized' });
    } catch (error) {
      this.fail(child, error instanceof Error ? error : new Error('Could not initialize Codex App Server.'));
      throw error;
    }
  }

  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.start();
    return this.sendRequest(method, params) as Promise<T>;
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex did not acknowledge ${method}. Its outcome is uncertain; the request was not replayed.`);
        reject(error);
        if (this.child) this.fail(this.child, error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  respondError(id: RpcId, message: string): void { this.write({ id, error: { code: -32601, message } }); }

  private write(message: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex App Server is disconnected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.starting = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.disconnects) listener(error);
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
    timer.unref();
  }

  stop(): void { if (this.child) this.fail(this.child, new Error('Codex App Server shut down.')); }
}

export const codexAppServer = new CodexAppServer();
process.once('exit', () => codexAppServer.stop());
