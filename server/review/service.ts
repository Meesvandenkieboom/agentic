import { randomUUID } from 'node:crypto';
import { reviewModels, triggerLabel, type ReviewAppState, type ReviewJob, type ReviewRepo, type ReviewSettings } from '../../shared/review';
import { GitHubClient, type AppCredentials, type GitHubFetch } from './github';
import { ReviewCheckouts } from './git';
import { ReviewPoller } from './poller';
import { ReviewPublisher } from './publish';
import { ReviewRunner } from './runner';
import { ReviewStore, type JobRow, type RepoRow } from './store';
import { triggerPhrase } from './triggers';
import type { EngineInput, EngineResult } from './types';

const POLL_INTERVAL = 60_000;
const SYNC_INTERVAL = 10 * 60_000;

export class ReviewService {
  readonly gh: GitHubClient;
  private poller: ReviewPoller;
  private publisher: ReviewPublisher;
  private runner: ReviewRunner;
  private checkouts: ReviewCheckouts;
  private states = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private stopped = true;
  private lastPollAt: number | null = null;
  private lastSyncAt = 0;
  private lastError: string | null = null;

  constructor(readonly store: ReviewStore, dataDir: string, engine: (input: EngineInput) => Promise<EngineResult>, fetcher?: GitHubFetch) {
    this.gh = new GitHubClient(() => store.app(), fetcher);
    this.publisher = new ReviewPublisher(store, this.gh);
    this.checkouts = new ReviewCheckouts(dataDir);
    this.runner = new ReviewRunner(store, this.gh, this.publisher, this.checkouts, engine);
    this.poller = new ReviewPoller(store, this.gh, {
      queued: async ({ repo, pr, commentId, commentKind }) => {
        if (commentId && commentKind) await this.publisher.react(repo, commentKind, commentId);
        await this.publisher.updateSummary(repo, pr).catch(error => console.warn('Agentic Review summary update failed:', error.message));
        this.runner.wake();
      },
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.store.requeueInterrupted();
    await this.checkouts.cleanup().catch(() => undefined);
    this.runner.start();
    this.schedule(5_000);
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.pushTimer); this.runner.stop(); }

  private schedule(delay: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll().finally(() => this.schedule(this.gh.lowOnQuota ? POLL_INTERVAL * 4 : POLL_INTERVAL)), delay);
    this.timer.unref();
  }

  /** A chat agent just ran `git push`: check GitHub shortly instead of waiting for the next minute tick. */
  pollSoon(): void {
    if (this.stopped || !this.store.app()) return;
    clearTimeout(this.pushTimer);
    // GitHub needs a moment to show a new PR; the second check catches PRs opened right after the push.
    this.pushTimer = setTimeout(() => {
      void this.poll();
      this.pushTimer = setTimeout(() => void this.poll(), 25_000);
      this.pushTimer.unref();
    }, 8_000);
    this.pushTimer.unref();
  }

  async poll(): Promise<void> {
    if (this.polling || !this.store.app() || this.gh.rateLimitedUntil > Date.now()) return;
    this.polling = true;
    try {
      if (Date.now() - this.lastSyncAt > SYNC_INTERVAL) await this.sync();
      const errors: string[] = [];
      for (const repo of this.store.enabledRepos()) {
        await this.poller.pollRepo(repo).catch(error => errors.push(`${repo.full_name}: ${error instanceof Error ? error.message : error}`));
      }
      this.lastPollAt = Date.now();
      this.lastError = errors[0] ?? null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally { this.polling = false; }
  }

  async sync(): Promise<void> {
    this.lastSyncAt = Date.now();
    await this.poller.syncInstallations();
  }

  state(): ReviewAppState {
    const app = this.store.app();
    const installations = this.store.installations();
    return {
      status: !app ? 'none' : installations.some(i => !i.suspended) ? 'installed' : 'created',
      ...(app ? {
        app: { slug: app.slug, name: app.name, htmlUrl: app.htmlUrl, owner: app.owner, ownerType: app.ownerType },
        installUrl: `https://github.com/apps/${app.slug}/installations/new`, trigger: triggerPhrase(app.slug),
      } : {}),
      installations, settings: this.store.settings(), lastPollAt: this.lastPollAt, lastError: this.lastError, running: this.runner.runningJobId,
    };
  }

  /** Before the install redirect lands (or if it never does), the settings page discovers installations itself. */
  async refreshIfPending(): Promise<void> {
    if (this.store.app() && this.state().status === 'created' && Date.now() - this.lastSyncAt > 10_000) await this.sync().catch(() => undefined);
  }

  newState(): string {
    const now = Date.now();
    for (const [key, at] of this.states) if (now - at > 60 * 60_000) this.states.delete(key);
    const state = randomUUID();
    this.states.set(state, now);
    return state;
  }
  consumeState(state: string | null): boolean { return !!state && this.states.delete(state); }

  async completeManifest(code: string): Promise<AppCredentials> {
    const { data } = await this.gh.request<{ id: number; client_id: string; slug: string; name: string; html_url: string; pem: string; owner: { login: string; type: string } }>(
      'none', 'POST', `/app-manifests/${encodeURIComponent(code)}/conversions`);
    const app: AppCredentials = { id: data.id, clientId: data.client_id, slug: data.slug, name: data.name, htmlUrl: data.html_url, owner: data.owner.login, ownerType: data.owner.type, pem: data.pem };
    this.runner.abortWhere(() => true, 'A new GitHub App was set up.');
    this.store.clearApp();
    this.store.setApp(app);
    return app;
  }

  /** installation_id in the setup redirect is user-controlled; only trust it if our app JWT can see it. */
  async confirmInstallation(id: number): Promise<void> {
    await this.gh.request('app', 'GET', `/app/installations/${id}`);
    await this.sync();
    void this.poll();
  }

  forgetApp(): void {
    this.runner.abortWhere(() => true, 'The GitHub App was disconnected.');
    for (const repo of this.store.repos()) this.checkouts.removeCache(repo.id);
    this.store.clearApp();
    this.lastError = null; this.lastPollAt = null;
  }

  updateSettings(input: Partial<ReviewSettings>): ReviewSettings {
    if (input.model !== undefined && !reviewModels.some(m => m.id === input.model)) throw new Error('Unknown model.');
    const next = { ...this.store.settings(), ...(input.model ? { model: input.model } : {}) };
    this.store.setSettings(next);
    return next;
  }

  updateRepo(id: number, patch: { enabled?: boolean; automatic?: boolean; instructions?: string }): ReviewRepo | null {
    const row = this.store.updateRepo(id, patch);
    if (!row) return null;
    if (!row.enabled) { this.runner.abortWhere(job => job.repo_id === id, 'Agentic Review was turned off for this repository.'); this.checkouts.removeCache(id); }
    if (patch.enabled) void this.poll();
    return this.repoDto(row);
  }

  repos(): ReviewRepo[] { return this.store.repos().map(r => this.repoDto(r)); }
  private repoDto(r: RepoRow): ReviewRepo {
    const last = this.store.lastJob(r.id);
    return {
      id: r.id, fullName: r.full_name, private: !!r.private, enabled: !!r.enabled, automatic: !!r.automatic, instructions: r.instructions,
      lastReview: last ? { pr: last.pr, status: last.status, at: last.finished_at ?? last.started_at ?? last.created_at, url: last.review_url ?? `https://github.com/${r.full_name}/pull/${last.pr}` } : null,
    };
  }

  jobs(limit: number): ReviewJob[] {
    const names = new Map(this.store.db.query<{ id: number; full_name: string }, []>('SELECT id, full_name FROM review_repos').all().map(r => [r.id, r.full_name]));
    return this.store.jobs(limit).map((j: JobRow) => {
      const repo = names.get(j.repo_id) ?? 'unknown';
      return {
        id: j.id, repo, pr: j.pr, prUrl: `https://github.com/${repo}/pull/${j.pr}`, kind: j.kind, trigger: triggerLabel(j.kind, j.actor),
        actor: j.actor, focus: j.focus, headSha: j.head_sha, status: j.status, error: j.error, reviewUrl: j.review_url,
        findings: j.findings ? JSON.parse(j.findings) : null, costUsd: j.cost_usd, createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at,
      };
    });
  }

  cancelJob(id: number): boolean {
    const job = this.store.job(id);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return false;
    this.store.finishJob(id, 'cancelled', { error: 'Cancelled from Agentic.' });
    this.runner.abortWhere(j => j.id === id);
    const repo = this.store.repo(job.repo_id);
    if (repo) void this.publisher.updateSummary(repo, job.pr).catch(() => undefined);
    return true;
  }
}
