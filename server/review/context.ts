import { runGit } from './agent';
import { numberPatch, parseHunks, type ChangedFile, type Hunk, type Side } from './diff';
import { fence, type Pass } from './prompts';
import type { EngineInput, EngineResult, PriorThread } from './types';

const CHARS_PER_TOKEN = 3.5;
const GUIDANCE_CHARS = 12_000 * CHARS_PER_TOKEN;
const DIFF_CHARS = 50_000 * CHARS_PER_TOKEN;
const DELTA_CHARS = 15_000 * CHARS_PER_TOKEN;
const FILE_CHANGED_LINES = 600;
const DOC_LINES = 150;
const NESTED = ['REVIEW.md', 'AGENTS.md', 'CLAUDE.md'];
const ROOT_ONLY = ['.agentic/review.md', '.github/copilot-instructions.md', 'ARCHITECTURE.md', 'README.md'];
const ARCH_DOC = /^docs\/architecture[^/]*\.md$/;
const RULES_FILE = /(^|\/)REVIEW\.md$|^\.agentic\/review\.md$/;
const LOCKFILE = /(^|\/)([^/]+\.lock|package-lock\.json|bun\.lockb|pnpm-lock\.yaml)$/;
const VENDORED = /(^|\/)(vendor|node_modules|dist|build|target)\//;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/;
const CONFIG_DOCS = /\.(md|mdx|rst|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|env|example)$|(^|\/)(Dockerfile|Makefile|LICENSE|\.gitignore)$|^\.github\//;
const STATUS: Record<string, string> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'T', unchanged: 'U' };

export interface GuidanceFile { path: string; lines: string[]; total: number }
export interface ContextPack {
  job: string;
  prompt(pass: Pass): string;
  guidance: Map<string, GuidanceFile>;
  diffFor(path: string): string | null;
  coverage: Pick<EngineResult['coverage'], 'reviewed' | 'total' | 'skipped' | 'truncated' | 'guidance' | 'guidanceEditedByPr'>;
}
interface Rules { dir: string; hot: string[]; ignore: string[] }

export function guidanceCandidates(paths: string[]): string[] {
  const dirs = new Set(['']);
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...ROOT_ONLY, ...[...dirs].flatMap(dir => NESTED.map(name => dir ? `${dir}/${name}` : name))];
}

export function parseFrontMatter(text: string): { hot_paths: string[]; ignore: string[] } {
  const out = { hot_paths: [] as string[], ignore: [] as string[] };
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?(\n|$)/);
  for (const line of block ? block[1].split(/\r?\n/) : []) {
    const kv = line.match(/^(hot_paths|ignore):\s*(.*)$/);
    if (!kv) continue;
    try {
      const value: unknown = JSON.parse(kv[2]);
      if (Array.isArray(value)) out[kv[1] as 'hot_paths' | 'ignore'] = value.filter((g): g is string => typeof g === 'string' && g.length > 0);
    } catch { /* a malformed key is ignored rather than failing the review */ }
  }
  return out;
}

/** Globs in a nested REVIEW.md are relative to its directory and only cover files below it. */
export const ruleMatch = (rules: Rules[], key: 'hot' | 'ignore', path: string) => rules.some(r =>
  (!r.dir || path.startsWith(`${r.dir}/`)) && r[key].some(g => new Bun.Glob(g).match(r.dir ? path.slice(r.dir.length + 1) : path)));

export function skipReason(file: ChangedFile, ignored: boolean): string | null {
  const path = file.filename;
  if (LOCKFILE.test(path)) return 'lockfile';
  if (VENDORED.test(path)) return 'vendored or build output';
  if (path.endsWith('.min.js')) return 'minified';
  if (ignored) return 'ignored by REVIEW.md';
  if (!file.patch) return file.additions + file.deletions > 0 ? null : 'binary or no textual change';
  if (file.patch.split('\n', 12).some(line => /@generated|DO NOT EDIT/.test(line))) return 'generated';
  return null;
}

const dirOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const guidanceTier = (path: string) => RULES_FILE.test(path) ? 0 : /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path) ? 1 : path === '.github/copilot-instructions.md' ? 2 : 3;
const appliesTo = (guide: string, path: string) => guidanceTier(guide) < 2
  ? !dirOf(guide) || guide.startsWith('.agentic/') || path.startsWith(`${dirOf(guide)}/`)
  : guidanceTier(guide) === 2;

/** Reads guidance at the merge-base so a PR can't rewrite the rules it is judged by. */
async function loadGuidance(worktree: string, mergeBase: string, candidates: string[]): Promise<{ path: string; text: string }[]> {
  const listed = await runGit(worktree, ['ls-tree', '--name-only', '-z', mergeBase, '--', ...candidates, 'docs/'], 1 << 20);
  // Silently reviewing without the repo's rules would be worse than failing the job.
  if (listed.code !== 0) throw new Error(`Couldn't list guidance files at the merge-base: ${listed.stderr.trim()}`);
  const wanted = new Set(candidates);
  const found = listed.stdout.split('\0').filter(path => wanted.has(path) || ARCH_DOC.test(path));
  return Promise.all(found.map(async path => ({ path, text: (await runGit(worktree, ['show', `${mergeBase}:${path}`], 256 * 1024)).stdout })));
}

export function selectGuidance(files: { path: string; text: string }[], budget = GUIDANCE_CHARS): Map<string, GuidanceFile> {
  const out = new Map<string, GuidanceFile>();
  const depth = (path: string) => path.split('/').length;
  const sorted = [...files].sort((a, b) => guidanceTier(a.path) - guidanceTier(b.path) || depth(b.path) - depth(a.path) || a.path.localeCompare(b.path));
  for (const { path, text } of sorted) {
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    const tier = guidanceTier(path);
    const numbered = all.slice(0, tier === 3 ? DOC_LINES : undefined).map((line, i) => `L${i + 1}| ${line}`);
    let shown = numbered.length, used = numbered.reduce((sum, line) => sum + line.length + 1, 0);
    // REVIEW.md is never truncated; everything else loses its tail to the remaining budget.
    if (tier > 0) for (shown = 0, used = 0; shown < numbered.length && used + numbered[shown].length + 1 <= budget; shown++) used += numbered[shown].length + 1;
    if (shown === 0) continue;
    budget -= used;
    out.set(path, { path, lines: numbered.slice(0, shown), total: all.length });
  }
  return out;
}

const rangeList = (hunks: Hunk[], side: Side) => hunks
  .map(h => side === 'RIGHT' ? [h.newStart, h.newEnd] : [h.oldStart, h.oldEnd])
  .filter(([start, end]) => end >= start).map(([start, end]) => `${start}-${end}`).join(',');
export function commentableRanges(hunks: Hunk[]): string {
  const right = rangeList(hunks, 'RIGHT'), left = rangeList(hunks, 'LEFT');
  return [right && `RIGHT ${right}`, left && `LEFT ${left}`].filter(Boolean).join(' ') || 'none';
}

export function renderFile(file: ChangedFile, hot: boolean, mergeBase: string): { text: string; partial: boolean } {
  const lines = (file.patch ?? '').split('\n');
  let changed = 0, cut = lines.length;
  for (let i = 0; i < lines.length; i++) if (/^[+-]/.test(lines[i]) && ++changed > FILE_CHANGED_LINES) { cut = i; break; }
  const more = cut < lines.length ? `\n… ${lines.length - cut} more lines: git diff ${mergeBase} HEAD -- ${file.filename}` : '';
  const header = `=== ${file.filename} (${STATUS[file.status] ?? '?'} +${file.additions} -${file.deletions}) ${hot ? '[HOT] ' : ''}commentable ${commentableRanges(parseHunks(file.patch))} ===`;
  return { text: `${header}\n${numberPatch(lines.slice(0, cut).join('\n'))}${more}`, partial: !!more };
}

function renderThreads(threads: PriorThread[], pass: Pass): string {
  if (!threads.length) return '';
  const body = pass === 'intent'
    ? threads.map(t => `- ${t.path}: ${fence(t.title)}`)
    : threads.map(t => [
      `<thread comment_id="${t.rootCommentId}" fingerprint="${t.fingerprint ?? 'none'}" path="${t.path}" line="${t.line ?? 'outdated'}" resolved="${t.resolved}" commit="${t.originalCommit}">`,
      `title: ${fence(t.title)}`,
      ...t.comments.map(c => `- @${c.author}${c.isBot ? ' [bot]' : ''}: ${fence(c.body.slice(0, 2000))}`),
      '</thread>',
    ].join('\n'));
  return `<prior_threads trust="untrusted">\n${body.join('\n')}\n</prior_threads>`;
}

async function renderDelta(worktree: string, sha: string | null): Promise<string> {
  if (!sha) return '';
  const known = /^[0-9a-f]{7,64}$/i.test(sha) && (await runGit(worktree, ['cat-file', '-e', `${sha}^{commit}`])).code === 0;
  const diff = known ? await runGit(worktree, ['diff', sha, 'HEAD'], DELTA_CHARS * 2) : null;
  if (!diff || diff.code !== 0) return '<delta>force-pushed or unavailable</delta>';
  const text = diff.stdout.length > DELTA_CHARS || diff.truncated ? `${diff.stdout.slice(0, DELTA_CHARS)}\n… delta truncated: git diff ${sha} HEAD` : diff.stdout;
  return `<delta trust="untrusted" since="${sha}">\n${fence(text.trim() || '(no changes since the last review)')}\n</delta>`;
}

export async function buildContext(input: EngineInput): Promise<ContextPack> {
  const { pr, mergeBase } = input;
  const candidates = guidanceCandidates(input.files.map(f => f.filename));
  const [loaded, delta] = await Promise.all([loadGuidance(input.worktree, mergeBase, candidates), renderDelta(input.worktree, input.lastReviewedSha)]);
  const guidance = selectGuidance(loaded);
  const rules: Rules[] = loaded.filter(g => RULES_FILE.test(g.path)).map(g => {
    const fm = parseFrontMatter(g.text);
    return { dir: g.path.startsWith('.agentic/') ? '' : dirOf(g.path), hot: fm.hot_paths, ignore: fm.ignore };
  });
  const candidateSet = new Set(candidates);

  const files = input.files.map((file, order) => {
    const path = file.filename, hot = ruleMatch(rules, 'hot', path);
    const rank = hot ? 0 : TEST.test(path) ? 2 : CONFIG_DOCS.test(path) ? 3 : 1;
    return { file, order, hot, rank, skip: skipReason(file, ruleMatch(rules, 'ignore', path)), shown: '' as '' | 'full' | 'partial' | 'none' };
  });
  const diffs: string[] = [];
  let budget = DIFF_CHARS;
  for (const f of [...files].sort((a, b) => a.rank - b.rank || a.order - b.order)) {
    if (f.skip || !f.file.patch) continue;
    const { text, partial } = renderFile(f.file, f.hot, mergeBase);
    if (text.length > budget) { f.shown = 'none'; continue; }
    budget -= text.length;
    diffs.push(text);
    f.shown = partial ? 'partial' : 'full';
  }

  const fileLines = files.map(({ file, hot, skip, shown }) => {
    const tags = [hot && '[HOT]', skip === 'generated' && '[GEN]', skip && `[SKIPPED: ${skip}]`,
      !skip && !file.patch && '[NO PATCH: read with git diff]', shown === 'none' && '[NOT IN PACK: read with git diff]',
      shown === 'partial' && '[TRUNCATED: read the rest with git diff]'].filter(Boolean).join(' ');
    const applicable = [...guidance.keys()].filter(g => appliesTo(g, file.filename));
    return `- ${file.filename} (${file.status}${file.previous_filename ? ` from ${file.previous_filename}` : ''}, +${file.additions} -${file.deletions})${tags ? ` ${tags}` : ''}${applicable.length ? ` guidance: ${applicable.join(', ')}` : ''}`;
  });
  const guidanceText = [...guidance.values()].map(g =>
    `<file path="${g.path}" lines="1-${g.lines.length} of ${g.total}">\n${fence(g.lines.join('\n'))}${g.lines.length < g.total ? `\n… ${g.total - g.lines.length} more lines not shown` : ''}\n</file>`);
  const commits = pr.commits.slice(0, 50).map(c => `${c.sha.slice(0, 7)} ${c.subject}`);
  if (pr.commits.length > 50) commits.push(`… ${pr.commits.length - 50} more commits`);

  const job = `<job>\n${fence(`repo: ${input.repo.fullName}\npr: #${pr.number}\nbase: ${pr.baseRef}\nhead: ${pr.headRef}\nhead_sha: ${input.headSha}\nmerge_base: ${mergeBase}\ntrigger: ${input.trigger.kind}\nlast_reviewed_sha: ${input.lastReviewedSha ?? 'none'}`)}\n</job>`;
  const shared = [
    `Review pull request #${pr.number} in ${input.repo.fullName}. The sections below are an index of the change, not a boundary: open the full files, follow callers and callees with Read/Grep/Glob, and use mcp__repo__git (diff, show, blame, log) yourself before concluding anything.`,
    job,
    input.trigger.focus.trim() && `<focus trust="collaborator">\n${fence(input.trigger.focus.trim())}\n</focus>`,
    `<guidance>\nRepository guidance as of the merge-base ${mergeBase}. Precedence when sources conflict: <repo_instructions> > nearest REVIEW.md > nearest AGENTS.md/CLAUDE.md > root docs.\n${guidanceText.join('\n') || '(no guidance files found)'}\n</guidance>`,
    `<pr trust="untrusted">\n${fence(`title: ${pr.title}\nauthor: ${pr.author}\n\nbody:\n${pr.body.slice(0, 4000).trim() || '(empty)'}\n\ncommits (${pr.commits.length}):\n${commits.join('\n')}`)}\n</pr>`,
    `<files>\n${fileLines.join('\n')}\n</files>`,
    `<diff trust="untrusted">\n${fence(diffs.join('\n\n')) || '(no reviewable diff in the pack)'}\n</diff>`,
    delta,
  ].filter(Boolean).join('\n\n');

  return {
    job, guidance,
    prompt: pass => [shared, renderThreads(input.priorThreads, pass)].filter(Boolean).join('\n\n'),
    diffFor: path => {
      const f = files.find(x => x.file.filename === path);
      return f?.file.patch ? renderFile(f.file, f.hot, mergeBase).text : null;
    },
    coverage: {
      reviewed: files.filter(f => f.shown === 'full' || f.shown === 'partial').length, total: input.files.length,
      skipped: files.flatMap(f => f.skip ? [{ path: f.file.filename, reason: f.skip }] : []),
      truncated: files.filter(f => f.shown === 'none' || f.shown === 'partial' || (!f.skip && !f.file.patch)).map(f => f.file.filename),
      guidance: [...guidance.keys()],
      guidanceEditedByPr: input.files.filter(f => candidateSet.has(f.filename) || ARCH_DOC.test(f.filename) || (f.previous_filename && candidateSet.has(f.previous_filename))).map(f => f.filename),
    },
  };
}
