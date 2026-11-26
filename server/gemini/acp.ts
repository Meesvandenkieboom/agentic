import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type RpcId = string | number;
export interface AcpNotification { method: string; params: Record<string, unknown> }
export interface AcpRequest extends AcpNotification { id: RpcId }
export class AcpRpcError extends Error {
  constructor(message: string, readonly code: number) { super(message); this.name = 'AcpRpcError'; }
}

/** The installer puts agy in ~/.local/bin, which a service's PATH often lacks. */
export function getAgyCommand(): string {
  return Bun.which('agy') ?? join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
}

/** One `agy acp` stdio connection shared by all Gemini chats. */
export class AcpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private notifications = new Set<(event: AcpNotification) => void>();
  private requests = new Set<(event: AcpRequest) => void>();
  private disconnects = new Set<(error: Error) => void>();

  constructor(private readonly command = () => [getAgyCommand(), 'acp', '--disable-telemetry'], private readonly requestTimeoutMs = 60_000) {}

  get connected(): boolean { return this.child !== null; }

  onNotification(listener: (event: AcpNotification) => void) { this.notifications.add(listener); }
  onRequest(listener: (event: AcpRequest) => void) { this.requests.add(listener); }
  onDisconnect(listener: (error: Error) => void) { this.disconnects.add(listener); }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    const starting = this.launch();
    this.starting = starting;
    try { await starting; } catch (error) { if (this.starting === starting) this.starting = null; throw error; }
  }

  private async launch(): Promise<void> {
    const [bin, ...args] = this.command();
    const child = spawn(bin, args, { stdio: 'pipe', windowsHide: true });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.stdin.on('error', () => this.fail(child, new Error('Lost the connection to Gemini (agy).')));
    child.on('error', () => this.fail(child, new Error('Could not start agy. Install the Antigravity CLI: https://antigravity.google/docs/getting-started')));
    child.on('exit', (code, signal) => {
      lines.close();
      this.fail(child, new Error(`Gemini (agy) exited (${signal ?? code ?? 'unknown'}). Send a message to resume the saved conversation.`));
    });
    lines.on('line', line => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (typeof message.method === 'string') {
          const event = { method: message.method, params: message.params || {} };
          if ('id' in message) {
            if (!this.requests.size) this.respondError(message.id, 'No active client can handle this request.');
            else for (const listener of this.requests) listener({ ...event, id: message.id });
          } else for (const listener of this.notifications) listener(event);
        } else if ('id' in message) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new AcpRpcError(message.error.message || 'Gemini request failed.', message.error.code));
          else pending.resolve(message.result);
        }
      } catch {
        this.fail(child, new Error('Gemini (agy) sent an invalid protocol message. The turn was stopped.'));
      }
    });
    try {
      await this.send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, this.requestTimeoutMs);
    } catch (error) {
      this.fail(child, error instanceof Error ? error : new Error('Could not initialize Gemini (agy).'));
      throw error;
    }
  }

  /** timeoutMs null: no deadline (a prompt lasts as long as its turn). */
  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs: number | null = this.requestTimeoutMs): Promise<T> {
    await this.start();
    return this.send(method, params, timeoutMs) as Promise<T>;
  }

  private send(method: string, params: Record<string, unknown>, timeoutMs: number | null): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Gemini did not acknowledge ${method}.`);
        reject(error);
        if (this.child) this.fail(this.child, error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void { this.write({ method, params }); }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  respondError(id: RpcId, message: string): void { this.write({ id, error: { code: -32601, message } }); }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Gemini (agy) is disconnected.');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
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

  stop(reason = new Error('Gemini (agy) shut down.')): void { if (this.child) this.fail(this.child, reason); }
}

export const acpConnection = new AcpConnection();
process.once('exit', () => acpConnection.stop());
