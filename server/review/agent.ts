import { createSdkMcpServer, query, tool, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { configureProvider } from '../providers';
import { getClaudeThinkingOptions } from '../websocket/claudeThinking';
import { toJsonSchema } from './prompts';

export interface AgentRequest<T> {
  label: string; worktree: string; model: string; effort: 'medium' | 'high';
  system: string[]; prompt: string; schema: z.ZodType<T>;
  maxTurns: number; maxBudgetUsd: number; signal: AbortSignal; log: (message: string) => void;
}
export interface AgentResult<T> { output: T | null; costUsd: number; error?: string }

const FALLBACK_MODEL = 'claude-sonnet-5-5';
const TOOLS = ['Read', 'Grep', 'Glob'];
const DISALLOWED = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'ListMcpResourcesTool', 'ReadMcpResourceTool'];
// StructuredOutput is the CLI's synthetic tool that carries the outputFormat result.
const ALLOWED = new Set([...TOOLS, 'mcp__repo__git', 'StructuredOutput']);
const AUTH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

// Exact per-command option allowlist. git expands unambiguous abbreviations (`--op=` → --open-files-in-pager)
// and grouped short flags (`-iO<cmd>`), so a blocklist can't be made safe; grep is left to the Grep tool.
const flags = (pattern: string) => new RegExp(`^(?:${pattern})$`);
const DIFF_FLAGS = '--stat|--name-only|--name-status|-p|--patch|-w|--ignore-all-space|-U\\d+|--unified=\\d+';
const GIT_FLAGS: Record<string, RegExp> = {
  log: flags(`${DIFF_FLAGS}|-n|-\\d+|-n\\d+|--max-count=\\d+|--skip=\\d+|--oneline|--follow|--first-parent|--no-merges|--reverse|--format=.*|--pretty=.*|--date=[a-z-]+|--since=.+|--until=.+|--author=.+|--grep=.+|-[SG].*|-L.*|--abbrev-commit`),
  show: flags(`${DIFF_FLAGS}|--oneline|--no-patch|-s|--format=.*|--pretty=.*`),
  diff: flags(`${DIFF_FLAGS}|-M|--find-renames|--word-diff(?:=[a-z]+)?|--merge-base`),
  blame: flags('-L(?:\\d+(?:,[+-]?\\d+)?)?|-w|-M|-e|-s|-l|--porcelain|--line-porcelain'),
  'ls-files': flags('(?!)'),
  'ls-tree': flags('-r|-t|-l|--name-only'),
  'rev-parse': flags('--short(?:=\\d+)?|--verify|--abbrev-ref'),
  'merge-base': flags('--is-ancestor|--all'),
  'cat-file': flags('-t|-p|-e|-s'),
};
const GIT_COMMANDS = Object.keys(GIT_FLAGS);
// `git diff a b` silently becomes --no-index when a path is outside the worktree, so no argument may name one.
const OUTSIDE_PATH = /(^|[=:])[/~]|(^|[=/:])\.\.(\/|$)/;

export function checkGitArgs(args: string[]): string | null {
  const allowed = GIT_FLAGS[args[0]];
  if (!allowed || !Object.hasOwn(GIT_FLAGS, args[0])) return `git ${args[0] ?? ''} is not allowed; use one of: ${GIT_COMMANDS.join(', ')}.`;
  let paths = false;
  for (const arg of args.slice(1)) {
    if (OUTSIDE_PATH.test(arg)) return `git argument ${arg} points outside the repository.`;
    if (arg === '--') { paths = true; continue; }
    if (!paths && arg.startsWith('-') && !allowed.test(arg)) return `git ${args[0]} option ${arg} is not allowed.`;
  }
  return null;
}

/** Resolves symlinks (and the deepest existing parent of a missing path) so a link in the PR can't reach outside. */
export function insideWorktree(root: string, target: string): boolean {
  if (!target || target.startsWith('~') || target.split(/[\\/]/).includes('..')) return false;
  let existing = resolve(root, target), rest = '';
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    rest = rest ? join(basename(existing), rest) : basename(existing);
    existing = parent;
  }
  const rel = relative(root, join(realpathSync(existing), rest));
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return false;
  return !rel.split(sep).includes('.git');
}

const badGlob = (pattern: unknown) => typeof pattern === 'string' && (/(^|[{,]\s*)[/~]/.test(pattern) || pattern.includes('..'));

/** Returns a denial reason, or null when the call is allowed. Shared by canUseTool and the PreToolUse hook. */
export function checkToolUse(root: string, name: string, input: Record<string, unknown>): string | null {
  if (!ALLOWED.has(name)) return `${name} is not available during review.`;
  if (name === 'StructuredOutput') return null;
  if (name === 'mcp__repo__git') {
    const args = input.args;
    return Array.isArray(args) && args.length > 0 && args.every(a => typeof a === 'string') ? checkGitArgs(args) : 'args must be a non-empty string array.';
  }
  for (const key of ['file_path', 'path']) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !insideWorktree(root, value)) return `${key} must be inside the repository worktree and outside .git.`;
  }
  if (badGlob(name === 'Glob' ? input.pattern : input.glob)) return 'Glob patterns must be relative and must not contain "..".';
  return null;
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number, overflow: () => void): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > max) { overflow(); await reader.cancel().catch(() => undefined); break; }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max)), truncated: size > max };
}

export interface GitResult { code: number; stdout: string; stderr: string; truncated: boolean }

/** Read-only git with repo-controlled config neutralized; argv only, minimal env. */
export async function runGit(cwd: string, args: string[], maxBytes = 64 * 1024, timeoutMs = 20_000): Promise<GitResult> {
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };
  for (const key of ['PATH', 'HOME']) if (process.env[key]) env[key] = process.env[key]!;
  const proc = Bun.spawn(['git', '--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', ...args],
    { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  const [out, err] = await Promise.all([readCapped(proc.stdout, maxBytes, () => proc.kill()), readCapped(proc.stderr, 8 * 1024, () => undefined)]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code: out.truncated ? 0 : timedOut ? 124 : code, stdout: out.text, stderr: timedOut ? `timed out after ${timeoutMs / 1000}s` : err.text, truncated: out.truncated };
}

function gitServer(root: string) {
  return createSdkMcpServer({ name: 'repo', version: '1.0.0', tools: [tool('git',
    `Run a read-only git command in the repository worktree (HEAD = PR head). args excludes "git"; args[0] is one of: ${GIT_COMMANDS.join(', ')}; only common read-only options are accepted (use the Grep tool to search). Example: ["show", "<merge-base>:src/lib.rs"].`,
    { args: z.array(z.string()).min(1).max(64) },
    async ({ args }) => {
      const denied = checkGitArgs(args);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const r = await runGit(root, args);
      if (r.code !== 0) return { content: [{ type: 'text', text: `git exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}` }], isError: true };
      return { content: [{ type: 'text', text: (r.stdout || '(no output)') + (r.truncated ? '\n… output truncated at 64KB; narrow the command (paths, -L, --stat).' : '') }] };
    },
    { annotations: { readOnlyHint: true } })] });
}

/** Never inherits process.env: it can hold RPC keys, wallet paths and GitHub tokens. */
function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', ...AUTH_ENV]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export async function runAgent<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
  if (req.signal.aborted) return { output: null, costUsd: 0, error: 'aborted' };
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });
  let stderr = '', costUsd = 0;
  const fail = (error: string): AgentResult<T> => {
    req.log(`${req.label}: ${error}${stderr.trim() ? ` (stderr: ${stderr.trim().slice(-500)})` : ''}`);
    return { output: null, costUsd, error };
  };
  try {
    await configureProvider('anthropic');
    const root = realpathSync(req.worktree);
    const deny: HookCallback = async input => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const reason = checkToolUse(root, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
    };
    const messages = query({ prompt: req.prompt, options: {
      cwd: root, model: req.model, ...(req.model === FALLBACK_MODEL ? {} : { fallbackModel: FALLBACK_MODEL }),
      systemPrompt: req.system, ...getClaudeThinkingOptions(req.model, req.effort),
      tools: TOOLS, disallowedTools: DISALLOWED, mcpServers: { repo: gitServer(root) }, strictMcpConfig: true,
      // Never 'project': a PR could add .claude/settings.json hooks, i.e. code execution on this machine.
      settingSources: [], persistSession: false, verbatimPrompts: true, permissionMode: 'default',
      canUseTool: async (name, input) => {
        const reason = checkToolUse(root, name, input);
        return reason ? { behavior: 'deny', message: reason } : { behavior: 'allow', updatedInput: input };
      },
      hooks: { PreToolUse: [{ hooks: [deny] }] },
      outputFormat: { type: 'json_schema', schema: toJsonSchema(req.schema) },
      maxTurns: req.maxTurns, maxBudgetUsd: req.maxBudgetUsd, abortController, env: agentEnv(),
      stderr: data => { stderr = (stderr + data).slice(-4000); },
    } });
    for await (const message of messages) {
      if (message.type !== 'result') continue;
      costUsd = message.total_cost_usd ?? 0;
      if (message.subtype !== 'success') return fail(`${message.subtype}${message.errors.length ? `: ${message.errors.join('; ').slice(0, 300)}` : ''}`);
      if (message.is_error) return fail(`error: ${message.result.slice(0, 300)}`);
      const parsed = req.schema.safeParse(message.structured_output);
      if (!parsed.success) return fail(`invalid structured output: ${parsed.error.message.slice(0, 300)}`);
      return { output: parsed.data, costUsd };
    }
    return fail(req.signal.aborted ? 'aborted' : 'ended without a result');
  } catch (error) {
    return fail(req.signal.aborted ? 'aborted' : error instanceof Error ? error.message : String(error));
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
}
