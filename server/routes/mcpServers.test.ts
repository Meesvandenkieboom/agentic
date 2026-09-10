import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('persists full edits, preserves secrets, and uses them in runtime and connection tests', async () => {
  // Run in a separate working directory so neither routes nor manager can touch real settings.
  const cwd = await mkdtemp(path.join(tmpdir(), 'agentic-mcp-test-'));
  const route = new URL('./mcpServers.ts', import.meta.url).pathname;
  const runtime = new URL('../mcpServers.ts', import.meta.url).pathname;
  const script = `
    import { strict as assert } from 'node:assert';
    import { handleMCPServerRoutes } from ${JSON.stringify(route)};
    import { mkdir, writeFile, readFile } from 'node:fs/promises';
    import { getMcpServers } from ${JSON.stringify(runtime)};
    async function call(method, suffix, body) {
      const url = new URL('http://unit.test/api/mcp-servers' + suffix);
      const result = await handleMCPServerRoutes(new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }), url);
      return { status: result.status, ...await result.json() };
    }
    // Existing installations keep their config and authentication until explicitly edited.
    const legacy = {
      enabled: { grep: false, context7: true, legacy: true },
      custom: { legacy: { type: 'http', name: 'Legacy docs', url: 'https://legacy.example/mcp', headers: { Authorization: 'legacy-token' }, authProvider: 'custom-provider' } },
      headerOverrides: { context7: { CONTEXT7_API_KEY: 'existing-key' } },
      nameOverrides: { context7: 'My documentation' },
      auth: { legacy: { accessToken: 'existing-oauth-token' } }
    };
    await mkdir('.claude', { recursive: true });
    await writeFile('.claude/mcp-servers.json', JSON.stringify(legacy));
    for (const provider of ['anthropic', 'codex']) {
      const loaded = await getMcpServers(provider);
      assert.equal(loaded.grep, undefined);
      assert.deepEqual(loaded.context7.headers, { CONTEXT7_API_KEY: 'existing-key' });
      assert.equal(loaded.legacy.headers.Authorization, 'legacy-token');
    }
    assert.deepEqual(JSON.parse(await readFile('.claude/mcp-servers.json', 'utf8')), legacy);
    const legacyList = (await call('GET', '')).servers;
    assert.equal(legacyList.find(s => s.id === 'context7').name, 'My documentation');
    assert.equal(legacyList.find(s => s.id === 'legacy').authProvider, 'custom-provider');
    assert.equal((await call('PATCH', '/legacy/config', { name: 'Updated legacy name' })).connectionChanged, false);
    const headersEdit = await call('PATCH', '/legacy/config', { headers: { Authorization: 'replacement-token' } });
    assert.equal(headersEdit.hasApiKey, true);
    const persistedLegacy = JSON.parse(await readFile('.claude/mcp-servers.json', 'utf8'));
    assert.deepEqual(persistedLegacy.auth.legacy, legacy.auth.legacy);
    assert.equal(persistedLegacy.custom.legacy.authProvider, 'custom-provider');
    assert.equal((await call('POST', '', { id: 'docs', type: 'http', name: 'Docs', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer saved' } })).success, true);
    assert.equal((await call('PATCH', '/docs/config', { name: 'Renamed' })).success, true);
    let list = await call('GET', '');
    let docs = list.servers.find(s => s.id === 'docs');
    assert.equal(docs.name, 'Renamed'); assert.equal(docs.hasApiKey, true);
    assert.deepEqual(docs.headerKeys, ['Authorization']);
    assert.equal(JSON.stringify(list).includes('Bearer saved'), false);
    assert.deepEqual((await getMcpServers('anthropic')).docs.headers, { Authorization: 'Bearer saved' });
    const originalFetch = globalThis.fetch;
    let seenHeaders;
    globalThis.fetch = async (_url, init) => { seenHeaders = init.headers; return new Response('', { status: 200 }); };
    assert.equal((await call('POST', '/docs/test')).success, true);
    assert.deepEqual(seenHeaders, { Authorization: 'Bearer saved' });
    for (const status of [404, 405, 406]) {
      globalThis.fetch = async () => new Response('', { status });
      assert.equal((await call('POST', '/docs/test')).success, true);
    }
    globalThis.fetch = originalFetch;
    assert.equal((await call('PATCH', '/docs/config', { url: 'https://new.example/mcp' })).connectionChanged, true);
    assert.equal((await getMcpServers('codex')).docs.url, 'https://new.example/mcp');
    assert.equal((await call('PATCH', '/docs/config', { headers: null })).success, true);
    assert.deepEqual((await getMcpServers('codex')).docs.headers, {});
    assert.equal((await call('PATCH', '/docs/config', { headers: [] })).status, 400);
    assert.equal((await call('POST', '', { id: 'local', type: 'stdio', command: 'node', args: ['a,b', 'file with spaces'], env: { TOKEN: 'saved-env' } })).success, true);
    assert.equal((await call('PATCH', '/local/config', { name: 'Local renamed', command: 'bun' })).success, true);
    let local = (await getMcpServers('anthropic')).local;
    assert.equal(local.command, 'bun'); assert.deepEqual(local.args, ['a,b', 'file with spaces']); assert.deepEqual(local.env, { TOKEN: 'saved-env' });
    list = await call('GET', '');
    assert.deepEqual(list.servers.find(s => s.id === 'local').envKeys, ['TOKEN']);
    assert.equal(JSON.stringify(list).includes('saved-env'), false);
    assert.equal((await call('PATCH', '/context7/config', { url: 'https://override.example/mcp', headers: { 'X-Key': 'builtin-key' } })).success, true);
    assert.equal((await call('GET', '')).servers.filter(s => s.id === 'context7').length, 1);
    assert.equal((await getMcpServers('anthropic')).context7.url, 'https://override.example/mcp');
    assert.equal((await call('DELETE', '/context7')).status, 400);
    assert.equal((await call('POST', '/local/toggle')).enabled, false);
    assert.equal((await getMcpServers('codex')).local, undefined);
    assert.equal((await call('PATCH', '/docs/config', { type: 'stdio', command: 'node', args: ['server.js'] })).success, true);
    assert.equal((await getMcpServers('codex')).docs.type, 'stdio');
    assert.equal((await call('DELETE', '/docs')).success, true);
    assert.equal((await getMcpServers('anthropic')).docs, undefined);
    assert.equal((await call('PATCH', '/missing/config', { name: 'Missing' })).status, 404);
    console.log('MCP route integration checks passed');
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
