import { afterEach, describe, expect, it, mock } from 'bun:test';
import { McpEndpointResolver, mcpConnectionError } from './mcpEndpoint';
import type { LoopbackRelay } from './windowsLoopbackRelay';

const resolvers: McpEndpointResolver[] = [];
function setup(wsl = true, reachable = false) {
  const close = mock(async () => {});
  const canConnect = mock(async (_host: string, _port: number) => reachable);
  const openRelay = mock(async (_host: string, _port: number): Promise<LoopbackRelay> => ({ port: 41234, close }));
  const resolver = new McpEndpointResolver({ isWsl: () => wsl, canConnect, openRelay });
  resolvers.push(resolver);
  return { resolver, canConnect, openRelay, close };
}
afterEach(async () => { await Promise.all(resolvers.splice(0).map(r => r.shutdown())); });

describe('WSL MCP endpoint resolution', () => {
  it('leaves native platforms and remote/HTTPS endpoints untouched', async () => {
    const native = setup(false);
    expect(await native.resolver.resolve('http://localhost:8000/mcp')).toBe('http://localhost:8000/mcp');
    expect(native.canConnect).not.toHaveBeenCalled();
    const wsl = setup();
    for (const url of ['https://localhost:8000/mcp', 'http://example.com/mcp',
      'http://localhost.example.com/mcp', 'http://192.168.1.10/mcp', 'not a URL']) {
      expect(await wsl.resolver.resolve(url)).toBe(url);
    }
    expect(wsl.canConnect).not.toHaveBeenCalled();
    expect(wsl.openRelay).not.toHaveBeenCalled();
  });

  it('prefers an existing WSL service even when Windows has the same port', async () => {
    const { resolver, openRelay } = setup(true, true);
    expect(await resolver.resolve('http://localhost:8000/mcp')).toBe('http://localhost:8000/mcp');
    expect(openRelay).not.toHaveBeenCalled();
  });

  it('preserves the full endpoint and reuses one relay across concurrent chats and Test', async () => {
    const { resolver, canConnect, openRelay } = setup();
    const urls = Array.from({ length: 20 }, (_, n) => `http://localhost:8000/mcp/${n}?token=a%2Fb`);
    const results = await Promise.all(urls.map(url => resolver.resolve(url)));
    expect(results).toEqual(urls.map(url => url.replace('localhost:8000', '127.0.0.1:41234')));
    expect(canConnect).toHaveBeenCalledTimes(1);
    expect(openRelay).toHaveBeenCalledTimes(1);
    expect(await resolver.resolve('http://user:pass@localhost:8000/mcp')).toBe('http://user:pass@127.0.0.1:41234/mcp');
    expect(openRelay).toHaveBeenCalledTimes(1);
  });

  it('supports IPv6 loopback and the default HTTP port', async () => {
    const { resolver, openRelay } = setup();
    expect(await resolver.resolve('http://[::1]:8000/mcp')).toBe('http://127.0.0.1:41234/mcp');
    expect(openRelay).toHaveBeenCalledWith('::1', 8000);
    await resolver.resolve('http://127.0.0.1/mcp');
    expect(openRelay).toHaveBeenCalledWith('127.0.0.1', 80);
  });

  it('retries after an offline Windows server starts', async () => {
    const { resolver, openRelay } = setup();
    openRelay.mockRejectedValueOnce(new Error('Windows server offline'));
    await expect(resolver.resolve('http://localhost:8000/mcp')).rejects.toThrow('Windows server offline');
    expect(await resolver.resolve('http://localhost:8000/mcp')).toBe('http://127.0.0.1:41234/mcp');
    expect(openRelay).toHaveBeenCalledTimes(2);
  });

  it('rechecks local availability until a Windows relay has been selected', async () => {
    const { resolver, canConnect, openRelay } = setup(true, true);
    await resolver.resolve('http://localhost:8000/mcp');
    canConnect.mockResolvedValue(false);
    expect(await resolver.resolve('http://localhost:8000/mcp')).toBe('http://127.0.0.1:41234/mcp');
    // Once selected, retain the Windows endpoint for existing MCP sessions.
    canConnect.mockResolvedValue(true);
    await resolver.resolve('http://localhost:8000/mcp');
    expect(openRelay).toHaveBeenCalledTimes(1);
    expect(canConnect).toHaveBeenCalledTimes(2);
  });

  it('closes an in-flight relay when Agentic shuts down', async () => {
    const { resolver, openRelay, close } = setup();
    let finish!: (relay: LoopbackRelay) => void;
    openRelay.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const resolving = resolver.resolve('http://localhost:8000/mcp');
    await Promise.resolve();
    const shutdown = resolver.shutdown();
    finish({ port: 41234, close });
    expect(await resolving).toBe('http://localhost:8000/mcp');
    await shutdown;
    expect(close).toHaveBeenCalledTimes(1);
    expect(await resolver.resolve('http://localhost:8000/mcp')).toBe('http://localhost:8000/mcp');
    expect(openRelay).toHaveBeenCalledTimes(1);
  });

  it('retains underlying fetch error codes without dumping request data', () => {
    const error = new Error('Unable to connect', { cause: { code: 'ECONNREFUSED', token: 'private' } });
    expect(mcpConnectionError(error)).toBe('Unable to connect (ECONNREFUSED)');
    expect(mcpConnectionError('unknown')).toBe('Connection failed');
  });
});
