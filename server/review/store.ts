import { Database } from 'bun:sqlite';
import type { AppCredentials } from './github';
import { defaultReviewSettings, type ReviewJobKind, type ReviewJobStatus, type ReviewSettings } from '../../shared/review';

export interface RepoRow {
  id: number; installation_id: number; full_name: string; private: number; enabled: number; automatic: number;
  enabled_at: number | null; automatic_since: number | null; removed: number; instructions: string;
}
export interface PrRow { repo_id: number; number: number; draft: number; head_sha: string; summary_comment_id: number | null }
export interface JobRow {
  id: number; trigger_key: string; repo_id: number; pr: number; kind: ReviewJobKind; comment_id: number | null;
  comment_kind: 'issue' | 'review' | null; actor: string | null; focus: string; head_sha: string | null;
  pinned_sha: string | null; status: ReviewJobStatus; attempts: number; error: string | null; review_url: string | null; findings: string | null;
  cost_usd: number | null; created_at: number; started_at: number | null; finished_at: number | null;
}
export interface Installation { id: number; account: string; suspended: boolean }
export type NewJob = Pick<JobRow, 'trigger_key' | 'repo_id' | 'pr' | 'kind'> & Partial<Pick<JobRow, 'comment_id' | 'comment_kind' | 'actor' | 'focus' | 'status' | 'error' | 'pinned_sha'>>;

export class ReviewStore {
  constructor(readonly db: Database, private now = Date.now) {
    db.run('PRAGMA journal_mode = WAL');
    db.run('CREATE TABLE IF NOT EXISTS review_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run(`CREATE TABLE IF NOT EXISTS review_repos (
      id INTEGER PRIMARY KEY, installation_id INTEGER NOT NULL, full_name TEXT NOT NULL, private INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, automatic INTEGER NOT NULL DEFAULT 0, enabled_at INTEGER, automatic_since INTEGER,
      removed INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '')`);
    db.run(`CREATE TABLE IF NOT EXISTS review_prs (
      repo_id INTEGER NOT NULL, number INTEGER NOT NULL, draft INTEGER NOT NULL, head_sha TEXT NOT NULL,
      summary_comment_id INTEGER, PRIMARY KEY (repo_id, number))`);
    db.run(`CREATE TABLE IF NOT EXISTS review_cursors (
      repo_id INTEGER NOT NULL, endpoint TEXT NOT NULL, etag TEXT, cursor TEXT, PRIMARY KEY (repo_id, endpoint))`);
    db.run(`CREATE TABLE IF NOT EXISTS review_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_key TEXT NOT NULL UNIQUE, repo_id INTEGER NOT NULL, pr INTEGER NOT NULL,
      kind TEXT NOT NULL, comment_id INTEGER, comment_kind TEXT, actor TEXT, focus TEXT NOT NULL DEFAULT '', head_sha TEXT, pinned_sha TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, review_url TEXT, findings TEXT, cost_usd REAL,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`);
    db.run('CREATE INDEX IF NOT EXISTS review_jobs_queue ON review_jobs(status, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS review_jobs_pr ON review_jobs(repo_id, pr)');
  }

  private get<T>(key: string): T | null {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM review_kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) as T : null;
  }
  private set(key: string, value: unknown): void {
    if (value === null) this.db.run('DELETE FROM review_kv WHERE key = ?', [key]);
    else this.db.run('INSERT OR REPLACE INTO review_kv (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }
  app(): AppCredentials | null { return this.get<AppCredentials>('app'); }
  setApp(app: AppCredentials | null): void { this.set('app', app); }
  installations(): Installation[] { return this.get<Installation[]>('installations') ?? []; }
  setInstallations(list: Installation[]): void { this.set('installations', list); }
  settings(): ReviewSettings { return { ...defaultReviewSettings, ...this.get<Partial<ReviewSettings>>('settings') }; }
  setSettings(settings: ReviewSettings): void { this.set('settings', settings); }

  /** Forget everything tied to the app; review history is kept. */
  clearApp(): void {
    this.db.transaction(() => {
      this.set('app', null); this.set('installations', null);
      this.db.run('DELETE FROM review_repos'); this.db.run('DELETE FROM review_prs'); this.db.run('DELETE FROM review_cursors');
      this.db.run("UPDATE review_jobs SET status = 'cancelled', finished_at = ? WHERE status IN ('queued', 'running')", [this.now()]);
    })();
  }

  repos(): RepoRow[] { return this.db.query<RepoRow, []>('SELECT * FROM review_repos WHERE removed = 0 ORDER BY full_name COLLATE NOCASE').all(); }
  repo(id: number): RepoRow | null { return this.db.query<RepoRow, [number]>('SELECT * FROM review_repos WHERE id = ?').get(id); }
  enabledRepos(): RepoRow[] { return this.db.query<RepoRow, []>('SELECT * FROM review_repos WHERE enabled = 1 AND removed = 0').all(); }

  /** Upserts the installation's current repo set; vanished repos are disabled and their queue cancelled. */
  syncRepos(repos: { id: number; installation_id: number; full_name: string; private: boolean }[]): void {
    this.db.transaction(() => {
      const seen = new Set(repos.map(r => r.id));
      for (const r of repos) {
        this.db.run(`INSERT INTO review_repos (id, installation_id, full_name, private) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name,
          private = excluded.private, removed = 0`, [r.id, r.installation_id, r.full_name, r.private ? 1 : 0]);
      }
      for (const old of this.db.query<{ id: number }, []>('SELECT id FROM review_repos WHERE removed = 0').all()) {
        if (seen.has(old.id)) continue;
        this.db.run('UPDATE review_repos SET removed = 1, enabled = 0, automatic = 0 WHERE id = ?', [old.id]);
        this.cancelQueued(old.id, 'Repository access was removed.');
      }
    })();
  }

  updateRepo(id: number, patch: { enabled?: boolean; automatic?: boolean; instructions?: string }): RepoRow | null {
    const repo = this.repo(id);
    if (!repo || repo.removed) return null;
    const enabled = patch.enabled ?? !!repo.enabled;
    const automatic = enabled && (patch.automatic ?? !!repo.automatic);
    this.db.transaction(() => {
      this.db.run(`UPDATE review_repos SET enabled = ?, automatic = ?, enabled_at = ?, automatic_since = ?, instructions = ? WHERE id = ?`, [
        enabled ? 1 : 0, automatic ? 1 : 0,
        enabled ? (repo.enabled ? repo.enabled_at : this.now()) : null,
        automatic ? (repo.automatic ? repo.automatic_since : this.now()) : null,
        patch.instructions ?? repo.instructions, id,
      ]);
      // Re-enabling must not replay comments or draft→ready transitions from the disabled period.
      if (enabled && !repo.enabled) {
        this.db.run('DELETE FROM review_cursors WHERE repo_id = ?', [id]);
        this.db.run('UPDATE review_prs SET draft = 0 WHERE repo_id = ?', [id]);
      }
      if (!enabled) this.cancelQueued(id, 'Agentic Review was turned off for this repository.');
    })();
    return this.repo(id);
  }

  pr(repoId: number, number: number): PrRow | null {
    return this.db.query<PrRow, [number, number]>('SELECT * FROM review_prs WHERE repo_id = ? AND number = ?').get(repoId, number);
  }
  hasPrs(repoId: number): boolean { return !!this.db.query('SELECT 1 FROM review_prs WHERE repo_id = ? LIMIT 1').get(repoId); }
  savePr(repoId: number, number: number, draft: boolean, headSha: string): void {
    this.db.run(`INSERT INTO review_prs (repo_id, number, draft, head_sha) VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_id, number) DO UPDATE SET draft = excluded.draft, head_sha = excluded.head_sha`, [repoId, number, draft ? 1 : 0, headSha]);
  }
  setSummaryComment(repoId: number, number: number, commentId: number): void {
    this.db.run(`INSERT INTO review_prs (repo_id, number, draft, head_sha, summary_comment_id) VALUES (?, ?, 0, '', ?)
      ON CONFLICT(repo_id, number) DO UPDATE SET summary_comment_id = excluded.summary_comment_id`, [repoId, number, commentId]);
  }

  cursor(repoId: number, endpoint: string): { etag: string | null; cursor: string | null } {
    return this.db.query<{ etag: string | null; cursor: string | null }, [number, string]>(
      'SELECT etag, cursor FROM review_cursors WHERE repo_id = ? AND endpoint = ?').get(repoId, endpoint) ?? { etag: null, cursor: null };
  }
  setCursor(repoId: number, endpoint: string, etag: string | null, cursor: string | null): void {
    this.db.run('INSERT OR REPLACE INTO review_cursors (repo_id, endpoint, etag, cursor) VALUES (?, ?, ?, ?)', [repoId, endpoint, etag, cursor]);
  }

  /** Returns the new job, or null when the trigger was already recorded. */
  addJob(job: NewJob): JobRow | null {
    const result = this.db.run(`INSERT OR IGNORE INTO review_jobs
      (trigger_key, repo_id, pr, kind, comment_id, comment_kind, actor, focus, pinned_sha, status, error, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      job.trigger_key, job.repo_id, job.pr, job.kind, job.comment_id ?? null, job.comment_kind ?? null, job.actor ?? null,
      job.focus ?? '', job.pinned_sha ?? null, job.status ?? 'queued', job.error ?? null, this.now(), job.status && job.status !== 'queued' ? this.now() : null,
    ]);
    return result.changes ? this.job(Number(result.lastInsertRowid)) : null;
  }
  everReviewed(repoId: number, pr: number): boolean {
    return !!this.db.query("SELECT 1 FROM review_jobs WHERE repo_id = ? AND pr = ? AND status IN ('queued', 'running', 'done') LIMIT 1").get(repoId, pr);
  }
  hasTrigger(key: string): boolean { return !!this.db.query('SELECT 1 FROM review_jobs WHERE trigger_key = ?').get(key); }
  job(id: number): JobRow | null { return this.db.query<JobRow, [number]>('SELECT * FROM review_jobs WHERE id = ?').get(id); }
  queuedFor(repoId: number, pr: number): JobRow | null {
    return this.db.query<JobRow, [number, number]>("SELECT * FROM review_jobs WHERE repo_id = ? AND pr = ? AND status = 'queued' LIMIT 1").get(repoId, pr);
  }
  nextQueued(): JobRow | null { return this.db.query<JobRow, []>("SELECT * FROM review_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get(); }
  jobs(limit = 50): JobRow[] { return this.db.query<JobRow, [number]>('SELECT * FROM review_jobs ORDER BY id DESC LIMIT ?').all(limit); }
  prJobs(repoId: number, pr: number): JobRow[] {
    return this.db.query<JobRow, [number, number]>(`SELECT * FROM review_jobs WHERE repo_id = ? AND pr = ? AND status != 'skipped'
      ORDER BY id DESC LIMIT 10`).all(repoId, pr);
  }
  lastJob(repoId: number): JobRow | null {
    return this.db.query<JobRow, [number]>("SELECT * FROM review_jobs WHERE repo_id = ? AND status != 'skipped' ORDER BY id DESC LIMIT 1").get(repoId);
  }
  updateJob(id: number, patch: Partial<Omit<JobRow, 'id'>>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.run(`UPDATE review_jobs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => (patch as Record<string, string | number | null>)[k]), id]);
  }
  /** Status change that only applies while the job is still in one of `from` (guards cancel/abort races). */
  transition(id: number, from: ReviewJobStatus[], status: ReviewJobStatus, patch: Partial<Omit<JobRow, 'id' | 'status'>> = {}): boolean {
    const keys = Object.keys(patch);
    const result = this.db.run(`UPDATE review_jobs SET status = ?${keys.map(k => `, ${k} = ?`).join('')}${status === 'queued' || status === 'running' ? '' : ', finished_at = ?'}
      WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`, [
      status, ...keys.map(k => (patch as Record<string, string | number | null>)[k]),
      ...(status === 'queued' || status === 'running' ? [] : [this.now()]), id, ...from,
    ]);
    return result.changes > 0;
  }
  finishJob(id: number, status: ReviewJobStatus, patch: Partial<Omit<JobRow, 'id'>> = {}): void {
    this.updateJob(id, { ...patch, status, finished_at: this.now() });
  }
  cancelQueued(repoId: number, reason: string, pr?: number): void {
    this.db.run(`UPDATE review_jobs SET status = 'cancelled', error = ?, finished_at = ? WHERE repo_id = ? AND status = 'queued'
      ${pr === undefined ? '' : 'AND pr = ?'}`, [reason, this.now(), repoId, ...(pr === undefined ? [] : [pr])]);
  }
  /** Runs left `running` by a crash go back to the queue. */
  requeueInterrupted(): void { this.db.run("UPDATE review_jobs SET status = 'queued' WHERE status = 'running'"); }
}
