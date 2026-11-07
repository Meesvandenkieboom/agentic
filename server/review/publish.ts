import { GitHubError, type GitHubClient, type GitHubResponse } from './github';
import type { ChangedFile } from './diff';
import type { RepoRow, ReviewStore } from './store';
import type { EngineResult, Finding, PriorThread } from './types';
import { containsSecret, renderFinding, renderReply, renderReviewBody, renderSummary, type RenderContext } from './render';

export interface PullRequest {
  number: number; state: string; title: string; body: string | null; html_url: string; user: { login: string } | null;
  head: { sha: string; ref: string }; base: { ref: string };
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
  reviewThreads(first:50,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line
  comments(first:30){nodes{databaseId body createdAt author{login __typename} originalCommit{oid}}}}}}}}`;

interface ThreadNode {
  id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null;
  comments: { nodes: { databaseId: number; body: string; createdAt: string; author: { login: string; __typename: string } | null; originalCommit: { oid: string } | null }[] };
}

interface ThreadsPage { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ThreadNode[] }
interface ThreadsResponse { data?: { repository: { pullRequest: { reviewThreads: ThreadsPage } } }; errors?: { message: string }[] }

/** Everything the reviewer writes to or reads from a pull request. */
export class ReviewPublisher {
  constructor(private store: ReviewStore, private gh: GitHubClient) {}

  private slug(): string { return this.store.app()?.slug ?? 'agentic-review'; }
  private isOurs(login: string | undefined): boolean { return login === this.slug() || login === `${this.slug()}[bot]`; }

  async react(repo: RepoRow, kind: 'issue' | 'review', commentId: number): Promise<void> {
    const path = kind === 'issue' ? 'issues/comments' : 'pulls/comments';
    await this.gh.request(repo.installation_id, 'POST', `/repos/${repo.full_name}/${path}/${commentId}/reactions`, { content: 'eyes' }).catch(() => undefined);
  }

  /** One status comment per PR, edited in place as reviews progress. */
  async updateSummary(repo: RepoRow, pr: number): Promise<void> {
    const jobs = this.store.prJobs(repo.id, pr);
    if (!jobs.length) return;
    const body = renderSummary(jobs, this.slug());
    const existing = this.store.pr(repo.id, pr)?.summary_comment_id;
    try {
      if (existing) { await this.gh.request(repo.installation_id, 'PATCH', `/repos/${repo.full_name}/issues/comments/${existing}`, { body }); return; }
    } catch (error) { if (!(error instanceof GitHubError && error.status === 404)) throw error; }
    const { data } = await this.gh.request<{ id: number }>(repo.installation_id, 'POST', `/repos/${repo.full_name}/issues/${pr}/comments`, { body });
    this.store.setSummaryComment(repo.id, pr, data.id);
  }

  async pull(repo: RepoRow, pr: number): Promise<PullRequest> {
    return (await this.gh.request<PullRequest>(repo.installation_id, 'GET', `/repos/${repo.full_name}/pulls/${pr}`)).data;
  }
  files(repo: RepoRow, pr: number): Promise<ChangedFile[]> {
    return this.gh.paginate<ChangedFile>(repo.installation_id, `/repos/${repo.full_name}/pulls/${pr}/files?per_page=100`);
  }
  async commits(repo: RepoRow, pr: number): Promise<{ sha: string; subject: string }[]> {
    const list = await this.gh.paginate<{ sha: string; commit: { message: string } }>(repo.installation_id, `/repos/${repo.full_name}/pulls/${pr}/commits?per_page=100`, undefined, 250);
    return list.slice(-50).map(c => ({ sha: c.sha, subject: c.commit.message.split('\n')[0] }));
  }

  async threads(repo: RepoRow, pr: number): Promise<PriorThread[]> {
    const [owner, name] = repo.full_name.split('/');
    const nodes: ThreadNode[] = [];
    let cursor: string | null = null;
    do {
      const response: GitHubResponse<ThreadsResponse> = await this.gh.request<ThreadsResponse>(
        repo.installation_id, 'POST', '/graphql', { query: THREADS_QUERY, variables: { owner, name, number: pr, cursor } });
      const { data } = response;
      if (data.errors?.length || !data.data) throw new Error(`GitHub GraphQL failed: ${data.errors?.[0]?.message ?? 'no data'}`);
      const page: ThreadsPage = data.data.repository.pullRequest.reviewThreads;
      nodes.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor && nodes.length < 500);
    return nodes.filter(t => this.isOurs(t.comments.nodes[0]?.author?.login)).map(t => {
      const root = t.comments.nodes[0];
      return {
        threadId: t.id, rootCommentId: root.databaseId,
        fingerprint: root.body.match(/<!-- agentic-review v1 fp=(\w+)/)?.[1] ?? null,
        title: (([, a, b]) => a ?? b)(root.body.match(/^(?:!\[P\d\]\([^)]*\) \*\*(.+?)\*\*|\*\*\S+ P\d · (.+?)\*\*)/) ?? []) ?? root.body.split('\n')[0].slice(0, 100),
        path: t.path, line: t.line, originalCommit: root.originalCommit?.oid ?? '', resolved: t.isResolved, outdated: t.isOutdated,
        comments: t.comments.nodes.map(c => ({ author: c.author?.login ?? 'ghost', isBot: this.isOurs(c.author?.login), body: c.body, createdAt: c.createdAt })),
      };
    });
  }

  /** Posts the review; falls back to a body-only review, then to a plain comment, so findings are never lost to a 422. */
  async postReview(repo: RepoRow, pr: number, result: EngineResult, ctx: RenderContext, changedPaths: Set<string>): Promise<{ url: string; withheld: number }> {
    const safe = result.findings.filter(f => !containsSecret(`${f.title}\n${f.body}\n${f.suggestion ?? ''}`));
    const clean: EngineResult = { ...result, findings: safe, summary: containsSecret(result.summary) ? '' : result.summary };
    const inline = new Set<Finding>(safe.filter(f => f.inline).slice(0, 50));
    const comments = [...inline].map(f => ({
      path: f.path, line: f.line, side: f.side, body: renderFinding(f, ctx),
      ...(f.startLine && f.startLine < f.line ? { start_line: f.startLine, start_side: f.side } : {}),
    }));
    // Findings off the diff lines but in a changed file become file-level threads: threads are what
    // "Require conversation resolution before merging" blocks on. Only untouched files stay body-only.
    const threaded = new Set<Finding>();
    for (const f of safe.filter(f => !inline.has(f) && changedPaths.has(f.path)).slice(0, 20)) {
      try {
        await this.gh.request(repo.installation_id, 'POST', `/repos/${repo.full_name}/pulls/${pr}/comments`,
          { body: renderFinding(f, ctx), commit_id: ctx.headSha, path: f.path, subject_type: 'file' });
        threaded.add(f);
      } catch (error) { if (!(error instanceof GitHubError && error.status === 422)) throw error; }
    }
    const endpoint = `/repos/${repo.full_name}/pulls/${pr}/reviews`;
    type Review = { id: number; html_url: string };
    try {
      const { data } = await this.gh.request<Review>(repo.installation_id, 'POST', endpoint,
        { commit_id: ctx.headSha, event: 'COMMENT', body: renderReviewBody(clean, new Set([...inline, ...threaded]), ctx), comments });
      return { url: data.html_url, withheld: result.findings.length - safe.length };
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) throw error;
    }
    const body = renderReviewBody(clean, threaded, ctx);
    try {
      const { data } = await this.gh.request<Review>(repo.installation_id, 'POST', endpoint, { event: 'COMMENT', body });
      return { url: data.html_url, withheld: result.findings.length - safe.length };
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) throw error;
      const { data } = await this.gh.request<{ html_url: string }>(repo.installation_id, 'POST', `/repos/${repo.full_name}/issues/${pr}/comments`, { body });
      return { url: data.html_url, withheld: result.findings.length - safe.length };
    }
  }

  async postReplies(repo: RepoRow, pr: number, result: EngineResult, ctx: RenderContext): Promise<void> {
    for (const reply of result.replies) {
      if (containsSecret(reply.body)) continue;
      await this.gh.request(repo.installation_id, 'POST', `/repos/${repo.full_name}/pulls/${pr}/comments/${reply.thread.rootCommentId}/replies`,
        { body: renderReply(reply, ctx) });
      // Only a verified fix closes a thread; withdrawals stay open for the maintainer to resolve.
      if (reply.verdict === 'fixed' && !reply.thread.resolved) {
        await this.gh.request(repo.installation_id, 'POST', '/graphql', {
          query: 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', variables: { id: reply.thread.threadId },
        }).catch(() => undefined);
      }
    }
  }
}
