import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('connects and reconnects with the configured command, arguments, and environment', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agentic-mcp-process-'));
  const fixture = path.join(cwd, 'fixture.ts');
  await writeFile(
    fixture,
    `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.id == null) return;
      const result = message.method === 'tools/list'
        ? { tools: [{ name: process.env.MCP_TEST_VALUE, description: process.argv.slice(2).join('|'), inputSchema: {} }] }
        : { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `
  );
  const manager = new URL('./mcpClientManager.ts', import.meta.url).pathname;
  const script = `
    import { strict as assert } from 'node:assert';
    import { mcpClientManager as manager } from ${JSON.stringify(manager)};
    const config = { type: 'stdio', command: process.execPath, args: [${JSON.stringify(fixture)}, 'mcp-remote', 'https://fixture.example/mcp', 'a,b with spaces'], env: { MCP_TEST_VALUE: 'first' } };
    try {
      const first = await manager.connect('fixture', 'Fixture', 'https://fixture.example/mcp', config);
      assert.equal(first.status, 'connected');
      assert.equal(first.tools[0].name, 'first');
      assert.equal(first.tools[0].description, 'mcp-remote|https://fixture.example/mcp|a,b with spaces');
      assert.deepEqual(manager.getMcpServersForSDK().fixture, config);
      await manager.disconnect('fixture');
      config.env.MCP_TEST_VALUE = 'second';
      const second = await manager.connect('fixture', 'Fixture updated', 'https://fixture.example/mcp', config);
      assert.equal(second.status, 'connected');
      assert.equal(second.tools[0].name, 'second');
      assert.equal(manager.getConnection('fixture').status, 'connected');
      await manager.disconnect('fixture');
      assert.equal(manager.getMcpServersForSDK().fixture, undefined);
      process.exit(0);
    } catch (error) {
      console.error(error);
      await manager.disconnect('fixture');
      process.exit(1);
    }
  `;
  try {
    const proc = Bun.spawn([process.execPath, '-e', script], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({
      code,
      stderr: code ? stderr : '',
      stdout: code ? stdout : '',
    }).toEqual({ code: 0, stderr: '', stdout: '' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 15000);
