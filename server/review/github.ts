import { createSign } from 'node:crypto';

export interface AppCredentials {
  id: number; clientId: string; slug: string; name: string; htmlUrl: string;
  owner: string; ownerType: string; pem: string;
}
export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface GitHubResponse<T> { status: number; data: T; etag: string | null; headers: Headers }
type Auth = 'none' | 'app' | number; // number = installation id

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt = 0) { super(message); }
}

export function appJwt(clientId: string, pem: string, now = Date.now()): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60;
  const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 540, iss: clientId })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(pem, 'base64url')}`;
}

/** App + installation auth, conditional GETs, and a serialized write lane for GitHub's secondary limits. */
export class GitHubClient {
  private tokens = new Map<number, { token: string; expiresAt: number }>();
  private writes: Promise<unknown> = Promise.resolve();
  private lastWrite = 0;
  rateLimitedUntil = 0;
  lowOnQuota = false;

  constructor(private credentials: () => AppCredentials | null, private fetcher: GitHubFetch = fetch, private now = Date.now) {}

  private app(): AppCredentials {
    const app = this.credentials();
    if (!app) throw new GitHubError('Agentic Review GitHub App is not set up.', 0);
    return app;
  }

  async installationToken(installationId: number, scope?: { repository_ids: number[]; permissions: Record<string, string> }): Promise<string> {
    const cached = scope ? undefined : this.tokens.get(installationId);
    if (cached && cached.expiresAt - this.now() > 5 * 60_000) return cached.token;
    const { data } = await this.call<{ token: string; expires_at: string }>('app', 'POST', `/app/installations/${installationId}/access_tokens`, scope);
    if (!scope) this.tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  async request<T>(auth: Auth, method: string, path: string, body?: unknown, etag?: string | null): Promise<GitHubResponse<T>> {
    if (method === 'GET') return this.call<T>(auth, method, path, body, etag);
    const run = this.writes.then(async () => {
      const wait = this.lastWrite + 1000 - this.now();
      if (wait > 0) await Bun.sleep(wait);
      try { return await this.call<T>(auth, method, path, body); } finally { this.lastWrite = this.now(); }
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Follows rel=next for list endpoints; `pick` extracts the array from wrapped responses. */
  async paginate<T>(auth: Auth, path: string, pick?: (page: unknown) => T[], limit = 3000): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    while (next && items.length < limit) {
      const { data, headers }: GitHubResponse<unknown> = await this.call<unknown>(auth, 'GET', next);
      items.push(...(pick ? pick(data) : data as T[]));
      next = headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return items;
  }

  private async call<T>(auth: Auth, method: string, path: string, body?: unknown, etag?: string | null, retried = false): Promise<GitHubResponse<T>> {
    if (this.rateLimitedUntil > this.now()) throw new GitHubError('GitHub rate limit reached.', 429, this.rateLimitedUntil);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agentic-review',
    };
    if (auth === 'app') { const app = this.app(); headers.Authorization = `Bearer ${appJwt(app.clientId, app.pem, this.now())}`; }
    else if (typeof auth === 'number') headers.Authorization = `Bearer ${await this.installationToken(auth)}`;
    if (etag) headers['If-None-Match'] = etag;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetcher(path.startsWith('https://') ? path : `${API}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new GitHubError('GitHub is unreachable.', 0); }

    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const limit = Number(response.headers.get('x-ratelimit-limit'));
    if (limit > 0 && Number.isFinite(remaining)) this.lowOnQuota = remaining < limit * 0.1;
    if (response.status === 304) return { status: 304, data: null as T, etag: etag ?? null, headers: response.headers };
    if (response.status === 401 && typeof auth === 'number' && !retried) {
      this.tokens.delete(auth);
      return this.call<T>(auth, method, path, body, etag, true);
    }
    if (response.status === 429 || (response.status === 403 && (remaining === 0 || response.headers.has('retry-after')))) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      this.rateLimitedUntil = retryAfter > 0 ? this.now() + retryAfter * 1000 : reset > 0 ? reset * 1000 : this.now() + 60_000;
      throw new GitHubError('GitHub rate limit reached.', response.status, this.rateLimitedUntil);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new GitHubError(`GitHub ${method} ${path.split('?')[0]} failed (${response.status}): ${data?.message ?? 'unknown error'}`, response.status);
    return { status: response.status, data: data as T, etag: response.headers.get('etag'), headers: response.headers };
  }
}
