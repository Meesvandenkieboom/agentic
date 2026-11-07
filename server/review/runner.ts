import { triggerLabel } from '../../shared/review';
import { GitHubError, type GitHubClient } from './github';
import type { ReviewCheckouts } from './git';
import type { ReviewPublisher } from './publish';
import type { JobRow, ReviewStore } from './store';
import type { EngineInput, EngineResult } from './types';
import { counts } from './render';

const MAX_ATTEMPTS = 3;
const JOB_TIMEOUT = 30 * 60_000;

/** Runs one review at a time: checkout → engine → publish. */
export class ReviewRunner {
  private current: { job: JobRow; abort: AbortController } | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private store: ReviewStore, private gh: GitHubClient, private publisher: ReviewPublisher,
    private checkouts: ReviewCheckouts, private engine: (input: EngineInput) => Promise<EngineResult>) {}

  get runningJobId(): number | null { return this.current?.job.id ?? null; }
  start(): void { this.stopped = false; this.wake(); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.current?.abort.abort(); }

  wake(): void {
    if (this.stopped || this.current) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runNext(), 0);
    this.timer.unref();
  }

  /** Aborts the running job if it matches; queued jobs are cancelled by the store. */
  abortWhere(match: (job: JobRow) => boolean, reason = 'Cancelled.'): void {
    if (this.current && match(this.current.job)) this.current.abort.abort(new Error(reason));
  }

  async runNext(): Promise<void> {
    if (this.current || this.stopped) return;
    const job = this.store.nextQueued();
    if (!job) return;
    const abort = new AbortController();
    this.current = { job, abort };
    const timedOut = new Error(`Timed out after ${JOB_TIMEOUT / 60_000} minutes.`);
    const timeout = setTimeout(() => abort.abort(timedOut), JOB_TIMEOUT);
    const live = () => { if (abort.signal.aborted) throw new Error('aborted'); };
    const repo = this.store.repo(job.repo_id);
    let worktree: string | null = null;
    let retryDelay = 0;
    try {
      this.store.updateJob(job.id, { attempts: job.attempts + 1 });
      const skip = (status: 'cancelled' | 'failed', error: string) => { this.store.transition(job.id, ['queued'], status, { error }); };
      if (!repo?.enabled || repo.removed) return skip('cancelled', 'Agentic Review is off for this repository.');
      if (job.attempts + 1 > MAX_ATTEMPTS) return skip('failed', `Gave up after ${MAX_ATTEMPTS} attempts.`);
      const pr = await this.publisher.pull(repo, job.pr);
      if (pr.state !== 'open') return skip('cancelled', 'The pull request is closed.');
      if (job.pinned_sha && pr.head.sha !== job.pinned_sha) return skip('cancelled', 'New commits were pushed to this fork after the review was requested. Comment again to review them.');
      const headSha = pr.head.sha;
      if (!this.store.transition(job.id, ['queued'], 'running', { head_sha: headSha, started_at: Date.now(), error: null })) return;
      await this.publisher.updateSummary(repo, job.pr).catch(() => undefined);

      live();
      const token = await this.gh.installationToken(repo.installation_id, { repository_ids: [repo.id], permissions: { contents: 'read' } });
      worktree = await this.checkouts.checkout(repo.id, repo.full_name, job.pr, pr.base.ref, headSha, job.id, token);
      live();
      const mergeBase = await this.checkouts.mergeBase(worktree, pr.base.ref);
      const [files, commits, priorThreads] = await Promise.all([
        this.publisher.files(repo, job.pr), this.publisher.commits(repo, job.pr), this.publisher.threads(repo, job.pr),
      ]);
      live();
      const previous = this.store.prJobs(repo.id, job.pr).find(j => j.id !== job.id && j.status === 'done' && j.head_sha);
      const result = await this.engine({
        worktree, headSha, mergeBase, files, priorThreads,
        repo: { fullName: repo.full_name, instructions: repo.instructions },
        pr: { number: job.pr, title: pr.title, body: pr.body ?? '', author: pr.user?.login ?? 'unknown', baseRef: pr.base.ref, headRef: pr.head.ref, commits },
        trigger: { kind: job.kind, focus: job.focus },
        lastReviewedSha: previous?.head_sha ?? null,
        settings: this.store.settings(),
        signal: abort.signal,
        log: message => console.log(`🔎 [review ${repo.full_name}#${job.pr}] ${message}`),
      });
      live();

      const ctx = { fullName: repo.full_name, headSha, mergeBase, trigger: triggerLabel(job.kind, job.actor) };
      const posted = await this.publisher.postReview(repo, job.pr, result, ctx, new Set(files.map(f => f.filename)));
      await this.publisher.postReplies(repo, job.pr, result, ctx);
      // Once posted, the review exists on GitHub; record it as done even if a cancel raced the post.
      this.store.transition(job.id, ['running', 'cancelled'], 'done', {
        review_url: posted.url, findings: JSON.stringify(counts(result)), cost_usd: result.costUsd,
        error: posted.withheld ? `${posted.withheld} finding(s) withheld because they looked like they contained secrets.` : null,
      });
      console.log(`✅ [review ${repo.full_name}#${job.pr}] posted ${result.findings.length} finding(s), $${result.costUsd.toFixed(2)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        const reason = abort.signal.reason;
        // stop() during shutdown leaves the job for the next start; explicit cancels already set their status.
        if (this.stopped) this.store.transition(job.id, ['running'], 'queued');
        else this.store.transition(job.id, ['running', 'queued'], reason === timedOut ? 'failed' : 'cancelled', { error: reason instanceof Error ? reason.message : 'Cancelled.' });
      } else if (error instanceof GitHubError && error.retryAt) {
        // Rate limits are GitHub's pacing, not a failed attempt.
        this.store.transition(job.id, ['running', 'queued'], 'queued', { attempts: job.attempts, error: message });
        retryDelay = Math.max(5_000, error.retryAt - Date.now());
      } else {
        console.error(`❌ [review ${repo?.full_name}#${job.pr}]`, message);
        const retry = /unreachable|\(5\d\d\)|timed out|ECONN/i.test(message) && job.attempts + 1 < MAX_ATTEMPTS;
        if (retry) { this.store.transition(job.id, ['running', 'queued'], 'queued', { error: message }); retryDelay = 60_000; }
        else this.store.transition(job.id, ['running', 'queued'], 'failed', { error: message.slice(0, 500) });
      }
    } finally {
      clearTimeout(timeout);
      if (worktree) await this.checkouts.release(job.repo_id, worktree).catch(() => undefined);
      if (repo) await this.publisher.updateSummary(repo, job.pr).catch(() => undefined);
      this.current = null;
      if (retryDelay) { this.timer = setTimeout(() => this.wake(), retryDelay); this.timer.unref(); } else this.wake();
    }
  }
}
