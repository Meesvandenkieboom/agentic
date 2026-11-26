import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from './gemini';

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
  it('reads files with line numbers and offsets', async () => {
    expect((await call('Read', { file_path: 'a.ts' })).output).toStartWith('1\tconst x = 1;\n2\texport const needle');
    expect((await call('Read', { file_path: join(root, 'a.ts'), offset: 2, limit: 1 })).output).toStartWith('2\texport');
  });

  it('greps and globs tracked files', async () => {
    expect((await call('Grep', { pattern: 'needle' })).output).toBe('a.ts:2:export const needle = x;\nb.rs:1:fn needle() {}');
    expect((await call('Grep', { pattern: 'needle', glob: '*.rs' })).output).toBe('b.rs:1:fn needle() {}');
    expect((await call('Grep', { pattern: 'absent' })).output).toBe('(no matches)');
    expect((await call('Glob', { pattern: '**/*.ts' })).output).toBe('a.ts');
  });

  it('stays inside the worktree', async () => {
    for (const [name, args] of [
      ['Read', { file_path: '/etc/passwd' }], ['Read', { file_path: '../x' }], ['Read', { file_path: 'link' }], ['Read', { file_path: '.git/config' }],
      ['Grep', { pattern: 'root', path: '/etc' }], ['Glob', { pattern: '../**' }], ['Bash', { command: 'id' }],
      ['mcp__repo__git', { args: ['diff', '--output=/tmp/x'] }], ['mcp__repo__git', { args: ['config', 'core.pager'] }],
    ] as const) expect((await call(name, args)).error).toBeString();
  });

  it('runs allowed git commands', async () => {
    expect((await call('mcp__repo__git', { args: ['log', '--oneline'] })).output).toContain('init');
  });
});
