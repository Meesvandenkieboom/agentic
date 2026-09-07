import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

it('delivers real Codex/Claude lifecycle events independently of browser clients', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentic-telegram-lifecycle-'));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  try {
    const child = Bun.spawn([process.execPath, new URL('./testing/lifecycle.ts', import.meta.url).pathname], {
      env: { ...process.env, AGENTIC_APP_DATA_DIR: join(directory, 'data'), AGENTIC_WORKSPACE_DIR: workspace },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr || stdout).toBe(0);
    expect(stdout).toContain('TELEGRAM_LIFECYCLE_OK');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
