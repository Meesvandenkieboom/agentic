import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubClient, appJwt, type AppCredentials } from './github';
import { ReviewStore } from './store';
import { ReviewPoller } from './poller';
import { ReviewPublisher } from './publish';
import { parseTrigger } from './triggers';
import { isCommentable, numberPatch, parseHunks } from './diff';
import { containsSecret, renderFinding, renderSummary } from './render';
import type { EngineResult, Finding } from './types';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const app: AppCredentials = { id: 1, clientId: 'Iv1.abc', slug: 'agentic-review-mees', name: 'agentic-review-mees', htmlUrl: 'https://github.com/apps/x', owner: 'mees', ownerType: 'User', pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

type Handler = (method: string, path: string, body: unknown, headers: Record<string, string>) => Response | undefined;
function setup(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let clock = 1_700_000_000_000;
  const now = () => (clock += 5_000);
  const fetcher = async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), path, body });
    if (path.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(clock + 3_600_000).toISOString() }, { status: 201 });
    return handler(String(init.method), path, body, init.headers as Record<string, string>) ?? Response.json({ message: 'Not Found' }, { status: 404 });
  };
  const store = new ReviewStore(new Database(':memory:'), now);
  store.setApp(app);
  store.syncRepos([{ id: 7, installation_id: 99, full_name: 'mees/bot', private: true }]);
  const gh = new GitHubClient(() => store.app(), fetcher, now);
  const queued: number[] = [];
  const poller = new ReviewPoller(store, gh, { queued: async ({ pr }) => { queued.push(pr); } }, now);
  return { store, gh, poller, calls, queued, now };
}
const comment = (id: number, body: string, association = 'OWNER', login = 'mees', created = '2030-01-01T00:00:00Z') => ({
  id, body, created_at: created, updated_at: created, html_url: `https://github.com/mees/bot/pull/3#issuecomment-${id}`,
  issue_url: 'https://api.github.com/repos/mees/bot/issues/3', author_association: association, user: { login, type: 'User' },
});

const pull = (headRepo: string) => ({ number: 3, draft: false, created_at: '2030-01-01T00:00:00Z', author_association: 'OWNER', user: { login: 'x', type: 'User' },
  head: { sha: 'forkhead', repo: { full_name: headRepo } }, base: { repo: { full_name: 'mees/bot' } } });

describe('triggers', () => {
  const slug = 'agentic-review-mees';
  it('parses the handle, focus text and [bot] suffix', () => {
    expect(parseTrigger('@agentic-review-mees review', slug)).toBe('');
    expect(parseTrigger('LGTM\n@Agentic-Review-Mees REVIEW: check the hot path', slug)).toBe('check the hot path');
    expect(parseTrigger('@agentic-review-mees[bot] review', slug)).toBe('');
  });
  it('ignores code, quotes, other handles and emails', () => {
    for (const body of ['`@agentic-review-mees review`', '```\n@agentic-review-mees review\n```', '> @agentic-review-mees review',
      '@agentic-review-meesx review', 'me@agentic-review-mees review', '@agentic-review-mees reviewed']) {
      expect(parseTrigger(body, slug)).toBeNull();
    }
  });
});

describe('diff anchoring', () => {
  const patch = '@@ -10,3 +10,4 @@ fn x\n a\n-b\n+c\n+d\n e\n@@ -40 +41 @@\n-f\n+g';
  it('accepts ranges within one hunk on the chosen side only', () => {
    const hunks = parseHunks(patch);
    expect(hunks).toEqual([{ oldStart: 10, oldEnd: 12, newStart: 10, newEnd: 13 }, { oldStart: 40, oldEnd: 40, newStart: 41, newEnd: 41 }]);
    expect(isCommentable(hunks, 'RIGHT', 11, 13)).toBe(true);
    expect(isCommentable(hunks, 'RIGHT', 13, 41)).toBe(false);
    expect(isCommentable(hunks, 'LEFT', 13, 13)).toBe(false);
    expect(numberPatch(patch)).toContain('R   12 +d');
  });
});

describe('poller', () => {
  it('queues a collaborator comment once, keeps the ETag, and resumes after the cursor', async () => {
    const { store, poller, queued, calls } = setup((method, path, _body, headers) => {
      if (path.startsWith('/repos/mees/bot/pulls?')) return Response.json([], { headers: { etag: 'W/"p"' } });
      if (path.startsWith('/repos/mees/bot/issues/comments?')) {
        if (headers['If-None-Match'] === 'W/"c2"') return new Response(null, { status: 304 });
        return Response.json([comment(1, 'hi'), comment(2, '@agentic-review-mees review the slot logic')], { headers: { etag: 'W/"c2"' } });
      }
      if (path.startsWith('/repos/mees/bot/pulls/comments?')) return Response.json([]);
      if (path === '/repos/mees/bot/pulls/3') return Response.json(pull('mees/bot'));
    });
    store.updateRepo(7, { enabled: true });
    store.db.run('UPDATE review_repos SET enabled_at = 0');
    const repo = store.repo(7)!;
    await poller.pollRepo(repo);
    await poller.pollRepo(store.repo(7)!);
    await poller.pollRepo(store.repo(7)!);
    expect(queued).toEqual([3]);
    const [job] = store.jobs();
    expect(job).toMatchObject({ pr: 3, kind: 'comment', focus: 'the slot logic', status: 'queued', actor: 'mees' });
    // Cursor advanced to the newest comment; the third poll with the same URL is a 304.
    expect(store.cursor(7, 'issues/comments').cursor).toBe('2030-01-01T00:00:00Z');
    expect(calls.filter(c => c.path.startsWith('/repos/mees/bot/issues/comments?')).length).toBe(3);
  });

  it('records triggers from users without write access as skipped, including read-only org members', async () => {
    const { store, poller, queued } = setup((_m, path) => {
      if (path.startsWith('/repos/mees/bot/issues/comments?')) return Response.json([comment(5, '@agentic-review-mees review', 'NONE', 'stranger'), comment(6, '@agentic-review-mees review', 'MEMBER', 'reader')]);
      if (path.includes('/permission')) return Response.json({ permission: 'read' });
      return Response.json([]);
    });
    store.updateRepo(7, { enabled: true });
    store.db.run('UPDATE review_repos SET enabled_at = 0');
    await poller.pollRepo(store.repo(7)!);
    expect(queued).toEqual([]);
    expect(store.jobs().map(j => [j.actor, j.status])).toEqual([['reader', 'skipped'], ['stranger', 'skipped']]);
  });

  it('pins fork PRs to the head the maintainer approved and retries when the permission check errors', async () => {
    let permissionStatus = 502;
    const { store, poller, queued } = setup((_m, path) => {
      if (path.startsWith('/repos/mees/bot/issues/comments?')) return Response.json([comment(8, '@agentic-review-mees review', 'COLLABORATOR', 'maint')]);
      if (path.includes('/collaborators/maint/permission')) return Response.json({ permission: 'write' }, { status: permissionStatus });
      if (path === '/repos/mees/bot/pulls/3') return Response.json(pull('evil/bot'));
      return Response.json([]);
    });
    store.updateRepo(7, { enabled: true });
    store.db.run('UPDATE review_repos SET enabled_at = 0');
    await expect(poller.pollRepo(store.repo(7)!)).rejects.toThrow('502');
    expect(store.jobs()).toHaveLength(0);
    permissionStatus = 200;
    await poller.pollRepo(store.repo(7)!);
    expect(queued).toEqual([3]);
    expect(store.jobs()[0]).toMatchObject({ status: 'queued', pinned_sha: 'forkhead' });
  });

  it('auto-reviews new and ready PRs from the repo itself, never forks or pre-existing PRs', async () => {
    let pulls: unknown[] = [];
    const pr = (number: number, draft: boolean, created: string, fork = false) => ({
      number, draft, created_at: created, author_association: 'OWNER', user: { login: 'mees', type: 'User' },
      head: { sha: `sha${number}${draft}`, repo: { full_name: fork ? 'evil/bot' : 'mees/bot' } }, base: { repo: { full_name: 'mees/bot' } },
    });
    const { store, poller, queued, now } = setup((_m, path) => path.startsWith('/repos/mees/bot/pulls?') ? Response.json(pulls) : Response.json([]));
    pulls = [pr(1, false, '2000-01-01T00:00:00Z')];
    store.updateRepo(7, { enabled: true, automatic: true });
    await poller.pollRepo(store.repo(7)!);
    const later = new Date(now() + 60_000).toISOString();
    pulls = [pr(1, false, '2000-01-01T00:00:00Z'), pr(2, false, later), pr(3, true, later), pr(4, false, later, true)];
    await poller.pollRepo(store.repo(7)!);
    pulls = [...pulls.slice(0, 2), pr(3, false, later), pulls[3]];
    await poller.pollRepo(store.repo(7)!);
    expect(queued).toEqual([2, 3]);
    expect(store.jobs().map(j => j.kind).sort()).toEqual(['opened', 'ready']);
    // A push to PR 1 (open since before Automatic, never reviewed) gets its first review; a push to reviewed PR 2 doesn't.
    pulls = pulls.map(p => (p as { number: number }).number <= 2 ? { ...(p as object), head: { sha: 'pushed', repo: { full_name: 'mees/bot' } } } : p);
    await poller.pollRepo(store.repo(7)!);
    expect(queued).toEqual([2, 3, 1]);
    expect(store.jobs()[0]).toMatchObject({ pr: 1, kind: 'pushed' });
  });
});

describe('publishing', () => {
  const finding: Finding = {
    scope: 'change', priority: 'P1', title: 'Keep RPC data at its declared slot', body: 'When …', path: 'src/rpc.ts', startLine: null, line: 12,
    side: 'RIGHT', inline: true, confidence: 0.9, fingerprint: 'abc123def0', guidelineRef: null, suggestion: null,
  };
  const result: EngineResult = {
    summary: 'Adds a mirror.', findings: [finding, { ...finding, inline: false, line: 300, fingerprint: 'zzz' }], minorNotes: [], replies: [],
    coverage: { reviewed: 1, total: 1, skipped: [], truncated: [], guidance: ['AGENTS.md'], guidanceEditedByPr: [], candidates: 2, verified: 2, unverified: 0 }, costUsd: 1,
  };
  const ctx = { fullName: 'mees/bot', headSha: 'a'.repeat(40), mergeBase: 'b'.repeat(40), trigger: 'PR opened' };

  it('renders badges, fingerprints, and a status table', () => {
    expect(renderFinding(finding, ctx)).toStartWith('**🟠 P1 · Keep RPC data at its declared slot**');
    expect(renderFinding(finding, ctx)).toContain('fp=abc123def0');
    const summary = renderSummary([{ id: 1, status: 'done', findings: JSON.stringify({ P0: 0, P1: 1, P2: 0, P3: 0, preexisting: 0, fixed: 0 }), head_sha: 'a'.repeat(40), kind: 'ready', actor: 'mees', focus: '', review_url: 'https://x' } as never], 'agentic-review-mees');
    expect(summary).toContain('| 📝 [Code review](https://x) | ✅ Completed · 🔴 0 · 🟠 1 · 🟡 0 | `aaaaaaa` | Draft marked ready |');
  });

  it('falls back to a body-only review when GitHub rejects an inline anchor', async () => {
    const posted: { comments?: unknown[]; body: string }[] = [];
    const { store, gh } = setup((method, path, body) => {
      if (method === 'POST' && path === '/repos/mees/bot/pulls/3/reviews') {
        posted.push(body as never);
        return posted.length === 1 ? Response.json({ message: 'Line could not be resolved' }, { status: 422 }) : Response.json({ id: 1, html_url: 'https://review' });
      }
    });
    const out = await new ReviewPublisher(store, gh).postReview(store.repo(7)!, 3, result, ctx);
    expect(out.url).toBe('https://review');
    expect(posted[0].comments).toHaveLength(1);
    expect(posted[0].body).toContain('#### Outside the diff');
    expect(posted[1].comments).toBeUndefined();
    expect(posted[1].body.match(/Keep RPC data/g)).toHaveLength(2);
  });

  it('withholds findings that contain key material', () => {
    expect(containsSecret(`[${Array(64).fill(12).join(',')}]`)).toBe(true);
    expect(containsSecret('token ghp_' + 'a'.repeat(30))).toBe(true);
    expect(containsSecret('Check min_out before signing')).toBe(false);
  });

  it('signs app JWTs with the client id as issuer', () => {
    const [, payload] = appJwt(app.clientId, app.pem, 1_000_000).split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iat: 940, exp: 1480, iss: 'Iv1.abc' });
  });
});

describe('routes', () => {
  it('serves the manifest form with a single-use state and rejects cross-origin API calls', async () => {
    const { ReviewService } = await import('./service');
    const { handleReviewRoutes } = await import('./routes');
    const store = new ReviewStore(new Database(':memory:'));
    const service = new ReviewService(store, '/tmp/agentic-review-test', async () => { throw new Error('unused'); }, async () => Response.json({}));
    const call = (path: string, init?: RequestInit) => handleReviewRoutes(new Request(`http://localhost:3001${path}`, init), new URL(`http://localhost:3001${path}`), () => service);

    const form = await (await call('/api/review/app/manifest-form?owner=acme&name=agentic-review-acme'))!.text();
    expect(form).toContain('action="https://github.com/organizations/acme/settings/apps/new?state=');
    const manifest = JSON.parse(form.match(/name="manifest" value="([^"]+)"/)![1].replace(/&#34;/g, '"'));
    expect(manifest).toMatchObject({ name: 'agentic-review-acme', public: false, redirect_url: 'http://localhost:3001/api/review/app/created' });
    expect(manifest.hook_attributes).toBeUndefined();

    expect(await (await call('/api/review/app/created?code=x&state=forged'))!.text()).toContain('Link expired');
    expect((await call('/api/review/repos/1', { method: 'PATCH', headers: { origin: 'https://evil.example' }, body: '{}' }))!.status).toBe(403);
    expect(await (await call('/api/review/app'))!.json()).toMatchObject({ status: 'none' });
  });
});
