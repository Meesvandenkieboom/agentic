import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

async function git(args: string[], env?: Record<string, string>, timeoutMs = 300_000): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`git ${args[0] === '-C' ? args[2] : args[0]} failed: ${err.trim().split('\n').pop() ?? code}`);
  return out;
}

/** Token goes through GIT_CONFIG_* env (not argv, which `ps` exposes) and only for fetches. */
function authEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
  };
}

export class ReviewCheckouts {
  constructor(private root: string) {}
  private cache(repoId: number) { return join(this.root, 'git', `${repoId}.git`); }

  /** Fetches base + PR head into a per-repo bare cache and adds a detached worktree at `sha`. */
  async checkout(repoId: number, fullName: string, pr: number, base: string, sha: string, jobId: number, token: string): Promise<string> {
    const cache = this.cache(repoId);
    if (!existsSync(join(cache, 'HEAD'))) {
      mkdirSync(cache, { recursive: true });
      await git(['init', '--bare', '--quiet', cache]);
      await git(['-C', cache, 'remote', 'add', 'origin', `https://github.com/${fullName}.git`]);
    }
    // PR symlinks become plain files, so nothing in the worktree can point at ~/.config/solana or review.db.
    await git(['-C', cache, 'config', 'core.symlinks', 'false']);
    await git(['-C', cache, 'fetch', '--no-tags', '--prune', '--quiet', 'origin',
      `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/pull/${pr}/head:refs/remotes/pr/${pr}`], authEnv(token), 600_000);
    const dir = join(this.root, 'worktrees', String(jobId));
    rmSync(dir, { recursive: true, force: true });
    await git(['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cache, 'worktree', 'add', '--detach', '--force', dir, sha],
      { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });
    return dir;
  }

  async mergeBase(dir: string, base: string): Promise<string> {
    return (await git(['-C', dir, 'merge-base', `refs/remotes/origin/${base}`, 'HEAD'])).trim();
  }

  async release(repoId: number, dir: string): Promise<void> {
    rmSync(dir, { recursive: true, force: true });
    await git(['-C', this.cache(repoId), 'worktree', 'prune']).catch(() => undefined);
  }

  /** Drops worktrees left behind by a crash. */
  async cleanup(): Promise<void> {
    const worktrees = join(this.root, 'worktrees');
    if (existsSync(worktrees)) for (const entry of readdirSync(worktrees)) rmSync(join(worktrees, entry), { recursive: true, force: true });
    const caches = join(this.root, 'git');
    if (existsSync(caches)) for (const entry of readdirSync(caches)) await git(['-C', join(caches, entry), 'worktree', 'prune']).catch(() => undefined);
  }

  removeCache(repoId: number): void { rmSync(this.cache(repoId), { recursive: true, force: true }); }
}
