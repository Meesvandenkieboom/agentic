/** Resolve local HTTP MCP endpoints across WSL/Windows. SPDX-License-Identifier: AGPL-3.0-or-later */
import { connect } from 'node:net';
import { release } from 'node:os';
import { isLoopbackHost, openWindowsLoopbackRelay, type LoopbackRelay } from './windowsLoopbackRelay';

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = (reachable: boolean) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

interface EndpointDependencies {
  isWsl: () => boolean;
  canConnect: (host: string, port: number) => Promise<boolean>;
  openRelay: (host: string, port: number) => Promise<LoopbackRelay>;
}

export class McpEndpointResolver {
  private readonly pending = new Map<string, Promise<LoopbackRelay | undefined>>();
  private stopped = false;

  constructor(private readonly deps: EndpointDependencies = {
    isWsl: () => process.platform === 'linux' && /microsoft/i.test(release()),
    canConnect,
    openRelay: openWindowsLoopbackRelay,
  }) {}

  async resolve(rawUrl: string): Promise<string> {
    if (!this.deps.isWsl() || this.stopped) return rawUrl;
    let url: URL;
    try { url = new URL(rawUrl); } catch { return rawUrl; }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // HTTPS authority changes affect TLS verification; never rewrite HTTPS URLs.
    if (url.protocol !== 'http:' || !isLoopbackHost(host)) return rawUrl;
    const port = Number(url.port || 80);
    const key = `${host}:${port}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = (async () => {
        // Prefer an existing WSL service (including WSL mirrored networking).
        if (await this.deps.canConnect(host, port)) return undefined;
        return this.deps.openRelay(host, port);
      })();
      this.pending.set(key, pending);
    }
    let relay: LoopbackRelay | undefined;
    try { relay = await pending; } catch (error) {
      if (this.pending.get(key) === pending) this.pending.delete(key);
      throw error;
    }
    if (!relay) {
      if (this.pending.get(key) === pending) this.pending.delete(key);
      return rawUrl;
    }
    if (this.stopped) return rawUrl;
    // Runtime-only: preserve path, query, credentials, and the user's saved URL.
    url.hostname = '127.0.0.1';
    url.port = String(relay.port);
    return url.toString();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(pending.map(async entry => {
      try { await (await entry)?.close(); } catch { /* Failed setup has no relay to close. */ }
    }));
  }
}

const resolver = new McpEndpointResolver();
export const resolveMcpEndpoint = (url: string) => resolver.resolve(url);
export const shutdownMcpEndpoints = () => resolver.shutdown();

export function mcpConnectionError(error: unknown): string {
  if (!(error instanceof Error)) return 'Connection failed';
  const detail = error as Error & { code?: string; cause?: { code?: string } };
  const code = detail.code || detail.cause?.code;
  return code ? `${error.message} (${code})` : error.message;
}
