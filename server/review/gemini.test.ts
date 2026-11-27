import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { execute, runGeminiAgent } from './gemini';
import { handleMcpRequest } from './repoMcp';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-review-')));
writeFileSync(join(root, 'a.ts'), 'const x = 1;\nexport const needle = x;\n');
writeFileSync(join(root, 'b.rs'), 'fn needle() {}\n');
symlinkSync('/etc/passwd', join(root, 'link'));
Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
Bun.spawnSync(['git', 'add', '.'], { cwd: root });
Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const call = async (name: string, args: Record<string, unknown>) =>
  (await execute(root, { id: '1', name, args })).functionResponse!.response as { output?: string; error?: string };

describe('Gemini review tools', () => {
  it('reads files with line numbers, offsets, and path alias', async () => {
    expect((await call('Read', { file_path: 'a.ts' })).output).toStartWith('1\tconst x = 1;\n2\texport const needle');
    expect((await call('Read', { file_path: join(root, 'a.ts'), offset: 2, limit: 1 })).output).toStartWith('2\texport');
    expect((await call('Read', { path: 'a.ts' })).output).toStartWith('1\tconst x = 1;');
  });

  it('greps and globs tracked files', async () => {
    expect((await call('Grep', { pattern: 'needle' })).output).toBe('a.ts:2:export const needle = x;\nb.rs:1:fn needle() {}');
    expect((await call('Grep', { pattern: 'needle', glob: '*.rs' })).output).toBe('b.rs:1:fn needle() {}');
    expect((await call('Grep', { pattern: 'absent' })).output).toBe('(no matches)');
    expect((await call('Glob', { pattern: '**/*.ts' })).output).toBe('a.ts');
  });

  it('stays inside the worktree', async () => {
    for (const [name, args] of [
      ['Read', { file_path: '/etc/passwd' }], ['Read', { path: '/etc/passwd' }], ['Read', { file_path: '../x' }],
      ['Read', { file_path: 'link' }], ['Read', { file_path: '.git/config' }],
      ['Grep', { pattern: 'root', path: '/etc' }], ['Glob', { pattern: '../**' }], ['Bash', { command: 'id' }],
      ['mcp__repo__git', { args: ['diff', '--output=/tmp/x'] }], ['mcp__repo__git', { args: ['config', 'core.pager'] }],
      ['git', { args: ['push'] }],
    ] as const) expect((await call(name, args)).error).toBeString();
  });

  it('runs allowed git commands', async () => {
    expect((await call('mcp__repo__git', { args: ['log', '--oneline'] })).output).toContain('init');
    expect((await call('git', { args: ['log', '--oneline'] })).output).toContain('init');
  });
});

describe('repo MCP server', () => {
  it('handles MCP handshake, unknown methods, and sandboxed tool calls', async () => {
    expect(await handleMcpRequest(root, { method: 'notifications/initialized' })).toBeNull();
    expect(await handleMcpRequest(root, { id: 1, method: 'server/discover' })).toEqual({
      jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' },
    });
    const init = await handleMcpRequest(root, { id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-11-25');

    const listed = await handleMcpRequest(root, { id: 3, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map(t => t.name)).toEqual(['Read', 'Grep', 'Glob', 'git']);

    const ok = await handleMcpRequest(root, { id: 4, method: 'tools/call', params: { name: 'Read', arguments: { file_path: 'a.ts' } } }) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(ok.result.isError).toBeUndefined();
    expect(ok.result.content[0].text).toContain('export const needle');

    const denied = await handleMcpRequest(root, { id: 5, method: 'tools/call', params: { name: 'Read', arguments: { file_path: '/etc/passwd' } } }) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(denied.result.isError).toBe(true);
  });
});

describe('runGeminiAgent (Antigravity CLI subscription runner)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gemini-agent-test-'));
  const fakeAgy = join(scratch, 'fake-agy.ts');
  const captureFile = join(scratch, 'capture.json');
  writeFileSync(fakeAgy, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const stdin = await Bun.stdin.text();
    const cwd = process.cwd();
    const settingsIdx = args.indexOf('--settings');
    const settings = settingsIdx >= 0 ? JSON.parse(readFileSync(args[settingsIdx + 1], 'utf8')) : null;
    const mcp = existsSync(join(cwd, '.agents', 'mcp_config.json')) ? JSON.parse(readFileSync(join(cwd, '.agents', 'mcp_config.json'), 'utf8')) : null;
    writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
      args, cwd, hasGitDir: existsSync(join(cwd, '.git')),
      hasGeminiApiKey: 'GEMINI_API_KEY' in process.env,
      settings, mcp, stdin: stdin.trim(),
    }));
    const msg = JSON.parse(stdin.trim());
    if (msg.message.content.includes('TRIGGER_AUTH_FAIL')) {
      process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'authentication required' } }) + '\\n');
      process.exit(1);
    }
    if (msg.message.content.includes('TRIGGER_HANG')) {
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
    process.stdout.write(JSON.stringify({ event: 'init', init: { cwd } }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: { ok: true, tag: 'carbon' } } }) + '\\n');
  `);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const schema = z.object({ ok: z.boolean(), tag: z.string() });

  it('runs agy in an isolated read-only sandbox without leaking API keys and cleans up', async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'should-not-leak';
    try {
      const logs: string[] = [];
      const res = await runGeminiAgent({
        label: 'correctness', worktree: root, model: 'gemini-4-carbon', effort: 'high',
        system: ['System rules'], prompt: 'Review PR', schema, maxTurns: 60, maxBudgetUsd: 4,
        signal: new AbortController().signal, log: m => logs.push(m),
      }, { agyCommand: [process.execPath, fakeAgy] });

      expect(res).toEqual({ output: { ok: true, tag: 'carbon' }, costUsd: 0 });
      const cap = JSON.parse(readFileSync(captureFile, 'utf8'));
      expect(cap.args).toContain('--model');
      expect(cap.args).toContain('gemini-4-carbon');
      expect(cap.args).toContain('--effort');
      expect(cap.args).toContain('high');
      expect(cap.hasGitDir).toBe(true);
      expect(cap.hasGeminiApiKey).toBe(false);
      expect(cap.settings.modelProvider).toBe('');
      expect(cap.settings.permissions.allow).toEqual(['mcp(repo/*)']);
      expect(cap.settings.permissions.deny).toEqual(['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'read_file(*)']);
      expect(cap.mcp.mcpServers.repo.args[1]).toBe(root);
      // Temp sandbox dir is removed once the run finishes.
      expect(existsSync(cap.cwd)).toBe(false);
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('surfaces a clear login error when agy reports authentication required', async () => {
    const res = await runGeminiAgent({
      label: 'intent', worktree: root, model: 'gemini-4-hydrogen', effort: 'medium',
      system: ['System'], prompt: 'TRIGGER_AUTH_FAIL', schema, maxTurns: 40, maxBudgetUsd: 2,
      signal: new AbortController().signal, log: () => undefined,
    }, { agyCommand: [process.execPath, fakeAgy] });
    expect(res.output).toBeNull();
    expect(res.error).toContain('agentic --login');
  });

  it('aborts promptly when the AbortSignal fires', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const res = await runGeminiAgent({
      label: 'verify', worktree: root, model: 'gemini-4-neon', effort: 'high',
      system: ['System'], prompt: 'TRIGGER_HANG', schema, maxTurns: 25, maxBudgetUsd: 0.75,
      signal: ac.signal, log: () => undefined,
    }, { agyCommand: [process.execPath, fakeAgy] });
    expect(res.output).toBeNull();
    expect(res.error).toBe('aborted');
  });
});
