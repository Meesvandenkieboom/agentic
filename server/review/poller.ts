import { GitHubError, type GitHubClient } from './github';
import type { NewJob, RepoRow, ReviewStore } from './store';
import { isBot, parseTrigger, trustedByAssociation, type Author } from './triggers';

interface PullSummary {
  number: number; draft: boolean; created_at: string; author_association: string; user: Author | null;
  head: { sha: string; repo: { full_name: string } | null }; base: { repo: { full_name: string } };
}
interface Comment {
  id: number; body: string | null; created_at: string; updated_at: string; html_url: string;
  author_association: string; user: Author | null; issue_url?: string; pull_request_url?: string;
}
export interface QueueEvents { queued(job: { repo: RepoRow; pr: number; commentId?: number; commentKind?: 'issue' | 'review'; merged: boolean }): Promise<void> }

const MAX_COMMENT_AGE = 7 * 24 * 60 * 60_000;

/** Turns PR state changes and `@slug review` comments into jobs. Cursors make it resume after downtime. */
export class ReviewPoller {
  private permissions = new Map<string, { write: boolean; at: number }>();
  constructor(private store: ReviewStore, private gh: GitHubClient, private events: QueueEvents, private now = Date.now) {}

  async syncInstallations(): Promise<void> {
    const installations = await this.gh.paginate<{ id: number; account: { login: string } | null; suspended_at: string | null }>('app', '/app/installations?per_page=100');
    const repos: { id: number; installation_id: number; full_name: string; private: boolean }[] = [];
    for (const inst of installations) {
      if (inst.suspended_at) continue;
      const list = await this.gh.paginate<{ id: number; full_name: string; private: boolean }>(inst.id, '/installation/repositories?per_page=100',
        page => (page as { repositories: { id: number; full_name: string; private: boolean }[] }).repositories);
      repos.push(...list.map(r => ({ id: r.id, installation_id: inst.id, full_name: r.full_name, private: r.private })));
    }
    this.store.setInstallations(installations.map(i => ({ id: i.id, account: i.account?.login ?? 'unknown', suspended: !!i.suspended_at })));
    this.store.syncRepos(repos);
  }

  async pollRepo(repo: RepoRow): Promise<void> {
    await this.pollPulls(repo);
    await this.pollComments(repo, 'issue');
    await this.pollComments(repo, 'review');
  }

  private async pollPulls(repo: RepoRow): Promise<void> {
    const saved = this.store.cursor(repo.id, 'pulls');
    const res = await this.gh.request<PullSummary[]>(repo.installation_id, 'GET',
      `/repos/${repo.full_name}/pulls?state=open&sort=updated&direction=desc&per_page=50`, undefined, saved.etag);
    if (res.status === 304) return;
    const slug = this.store.app()?.slug ?? '';
    for (const pr of res.data) {
      const known = this.store.pr(repo.id, pr.number);
      this.store.savePr(repo.id, pr.number, pr.draft, pr.head.sha);
      if (!repo.automatic || pr.draft) continue;
      const opened = !known && Date.parse(pr.created_at) >= (repo.automatic_since ?? Infinity);
      const ready = !!known?.draft;
      // A push to an open PR that never got a review (e.g. opened before Automatic was on) gets its first one.
      const pushed = !!known && !opened && !ready && known.head_sha !== pr.head.sha && !this.store.everReviewed(repo.id, pr.number);
      if (!opened && !ready && !pushed) continue;
      // Forks and outside authors run on this machine with repo checkout — never automatically.
      if (pr.head.repo?.full_name !== pr.base.repo.full_name || isBot(pr.user, slug)) continue;
      if (!trustedByAssociation(pr.author_association, pr.user, slug) && !(await this.hasWriteAccess(repo, pr.user!.login))) continue;
      const kind = opened ? 'opened' : ready ? 'ready' : 'pushed';
      const key = kind === 'opened' ? `opened:${repo.id}:${pr.number}` : `${kind}:${repo.id}:${pr.number}:${pr.head.sha}`;
      await this.enqueue(repo, { trigger_key: key, repo_id: repo.id, pr: pr.number, kind, actor: pr.user?.login });
    }
    this.store.setCursor(repo.id, 'pulls', res.etag, null);
  }

  private async pollComments(repo: RepoRow, kind: 'issue' | 'review'): Promise<void> {
    const endpoint = kind === 'issue' ? 'issues/comments' : 'pulls/comments';
    const saved = this.store.cursor(repo.id, endpoint);
    const since = saved.cursor ?? new Date(repo.enabled_at ?? this.now()).toISOString();
    const url = `/repos/${repo.full_name}/${endpoint}?sort=updated&direction=asc&per_page=100&since=${since}`;
    const first = await this.gh.request<Comment[]>(repo.installation_id, 'GET', url, undefined, saved.etag);
    if (first.status === 304) return;
    const comments = [...first.data];
    const next = first.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (next) comments.push(...await this.gh.paginate<Comment>(repo.installation_id, next));

    let cursor = since;
    for (const comment of comments) {
      if (Date.parse(comment.updated_at) > Date.parse(cursor)) cursor = comment.updated_at;
      await this.handleComment(repo, kind, comment);
    }
    // Only a changed cursor changes the URL; keep the ETag when it doesn't so the next poll can 304.
    this.store.setCursor(repo.id, endpoint, cursor === since ? first.etag : null, cursor);
  }

  private async handleComment(repo: RepoRow, kind: 'issue' | 'review', comment: Comment): Promise<void> {
    const app = this.store.app();
    if (!app || !comment.body) return;
    const created = Date.parse(comment.created_at);
    if (created < (repo.enabled_at ?? Infinity) || created < this.now() - MAX_COMMENT_AGE) return;
    const prUrl = kind === 'issue' ? comment.issue_url : comment.pull_request_url;
    if (kind === 'issue' && !comment.html_url.includes('/pull/')) return;
    const pr = Number(prUrl?.split('/').pop());
    if (!pr) return;
    const focus = parseTrigger(comment.body, app.slug);
    if (focus === null) return;
    const key = `c:${repo.id}:${kind}:${comment.id}`;
    if (this.store.hasTrigger(key)) return;
    const base: NewJob = { trigger_key: key, repo_id: repo.id, pr, kind: 'comment', comment_id: comment.id, comment_kind: kind, actor: comment.user?.login, focus };
    const trusted = !isBot(comment.user, app.slug) && (trustedByAssociation(comment.author_association, comment.user, app.slug)
      || await this.hasWriteAccess(repo, comment.user!.login));
    if (!trusted) { this.store.addJob({ ...base, status: 'skipped', error: 'Only collaborators with write access can request reviews.' }); return; }
    // A maintainer's comment approves the fork's code as it is now; a later force-push must not ride on that approval.
    const { data: pull } = await this.gh.request<PullSummary>(repo.installation_id, 'GET', `/repos/${repo.full_name}/pulls/${pr}`);
    const fork = pull.head.repo?.full_name !== pull.base.repo.full_name;
    await this.enqueue(repo, fork ? { ...base, pinned_sha: pull.head.sha } : base);
  }

  private async enqueue(repo: RepoRow, job: NewJob): Promise<void> {
    if (job.kind !== 'comment' && this.store.prJobs(repo.id, job.pr).some(j => j.status === 'queued' || j.status === 'running')) return;
    const queued = this.store.queuedFor(repo.id, job.pr);
    if (queued) {
      // One queued run per PR: later requests fold into it.
      if (!this.store.addJob({ ...job, status: 'skipped', error: `Merged into queued review #${queued.id}.` })) return;
      if (job.focus) this.store.updateJob(queued.id, { focus: [queued.focus, job.focus].filter(Boolean).join('\n') });
      if (job.pinned_sha) this.store.updateJob(queued.id, { pinned_sha: job.pinned_sha });
      await this.events.queued({ repo, pr: job.pr, commentId: job.comment_id ?? undefined, commentKind: job.comment_kind ?? undefined, merged: true });
      return;
    }
    if (!this.store.addJob(job)) return;
    await this.events.queued({ repo, pr: job.pr, commentId: job.comment_id ?? undefined, commentKind: job.comment_kind ?? undefined, merged: false });
  }

  /** Errors other than 404 propagate so the poll cursor stays put and the comment is retried, not skipped. */
  private async hasWriteAccess(repo: RepoRow, login: string): Promise<boolean> {
    const key = `${repo.id}:${login}`, cached = this.permissions.get(key);
    if (cached && cached.at > this.now() - 10 * 60_000) return cached.write;
    let write = false;
    try {
      const { data } = await this.gh.request<{ permission: string }>(repo.installation_id, 'GET',
        `/repos/${repo.full_name}/collaborators/${encodeURIComponent(login)}/permission`);
      write = data.permission === 'admin' || data.permission === 'write';
    } catch (error) { if (!(error instanceof GitHubError && error.status === 404)) throw error; }
    this.permissions.set(key, { write, at: this.now() });
    return write;
  }
}
