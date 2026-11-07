import type { ReviewFindingCounts } from '../../shared/review';
import { triggerLabel } from '../../shared/review';
import type { JobRow } from './store';
import type { EngineResult, Finding, Priority, Reply } from './types';

export interface RenderContext { fullName: string; headSha: string; mergeBase: string; trigger: string }

const COLOR: Record<Priority, string> = { P0: 'red', P1: 'orange', P2: 'yellow', P3: 'lightgrey' };
// Same shields.io badges Codex Review uses; GitHub serves them through its camo image proxy.
const badge = (p: Priority, count?: number) =>
  `![${count === undefined ? p : `${p}: ${count}`}](https://img.shields.io/badge/${count === undefined ? p : `${p}-${count}`}-${COLOR[p]}?style=flat)`;
const SCOPE: Record<Finding['scope'], string> = {
  change: '`change` · introduced by this PR',
  intent: '`intent` · conflicts with repo guidance',
  preexisting: '`pre-existing` · not introduced by this PR',
};
const VERDICT: Record<Reply['verdict'], string> = {
  fixed: '✅ **Fixed**', partially_fixed: '🟡 **Partially fixed**', still_present: '🔁 **Still present**', withdrawn: '↩️ **Withdrawn**',
};
export const SUMMARY_MARKER = '<!-- agentic-review:summary v1 -->';
const short = (sha: string) => sha.slice(0, 7);

function permalink(ctx: RenderContext, path: string, side: 'LEFT' | 'RIGHT', start: number | null, end: number): string {
  const sha = side === 'LEFT' ? ctx.mergeBase : ctx.headSha;
  const lines = start && start !== end ? `L${start}-L${end}` : `L${end}`;
  return `[${path}#${lines}](https://github.com/${ctx.fullName}/blob/${sha}/${encodeURI(path)}#${lines})`;
}

function reference(f: Finding, ctx: RenderContext): string {
  const ref = f.guidelineRef;
  if (!ref) return '';
  // Written guidance is read at the merge-base; inferred evidence lives in the reviewed code.
  const sha = ref.kind === 'written' ? ctx.mergeBase : ctx.headSha;
  const lines = `L${ref.startLine}-L${ref.endLine}`;
  const label = ref.kind === 'written' ? 'Guideline' : 'Evidence';
  return `\n\n<sub>📎 ${label}: [${ref.path}:${lines}](https://github.com/${ctx.fullName}/blob/${sha}/${encodeURI(ref.path)}#${lines})</sub>`;
}

export function renderFinding(f: Finding, ctx: RenderContext): string {
  const scope = f.scope === 'intent' && f.guidelineRef?.kind === 'inferred' ? '`intent` · inferred repo constraint' : SCOPE[f.scope];
  const suggestion = f.inline && f.side === 'RIGHT' && f.suggestion !== null ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : '';
  return `${badge(f.priority)} **${f.title}**\n<sub>${scope}</sub>\n\n${f.body}${suggestion}${f.inline ? '' : `\n\n<sub>📍 ${permalink(ctx, f.path, f.side, f.startLine, f.line)}</sub>`}${reference(f, ctx)}\n`
    + `<!-- agentic-review v1 fp=${f.fingerprint} scope=${f.scope} p=${f.priority} head=${short(ctx.headSha)} -->`;
}

export function renderReply(reply: Reply, ctx: RenderContext): string {
  const evidence = reply.evidence ? ` (${reply.evidence})` : '';
  return `${VERDICT[reply.verdict]} — ${reply.body}${evidence} <sub>checked at \`${short(ctx.headSha)}\`</sub>`;
}

export function counts(result: EngineResult): ReviewFindingCounts {
  const c: ReviewFindingCounts = { P0: 0, P1: 0, P2: 0, P3: result.minorNotes.length, preexisting: 0, fixed: 0 };
  for (const f of result.findings) { c[f.priority]++; if (f.scope === 'preexisting') c.preexisting++; }
  c.fixed = result.replies.filter(r => r.verdict === 'fixed').length;
  return c;
}
const tally = (c: ReviewFindingCounts) => `${badge('P0', c.P0)} ${badge('P1', c.P1)} ${badge('P2', c.P2)}`;

/** `inline` = findings actually posted as inline comments; everything else is listed here. */
export function renderReviewBody(result: EngineResult, inline: Set<Finding>, ctx: RenderContext): string {
  const parts = [`**Agentic Review** · ${tally(counts(result))} · \`${short(ctx.headSha)}\``, result.summary || 'No P0–P2 issues found.'];
  const outside = result.findings.filter(f => !inline.has(f));
  if (outside.length) {
    parts.push('#### Outside the diff\n' + outside.map(f =>
      `- ${badge(f.priority)} **${f.title}** · ${SCOPE[f.scope].split(' · ')[0]} — ${permalink(ctx, f.path, f.side, f.startLine, f.line)}\n  ${f.body.replace(/\n/g, '\n  ')}`).join('\n'));
  }
  if (result.replies.length) {
    const n = (v: Reply['verdict']) => result.replies.filter(r => r.verdict === v).length;
    parts.push(`#### Earlier threads\n${[['fixed', '✅', 'fixed'], ['partially_fixed', '🟡', 'partially fixed'], ['still_present', '🔁', 'still present'], ['withdrawn', '↩️', 'withdrawn']]
      .filter(([v]) => n(v as Reply['verdict'])).map(([v, icon, label]) => `${icon} ${n(v as Reply['verdict'])} ${label}`).join(' · ')}`);
  }
  const cov = result.coverage;
  const coverage = [
    `Reviewed ${cov.reviewed}/${cov.total} files against merge-base \`${short(ctx.mergeBase)}\`.`
      + (cov.skipped.length ? ` Not reviewed: ${cov.skipped.map(s => `\`${s.path}\` (${s.reason})`).join(', ')}.` : '')
      + (cov.truncated.length ? ` Partially in context: ${cov.truncated.map(p => `\`${p}\``).join(', ')}.` : ''),
    cov.guidance.length ? `Guidance: ${cov.guidance.map(p => `\`${p}\``).join(', ')}${cov.guidanceEditedByPr.length ? ` (read from the base branch; this PR edits ${cov.guidanceEditedByPr.map(p => `\`${p}\``).join(', ')})` : ''}.` : 'No REVIEW.md, AGENTS.md or CLAUDE.md found.',
    `Trigger: ${ctx.trigger}. ${cov.candidates} candidate${cov.candidates === 1 ? '' : 's'} → ${cov.verified} verified${cov.unverified ? `, ${cov.unverified} dropped unverified (budget)` : ''}.`,
    ...result.minorNotes.map(n => `${badge('P3')} ${n.title} — ${permalink(ctx, n.path, 'RIGHT', null, n.line)}`),
  ];
  parts.push(`<details><summary>Coverage &amp; minor notes</summary>\n\n${coverage.join('\n\n')}\n</details>`);
  return parts.join('\n\n').slice(0, 65_000);
}

const STATUS: Record<JobRow['status'], string> = {
  queued: '⏳ Queued', running: '🔄 In progress', done: '✅ Completed', failed: '❌ Failed', cancelled: '⏹️ Cancelled', skipped: '⏹️ Skipped',
};

export function renderSummary(jobs: JobRow[], slug: string): string {
  const rows = jobs.map(job => {
    const c = job.findings ? JSON.parse(job.findings) as ReviewFindingCounts : null;
    const status = job.status === 'done' && c ? `${STATUS.done} · ${c.P0 + c.P1 + c.P2 ? tally(c) : 'no issues'}` : STATUS[job.status];
    const review = job.review_url ? `📝 [Code review](${job.review_url})` : '📝 Code review';
    const focus = job.focus ? `: “${job.focus.split('\n')[0].slice(0, 60).replace(/[|`]/g, '')}”` : '';
    return `| ${review} | ${status} | ${job.head_sha ? `\`${short(job.head_sha)}\`` : '—'} | ${triggerLabel(job.kind, job.actor)}${focus} |`;
  });
  return `${SUMMARY_MARKER}\n### Agentic Review\n\n| Review | Status | Commit | Review trigger |\n|---|---|---|---|\n${rows.join('\n')}\n\n`
    + `<sub>Comment \`@${slug} review\` to request another review; text after it sets the focus.</sub>`;
}

/** Comments that would leak key material or credentials are withheld from GitHub. */
export function containsSecret(text: string): boolean {
  return /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/.test(text)
    || /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/.test(text)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
    || /\b(?:ghp_|gho_|ghs_|github_pat_|sk-ant-)[A-Za-z0-9_-]{16,}/.test(text)
    || /[?&](?:api[-_]?key|token|access_token)=[^\s&)]{8,}/i.test(text);
}
