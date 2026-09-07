import { Database } from 'bun:sqlite';
import { defaultTelegramPreferences, type TelegramPreferences, type TelegramSettings } from '../../shared/telegram';
import type { NotificationKind } from './format';

interface Config extends TelegramPreferences { token: string }
interface Delivery {
  id: string; session_id: string; turn_id: string; kind: NotificationKind;
  body: string; attempts: number; expires_at: number;
}
export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;
const MAX_AGE = 60 * 60 * 1000;

/** One local outbox and one sender; no Telegram polling or inbound commands. */
export class TelegramNotifications {
  private config: Config;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  private stopped = true;
  private abort: AbortController | undefined;
  private revision = 0;
  private lastError: string | null = null;

  constructor(private db: Database, private fetcher: TelegramFetch = fetch, private now = Date.now) {
    db.run(`CREATE TABLE IF NOT EXISTS telegram_settings (id INTEGER PRIMARY KEY CHECK(id = 1), config TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS telegram_outbox (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0
    )`);
    db.run('CREATE INDEX IF NOT EXISTS telegram_due ON telegram_outbox(done, due_at)');
    const stored = db.query<{ config: string }, []>('SELECT config FROM telegram_settings WHERE id = 1').get();
    this.config = stored ? JSON.parse(stored.config) : { ...defaultTelegramPreferences, token: '' };
    // Questions belong to live runtime requests; after restart their validity is
    // unknown. Keep only terminal notifications for retry across restarts.
    db.run("UPDATE telegram_outbox SET done = 1, body = '' WHERE kind = 'question'");
  }

  settings(): TelegramSettings {
    const { token, ...preferences } = this.config;
    return { ...preferences, hasToken: !!token, lastError: this.lastError };
  }

  update(input: unknown): TelegramSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings.');
    const body = input as Record<string, unknown>;
    const next = { ...this.config };
    for (const key of ['enabled', 'finished', 'errors', 'questions'] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
        next[key] = body[key];
      }
    }
    if (body.userId !== undefined) {
      if (typeof body.userId !== 'string') throw new Error('Enter a numeric Telegram user ID.');
      const id = body.userId.trim();
      if (id && (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error('Enter a positive numeric Telegram user ID.');
      next.userId = id;
    }
    if (body.token !== undefined) {
      if (typeof body.token !== 'string') throw new Error('Invalid bot token.');
      const token = body.token.trim();
      if (token && !/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error('Invalid bot token format.');
      next.token = token;
    }
    this.db.transaction(() => {
      this.db.run('INSERT OR REPLACE INTO telegram_settings (id, config) VALUES (1, ?)', [JSON.stringify(next)]);
      // Never deliver queued content to a changed recipient or replay disabled events.
      if (next.userId !== this.config.userId || next.token !== this.config.token || !next.enabled) {
        this.db.run("UPDATE telegram_outbox SET done = 1, body = '' WHERE done = 0");
      } else {
        for (const [kind, enabled] of [['finished', next.finished], ['error', next.errors], ['question', next.questions]]) {
          if (!enabled) this.db.run("UPDATE telegram_outbox SET done = 1, body = '' WHERE kind = ?", [String(kind)]);
        }
      }
    })();
    this.config = next;
    this.revision++;
    this.abort?.abort();
    this.lastError = null;
    return this.settings();
  }

  configured(): boolean { return this.config.enabled && !!this.config.token && !!this.config.userId; }
  private enabled(kind: NotificationKind): boolean {
    return this.configured() && this.config[kind === 'error' ? 'errors' : kind === 'question' ? 'questions' : 'finished'];
  }

  enqueue(id: string, sessionId: string, turnId: string, kind: NotificationKind, body: string): void {
    if (!this.enabled(kind)) return;
    this.db.run(`INSERT OR IGNORE INTO telegram_outbox
      (id, session_id, turn_id, kind, body, due_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, sessionId, turnId, kind, body, this.now(), this.now() + MAX_AGE]);
    this.wake();
  }

  resolveQuestion(id: string): void {
    this.db.run("UPDATE telegram_outbox SET done = 1, body = '' WHERE id = ? AND kind = 'question'", [id]);
  }
  endTurn(turnId: string): void {
    this.db.run("UPDATE telegram_outbox SET done = 1, body = '' WHERE turn_id = ? AND kind = 'question'", [turnId]);
  }

  start(): void { this.stopped = false; this.wake(); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.abort?.abort(); }
  private wake(): void {
    if (this.stopped || this.sending) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.drain().catch(() => { this.lastError = 'Could not process Telegram notifications.'; })
        .finally(() => this.wakeAfterDelay());
    }, 0);
    this.timer.unref();
  }
  private wakeAfterDelay(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.wake(), 1500);
    this.timer.unref();
  }

  /** Processes at most one message at a time, preserving chat event ordering. */
  async drain(): Promise<void> {
    if (this.sending) return;
    this.db.run('DELETE FROM telegram_outbox WHERE expires_at <= ?', [this.now()]);
    const row = this.db.query<Delivery, [number]>(
      'SELECT * FROM telegram_outbox WHERE done = 0 AND due_at <= ? ORDER BY due_at, rowid LIMIT 1',
    ).get(this.now());
    if (!row) return;
    if (!this.enabled(row.kind)) { this.complete(row.id); return; }
    this.sending = true;
    const revision = this.revision;
    this.abort = new AbortController();
    const attempt = row.attempts + 1;
    // Count before sending so repeated process crashes cannot retry forever.
    this.db.run('UPDATE telegram_outbox SET attempts = ?, due_at = ? WHERE id = ?', [attempt, this.now() + 30_000, row.id]);
    try {
      if (attempt > 5) { this.complete(row.id); return; }
      await this.send(row.body, this.abort.signal);
      this.complete(row.id);
      if (revision === this.revision) this.lastError = null;
    } catch (error) {
      if (revision !== this.revision || this.abort?.signal.aborted) return;
      const failure = error instanceof TelegramError ? error : new TelegramError('Telegram is temporarily unreachable.', true);
      this.lastError = failure.message;
      if (!failure.retryable || attempt >= 5) this.complete(row.id);
      else this.db.run('UPDATE telegram_outbox SET due_at = ? WHERE id = ?',
        [this.now() + Math.max(failure.retryAfterMs, Math.min(60_000, 2000 * 2 ** (attempt - 1))), row.id]);
    } finally { this.sending = false; this.abort = undefined; }
  }

  private complete(id: string): void { this.db.run("UPDATE telegram_outbox SET done = 1, body = '' WHERE id = ?", [id]); }

  async test(): Promise<void> {
    if (!this.configured()) throw new Error('Enable Telegram and save a bot token and user ID first.');
    try {
      await this.send('<b>✅ Agentic notifications</b>\nTelegram notifications are working.', new AbortController().signal);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof TelegramError ? error.message : 'Telegram is temporarily unreachable.';
      throw new Error(this.lastError);
    }
  }

  private async send(text: string, signal: AbortSignal): Promise<void> {
    // Do not expose fetch exceptions: Telegram puts the bot token in the URL.
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.config.userId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
    } catch { throw new TelegramError('Telegram is temporarily unreachable.', true); }
    const data = await response.json().catch(() => null) as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (response.ok && data?.ok === true) return;
    const code = data?.error_code || response.status;
    if (code === 401) throw new TelegramError('Telegram rejected the bot token. Check it in settings.', false);
    if (code === 403 || code === 400) throw new TelegramError('Telegram could not message this user. Check the user ID and press Start in the bot chat.', false);
    const retryAfter = data?.parameters?.retry_after;
    throw new TelegramError(code === 429 ? 'Telegram is rate limiting notifications; delivery will retry.' : 'Telegram is temporarily unavailable.',
      code === 429 || code >= 500 || response.ok, typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0);
  }
}
class TelegramError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(message); }
}
