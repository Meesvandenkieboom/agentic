import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { runAgent, type AgentRequest } from './agent';
import { buildContext, type ContextPack, type GuidanceFile } from './context';
import { isCommentable, parseHunks, type ChangedFile, type Hunk, type Side } from './diff';
import {
  MODE_VERDICTS, reviewerSchema, reviewerSystem, verifierPrompt, verifierSchema, verifierSystem,
  type Pass, type RawFinding, type RawReply, type ReviewerOutput, type VerifierOutput,
} from './prompts';
import type { EngineInput, EngineResult, Finding, PriorThread, Reply, ReplyVerdict } from './types';

type Limits = Pick<AgentRequest<unknown>, 'effort' | 'maxTurns' | 'maxBudgetUsd'>;
type Candidate = Finding & { claim: RawFinding };

const JOB_BUDGET_USD = 12;
const MAX_CANDIDATES = 12;
const VERIFY_CONCURRENCY = 4;
const MIN_CONFIDENCE = 0.7;
const PASSES: Record<Pass, Limits & { scopes: readonly string[] }> = {
  correctness: { effort: 'high', maxTurns: 60, maxBudgetUsd: 4, scopes: ['change', 'preexisting'] },
  intent: { effort: 'medium', maxTurns: 40, maxBudgetUsd: 2, scopes: ['intent'] },
};
const VERIFIER: Limits = { effort: 'high', maxTurns: 25, maxBudgetUsd: 0.75 };
const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

export const normalizeTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
export function titleOverlap(a: string, b: string): number {
  const x = new Set(normalizeTitle(a).split(' ').filter(Boolean)), y = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  let both = 0;
  for (const word of x) if (y.has(word)) both++;
  return x.size + y.size ? both / (x.size + y.size - both) : 0;
}
export const fingerprint = (scope: string, path: string, title: string) =>
  createHash('sha1').update(`${scope}|${path}|${normalizeTitle(title)}`).digest('hex').slice(0, 10);

const byPriority = (a: Finding, b: Finding) => RANK[a.priority] - RANK[b.priority] || b.confidence - a.confidence;
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
/** Repo-relative path, or '' when the model named something outside the repository. */
const cleanPath = (path: string, roots: string[]) => {
  let p = path.trim();
  for (const root of roots) if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  p = p.replace(/^\.\//, '');
  return p.startsWith('/') || p.startsWith('~') || p.split('/').includes('..') ? '' : p;
};

export function toCandidate(raw: RawFinding, roots: string[]): Candidate | null {
  const path = cleanPath(raw.path, roots), title = raw.title.trim(), ref = raw.guideline_ref;
  if (!path || !title || raw.line < 1) return null;
  return {
    scope: raw.scope, priority: raw.priority, title, body: raw.body.trim(), path, side: raw.side, inline: false,
    startLine: raw.start_line !== null && raw.start_line >= 1 && raw.start_line < raw.line ? raw.start_line : null, line: raw.line,
    confidence: clamp01(raw.confidence), fingerprint: fingerprint(raw.scope, path, title),
    guidelineRef: ref && { path: cleanPath(ref.path, roots), startLine: ref.start_line, endLine: ref.end_line, kind: ref.kind },
    suggestion: raw.suggestion, claim: raw,
  };
}

/** Same spot and mostly the same words: keep the higher priority, then the one citing a guideline. */
export function dedupe<T extends Finding>(items: T[]): T[] {
  const kept: T[] = [];
  const better = (a: T, b: T) => RANK[a.priority] - RANK[b.priority] || Number(!!b.guidelineRef) - Number(!!a.guidelineRef) || b.confidence - a.confidence;
  for (const f of [...items].sort(better)) {
    if (!kept.some(k => k.path === f.path && Math.abs(k.line - f.line) <= 3 && titleOverlap(k.title, f.title) >= 0.5)) kept.push(f);
  }
  return kept;
}

export const matchesThread = (f: Finding, threads: PriorThread[]) => threads.some(t => t.fingerprint === f.fingerprint
  || (t.path === f.path && t.line !== null && Math.abs(t.line - f.line) <= 10 && titleOverlap(t.title, f.title) >= 0.5));

export function mergeCandidates(outputs: Partial<Record<Pass, ReviewerOutput | null>>, threads: PriorThread[], roots: string[]): Candidate[] {
  const all = (Object.keys(PASSES) as Pass[]).flatMap(pass => (outputs[pass]?.findings ?? [])
    .filter(f => PASSES[pass].scopes.includes(f.scope))
    .flatMap(f => toCandidate(f, roots) ?? []));
  return dedupe(all).filter(f => !matchesThread(f, threads)).sort(byPriority).slice(0, MAX_CANDIDATES);
}

/** At most one reply per thread, never answering ourselves, and resolved threads only reopen on a live problem. */
export function eligibleReplies(replies: RawReply[], threads: PriorThread[]): { reply: RawReply; thread: PriorThread }[] {
  const byId = new Map(threads.map(t => [String(t.rootCommentId), t]));
  const seen = new Set<PriorThread>();
  return replies.flatMap(reply => {
    const thread = byId.get(reply.thread_comment_id.trim());
    if (!thread || seen.has(thread) || thread.comments.at(-1)?.isBot || !reply.body.trim()) return [];
    if (thread.resolved && reply.verdict !== 'still_present' && reply.verdict !== 'partially_fixed') return [];
    seen.add(thread);
    return [{ reply, thread }];
  });
}

/** GitHub rejects inline comments outside one hunk; move the anchor into it or fall back to the review body. */
export function anchorLines(hunks: Hunk[], side: Side, startLine: number | null, line: number): { startLine: number | null; line: number; inline: boolean } {
  const ok = (a: number, b: number) => isCommentable(hunks, side, a, b);
  let start = startLine !== null && startLine < line ? startLine : null, end = line, inline = ok(end, end);
  for (let l = end - 1; !inline && start !== null && l >= start; l--) if (ok(l, l)) { end = l; inline = true; }
  if (start !== null && (start >= end || end - start + 1 > 15 || (inline && !ok(start, end)))) start = null;
  return { startLine: start, line: end, inline };
}

export function anchorFinding(f: Finding, files: ChangedFile[], guidance: Map<string, GuidanceFile>): Finding {
  const anchor = anchorLines(parseHunks(files.find(x => x.filename === f.path)?.patch), f.side, f.startLine, f.line);
  const ref = f.guidelineRef, guide = ref && guidance.get(ref.path);
  // Inferred evidence points at code (already confined to the repo by cleanPath), not at a guidance file.
  const refOk = !!ref && ref.startLine >= 1 && ref.startLine <= ref.endLine
    && (guide ? ref.endLine <= guide.lines.length : ref.kind === 'inferred' && !!ref.path && ref.endLine - ref.startLine <= 50);
  const moved = anchor.line !== f.line || anchor.startLine !== f.startLine;
  return { ...f, ...anchor, guidelineRef: refOk ? ref : null, suggestion: anchor.inline && !moved && f.side === 'RIGHT' ? f.suggestion : null };
}

export function capFindings(items: Finding[]): Finding[] {
  const out: Finding[] = [];
  let p2 = 0, preexisting = 0;
  for (const f of [...items].sort(byPriority)) {
    if (out.length >= 10) break;
    if ((f.priority === 'P2' && p2 >= 5) || (f.scope === 'preexisting' && preexisting >= 3)) continue;
    out.push(f);
    if (f.priority === 'P2') p2++;
    if (f.scope === 'preexisting') preexisting++;
  }
  return out;
}

function applyVerdict(c: Candidate, v: VerifierOutput, roots: string[]): Finding | null {
  if ((v.verdict !== 'confirmed' && v.verdict !== 'downgraded') || v.priority === 'P3' || v.confidence < MIN_CONFIDENCE) return null;
  if (v.scope === 'preexisting' && v.priority === 'P2') return null;
  const path = cleanPath(v.path, roots) || c.path, title = v.title.trim() || c.title, line = v.line >= 1 ? v.line : c.line;
  // Intent backed only by inferred evidence is capped at P1.
  const priority = v.scope === 'intent' && c.guidelineRef?.kind !== 'written' && v.priority === 'P0' ? 'P1' : v.priority;
  return {
    scope: v.scope, priority, title, body: v.body.trim() || c.body, path, side: v.side, inline: false,
    startLine: v.start_line !== null && v.start_line >= 1 && v.start_line < line ? v.start_line : null, line,
    confidence: clamp01(v.confidence), fingerprint: fingerprint(v.scope, path, title), guidelineRef: c.guidelineRef, suggestion: v.suggestion,
  };
}

function guidelineExcerpt(pack: ContextPack, ref: Finding['guidelineRef']): string | null {
  const guide = ref && pack.guidance.get(ref.path);
  const lines = ref && guide ? guide.lines.slice(Math.max(0, ref.startLine - 1), ref.endLine) : [];
  return ref && lines.length ? `${ref.path} (${ref.kind}):\n${lines.join('\n')}` : null;
}

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}

export async function runReview(input: EngineInput): Promise<EngineResult> {
  const pack = await buildContext(input);
  const roots = [input.worktree, realpathSync(input.worktree)];
  const instructions = input.repo.instructions;
  let costUsd = 0, budgetHit = false;
  const run = async <T>(label: string, system: string[], prompt: string, schema: AgentRequest<T>['schema'], limits: Limits): Promise<T | null> => {
    const result = await runAgent({ label, worktree: input.worktree, model: input.settings.model, system, prompt, schema, signal: input.signal, log: input.log, ...limits });
    costUsd += result.costUsd;
    return result.output;
  };

  const [correctness, intent] = await Promise.all((['correctness', 'intent'] as const).map(pass =>
    run(pass, reviewerSystem(pass, instructions), pack.prompt(pass), reviewerSchema, PASSES[pass])));
  input.signal.throwIfAborted();
  if (!correctness && !intent) throw new Error('Both review passes failed.');
  input.log(`Finders: correctness ${correctness ? `${correctness.findings.length} findings, ${correctness.replies.length} replies` : 'failed'}; intent ${intent ? `${intent.findings.length} findings` : 'failed'}; $${costUsd.toFixed(2)}`);

  const candidates = mergeCandidates({ correctness, intent }, input.priorThreads, roots);
  const replies: Reply[] = [];
  // Withdrawals are verified too: anyone can reply "this is guarded" under a P0.
  const rechecks = eligibleReplies(correctness?.replies ?? [], input.priorThreads);

  const verify = async (mode: 'candidate' | 'recheck', label: string, claim: unknown, path: string, ref: Finding['guidelineRef']) => {
    if (input.signal.aborted) return null;
    if (costUsd >= JOB_BUDGET_USD) {
      if (!budgetHit) input.log(`Job budget of $${JOB_BUDGET_USD} reached; remaining claims stay unverified.`);
      budgetHit = true;
      return null;
    }
    const prompt = verifierPrompt({ mode, job: pack.job, claim, mergeBase: input.mergeBase, diff: pack.diffFor(path), guideline: guidelineExcerpt(pack, ref) });
    const v = await run(label, verifierSystem(instructions), prompt, verifierSchema, VERIFIER);
    return v && (MODE_VERDICTS[mode] as readonly string[]).includes(v.verdict) ? v : null;
  };
  const verdicts = await pool([
    ...candidates.map(c => () => verify('candidate', `verify ${c.path}:${c.line}`, c.claim, c.path, c.guidelineRef)),
    ...rechecks.map(({ reply, thread }) => () => verify('recheck', `recheck ${thread.rootCommentId}`, {
      prior_finding: {
        comment_id: thread.rootCommentId, title: thread.title, path: thread.path, line: thread.line ?? 'outdated',
        original_commit: thread.originalCommit, resolved: thread.resolved,
        comments: thread.comments.map(c => ({ author: c.author, bot: c.isBot, body: c.body.slice(0, 2000) })),
      },
      proposed: { verdict: reply.verdict, body: reply.body, evidence: reply.evidence },
    }, thread.path, null)),
  ], VERIFY_CONCURRENCY);
  input.signal.throwIfAborted();

  const confirmed = candidates.flatMap((c, i) => {
    const v = verdicts[i];
    return v ? applyVerdict(c, v, roots) ?? [] : [];
  });
  rechecks.forEach(({ thread }, i) => {
    const v = verdicts[candidates.length + i];
    if (!v || v.confidence < MIN_CONFIDENCE || (thread.resolved && v.verdict === 'fixed')) return;
    const at = cleanPath(v.path, roots);
    replies.push({ thread, verdict: v.verdict as ReplyVerdict, body: v.body.trim(), evidence: at ? `${at}:${v.line}` : null });
  });
  const findings = capFindings(dedupe(confirmed).filter(f => !matchesThread(f, input.priorThreads)).map(f => anchorFinding(f, input.files, pack.guidance)));
  const minorNotes = [...(correctness?.minor_notes ?? []), ...(intent?.minor_notes ?? [])]
    .map(n => ({ path: cleanPath(n.path, roots), line: n.line, title: n.title.trim() }))
    .filter((n, i, all) => n.path && n.title && n.line >= 1 && all.findIndex(m => m.path === n.path && normalizeTitle(m.title) === normalizeTitle(n.title)) === i)
    .slice(0, 3);
  const verified = verdicts.slice(0, candidates.length).filter(Boolean).length;
  input.log(`Verified ${verified}/${candidates.length} candidates; posting ${findings.length} findings and ${replies.length} replies; $${costUsd.toFixed(2)}`);

  return {
    summary: (correctness ?? intent)!.summary.trim(),
    findings, minorNotes, replies,
    coverage: { ...pack.coverage, candidates: candidates.length, verified, unverified: candidates.length - verified },
    costUsd,
  };
}
