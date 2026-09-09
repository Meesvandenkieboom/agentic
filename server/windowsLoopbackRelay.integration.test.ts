import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { release } from 'node:os';
import { openWindowsLoopbackRelay, type LoopbackRelay } from './windowsLoopbackRelay';

const powershell = process.platform === 'linux' && /microsoft/i.test(release())
  ? Bun.which('powershell.exe') : null;

// An actual Windows socket catches PowerShell stdout contamination and interop
// lifecycle bugs that the portable transport fixtures cannot reproduce.
it.skipIf(!powershell)('relays real Windows TCP bytes through PowerShell, including a half-close', async () => {
  const script = `
$ErrorActionPreference = 'Stop'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
[Console]::Out.WriteLine($listener.LocalEndpoint.Port)
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $buffer = New-Object byte[] 65536
      while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $stream.Write($buffer, 0, $count)
      }
    } finally { $client.Dispose() }
  }
} finally { $listener.Stop() }
`;
  const upstream = spawn(powershell!, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let relay: LoopbackRelay | undefined;
  let diagnostic = '';
  upstream.stderr.on('data', data => { diagnostic += data.toString(); });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Windows fixture did not start: ${diagnostic}`)), 5000);
      upstream.once('error', error => { clearTimeout(timer); reject(error); });
      upstream.stdout.on('data', data => {
        output += data.toString();
        if (output.includes('\n')) { clearTimeout(timer); resolve(Number(output.trim())); }
      });
    });
    relay = await openWindowsLoopbackRelay('127.0.0.1', port);
    const client = spawn('node', ['-e', `
      const socket=require('net').connect(${relay.port},'127.0.0.1');
      process.stdin.pipe(socket);socket.pipe(process.stdout);
      socket.on('error',()=>process.exit(1));
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
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
    } finally { client.kill(); }
  } finally {
    await relay?.close();
    upstream.kill();
  }
}, 15_000);
