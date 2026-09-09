/** Byte-preserving WSL -> Windows loopback relay. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createServer, type Socket } from 'node:net';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface LoopbackRelay {
  port: number;
  close(): Promise<void>;
}

const activeRelays = new Set<() => void>();
process.once('exit', () => { for (const stop of activeRelays) stop(); });

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Only validated loopback addresses and numeric ports enter the PowerShell program. */
export function windowsRelayArgs(host: string, port: number, probe = false): string[] {
  if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Windows MCP relay requires a loopback address and a valid port');
  }
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tcp = [System.Net.Sockets.TcpClient]::new(${host === '::1' ? '[System.Net.Sockets.AddressFamily]::InterNetworkV6' : ''})
try {
  $connect = $tcp.ConnectAsync('${host}', ${port})
  if (-not $connect.Wait(2000)) { throw 'Windows loopback connection timed out' }
  [void]$connect.GetAwaiter().GetResult()
  ${probe ? '' : `
  $tcp.NoDelay = $true
  [Console]::Error.WriteLine('AGENTIC_RELAY_READY')
  $stream = $tcp.GetStream()
  $upload = [Console]::OpenStandardInput().CopyToAsync($stream)
  $download = $stream.CopyToAsync([Console]::OpenStandardOutput())
  $first = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($upload, $download))
  if ($first -eq 0) {
    [void]$upload.GetAwaiter().GetResult()
    $tcp.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send)
  }
  [void]$download.GetAwaiter().GetResult()
  `}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally { $tcp.Dispose() }
`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')];
}

/** Separate transport plumbing so streaming and lifecycle can be tested without Windows. */
export async function startLoopbackRelay(
  spawnRelay: () => ChildProcessWithoutNullStreams,
  startupTimeoutMs = 4000,
): Promise<LoopbackRelay> {
  const clients = new Map<Socket, () => void>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    // Bun 1.3 does not propagate the server's allowHalfOpen option to sockets.
    socket.allowHalfOpen = true;
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnRelay(); } catch { socket.destroy(); return; }
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(startupTimer);
      clients.delete(socket);
      socket.destroy();
      child.stdin.destroy();
      if (child.exitCode === null) child.kill();
    };
    const startupTimer = setTimeout(close, startupTimeoutMs);
    startupTimer.unref();
    clients.set(socket, close);
    socket.setNoDelay(true);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    // Read readiness out of band; stdout is exclusively the original TCP stream.
    let diagnostic = '';
    child.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(-4096);
      if (diagnostic.includes('AGENTIC_RELAY_READY')) clearTimeout(startupTimer);
    });
    socket.on('error', close);
    socket.on('close', close);
    child.stdin.on('error', close);
    child.stdout.on('error', close);
    child.on('error', close);
    child.on('exit', code => {
      clearTimeout(startupTimer);
      if (code !== 0) close();
      // stdout's end closes the socket after its buffered bytes have drained.
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP relay did not bind');
  const stopClients = () => { for (const close of clients.values()) close(); };
  activeRelays.add(stopClients);
  server.on('error', stopClients);
  return {
    port: address.port,
    close: () => new Promise<void>(resolve => {
      activeRelays.delete(stopClients);
      stopClients();
      server.close(() => resolve());
    }),
  };
}

export async function openWindowsLoopbackRelay(host: string, port: number): Promise<LoopbackRelay> {
  const powershell = Bun.which('powershell.exe');
  if (!powershell) {
    throw new Error('Agentic is running in WSL and cannot reach this local MCP server. Enable Windows interop and make powershell.exe available on PATH.');
  }
  await new Promise<void>((resolve, reject) => {
    execFile(powershell, windowsRelayArgs(host, port, true),
      { timeout: 4000, windowsHide: true, maxBuffer: 8192 }, error => {
        if (error) reject(new Error(`MCP server ${host}:${port} is unreachable in both WSL and Windows. Check that the Windows MCP server is running and WSL Windows interop is enabled.`));
        else resolve();
      });
  });
  return startLoopbackRelay(() => spawn(powershell, windowsRelayArgs(host, port), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  }));
}
