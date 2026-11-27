import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { getAgyCommand } from '../gemini/acp';
import { checkToolUse, GIT_TOOL_DESCRIPTION, gitTool, runGit, type AgentRequest, type AgentResult } from './agent';
import { toJsonSchema } from './prompts';

const MAX_RESULT = 64 * 1024;
const MAX_READ_LINES = 2000;
const ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'USERPROFILE'] as const;
const AUTH_ERROR = 'Gemini is not logged in. Run `agentic --login` (or `agy acp --login`) to sign in with your Google subscription.';
const SANDBOX_TOOL_NOTE = 'IMPORTANT: Built-in file, shell, and web tools are disabled in this review sandbox. Use ONLY the `repo` MCP server tools (`Read`, `Grep`, `Glob`, `git`) to inspect the repository worktree. Do not call built-in file, search, browser, or terminal tools.';

const str = (description: string) => ({ type: 'string', description });

export interface RepoToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const REPO_TOOLS: RepoToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a file in the repository worktree; output lines are prefixed with their 1-based line number.',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: str('Path inside the repository, relative to its root or absolute.'),
        offset: { type: 'integer', description: 'First line to read (1-based).' },
        limit: { type: 'integer', description: `Lines to read, at most ${MAX_READ_LINES}.` },
      },
    },
  },
  {
    name: 'Grep',
    description: 'Search tracked files with a POSIX extended regex (git grep -E). Returns path:line:text.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: str('Extended regular expression.'),
        path: str('File or directory to search, default the repository root.'),
        glob: str('Only files whose repo-relative path matches this glob, e.g. "src/**/*.rs".'),
        case_insensitive: { type: 'boolean' },
      },
    },
  },
  {
    name: 'Glob',
    description: 'List tracked files matching a glob, e.g. "**/*.ts".',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: str('Glob relative to path.'),
        path: str('Directory to list, default the repository root.'),
      },
    },
  },
  {
    name: 'git',
    description: GIT_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: { args: { type: 'array', items: { type: 'string' } } },
    },
  },
];

const cap = (text: string, note: string) => text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… truncated; ${note}` : text;
const relPath = (root: string, path: unknown) => typeof path === 'string' && path ? relative(root, resolve(root, path)) || '.' : '.';

async function read(root: string, input: Record<string, unknown>): Promise<string> {
  if (typeof input.file_path !== 'string') throw new Error('file_path is required.');
  const abs = resolve(root, input.file_path);
  if (statSync(abs).isDirectory()) throw new Error('Path is a directory; use Glob to list it.');
  const lines = (await Bun.file(abs).text()).split('\n');
  const start = Math.max(1, Number(input.offset) || 1), count = Math.min(MAX_READ_LINES, Math.max(1, Number(input.limit) || MAX_READ_LINES));
  const body = lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}\t${line.slice(0, 2000)}`).join('\n');
  const more = start - 1 + count < lines.length ? `\n… ${lines.length} lines total; continue with offset ${start + count}.` : '';
  return cap(body || '(no lines in range)', 'use offset/limit.') + more;
}

async function grep(root: string, input: Record<string, unknown>): Promise<string> {
  const args = ['grep', '-n', '-I', '-E', ...(input.case_insensitive ? ['-i'] : []), '-e', String(input.pattern), '--', relPath(root, input.path)];
  const r = await runGit(root, args, 256 * 1024);
  if (r.code === 1) return '(no matches)';
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git grep exited ${r.code}`);
  const glob = typeof input.glob === 'string' && input.glob ? new Bun.Glob(input.glob) : null;
  const hits = r.stdout.split('\n').filter(l => l && (!glob || glob.match(l.slice(0, l.indexOf(':'))))).map(l => l.slice(0, 300));
  return hits.length ? cap(hits.slice(0, 300).join('\n'), 'narrow the pattern, path or glob.') + (hits.length > 300 || r.truncated ? '\n… more matches omitted.' : '') : '(no matches)';
}

async function glob(root: string, input: Record<string, unknown>): Promise<string> {
  const dir = relPath(root, input.path);
  const r = await runGit(root, ['ls-files', '-z', '--', dir], 4 * 1024 * 1024);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ls-files exited ${r.code}`);
  const matcher = new Bun.Glob(String(input.pattern));
  const files = r.stdout.split('\0').filter(f => f && matcher.match(dir === '.' ? f : relative(dir, f)));
  return files.length ? files.slice(0, 500).join('\n') + (files.length > 500 ? `\n… ${files.length - 500} more; narrow the pattern.` : '') : '(no files)';
}

/** Shared sandboxed tool executor used by the repo MCP server and tests. */
export async function runRepoTool(root: string, rawName: string, rawInput: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const name = rawName === 'git' ? 'mcp__repo__git' : rawName;
  const input = name === 'Read' && rawInput.file_path === undefined && typeof rawInput.path === 'string'
    ? { ...rawInput, file_path: rawInput.path }
    : rawInput;
  try {
    const denied = checkToolUse(root, name, input);
    if (denied) return { text: denied, isError: true };
    if (name === 'mcp__repo__git') return await gitTool(root, input.args as string[]);
    return { text: await (name === 'Read' ? read : name === 'Grep' ? grep : glob)(root, input), isError: false };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

export async function execute(root: string, call: { id?: string; name?: string; args?: Record<string, unknown> }): Promise<{
  functionResponse: { id?: string; name: string; response: { output?: string; error?: string } };
}> {
  const name = call.name ?? '';
  const r = await runRepoTool(root, name, call.args ?? {});
  return { functionResponse: { id: call.id, name, response: r.isError ? { error: r.text } : { output: r.text } } };
}

/** Minimal env so `agy` uses the Google subscription OAuth token and never sees API keys, RPC keys or GitHub tokens. */
function agyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export function assertAgyAvailable(model: string, agyCommand = getAgyCommand()): void {
  if (!existsSync(agyCommand)) {
    throw new Error(`Antigravity CLI (agy) is not installed. Install it and run \`agentic --login\` to review with ${model}.`);
  }
}

interface AgyStreamResult {
  status?: string;
  response?: string;
  error?: string;
  structured_output?: unknown;
  denied_actions?: { action?: string; display_name?: string }[];
}

export interface GeminiAgentOptions {
  agyCommand?: string[];
  mcpServerPath?: string;
}

async function readStreamResult(stream: ReadableStream<Uint8Array>): Promise<AgyStreamResult | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AgyStreamResult | null = null;
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as { event?: string; result?: AgyStreamResult };
      if (parsed.event === 'result' && parsed.result) result = parsed.result;
    } catch { /* ignore non-JSON diagnostic lines */ }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      consume(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer);
  return result;
}

async function readTail(stream: ReadableStream<Uint8Array>, maxChars = 4000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text = (text + decoder.decode(value, { stream: true })).slice(-maxChars);
  }
  return (text + decoder.decode()).slice(-maxChars);
}

/**
 * Same contract and read-only sandbox as runAgent, running on the user's Antigravity CLI (`agy`)
 * subscription. `agy` runs in an empty temp cwd with every built-in file/shell/web tool denied;
 * the only permitted tools are our sandboxed `repo` MCP server (`Read`, `Grep`, `Glob`, `git`).
 */
export async function runGeminiAgent<T>(req: AgentRequest<T>, options: GeminiAgentOptions = {}): Promise<AgentResult<T>> {
  if (req.signal.aborted) return { output: null, costUsd: 0, error: 'aborted' };
  let stderr = '';
  const fail = (error: string): AgentResult<T> => {
    req.log(`${req.label}: ${error}${stderr.trim() ? ` (stderr: ${stderr.trim().slice(-500)})` : ''}`);
    return { output: null, costUsd: 0, error };
  };

  let sandboxDir: string | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const root = realpathSync(req.worktree);
    sandboxDir = mkdtempSync(join(tmpdir(), 'agentic-review-agy-'));
    // Empty .git stops agy from walking up to parent directories for hooks, rules, or MCP configs.
    mkdirSync(join(sandboxDir, '.git'));
    mkdirSync(join(sandboxDir, '.agents'));

    const mcpServerPath = options.mcpServerPath ?? join(import.meta.dir, 'repoMcp.ts');
    writeFileSync(join(sandboxDir, '.agents', 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        repo: {
          command: process.execPath,
          args: [mcpServerPath, root],
        },
      },
    }));

    const schemaPath = join(sandboxDir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(toJsonSchema(req.schema)));

    const settingsPath = join(sandboxDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      agentMode: '',
      toolPermission: 'request-review',
      modelProvider: '',
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: true,
      disableSlashCommands: true,
      permissions: {
        allow: ['mcp(repo/*)'],
        deny: ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'read_file(*)'],
      },
    }));

    const timeoutSeconds = req.maxTurns <= 25 ? 300 : 600;
    const cmd = [
      ...(options.agyCommand ?? [getAgyCommand()]),
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', req.model,
      '--effort', req.effort,
      '--disable-slash-commands',
      '--json-schema', schemaPath,
      '--settings', settingsPath,
      '--print-timeout', `${timeoutSeconds}s`,
    ];

    const proc = Bun.spawn(cmd, {
      cwd: sandboxDir,
      env: agyEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    onAbort = () => {
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already exited */ } }, 2000);
      killTimer.unref();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });

    const system = req.system.filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n');
    const content = `${system}\n\n${SANDBOX_TOOL_NOTE}\n\n---\n\n${req.prompt}`;
    proc.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
    void proc.stdin.end();

    const [result, errText, exitCode] = await Promise.all([
      readStreamResult(proc.stdout),
      readTail(proc.stderr),
      proc.exited,
    ]);
    stderr = errText;

    if (req.signal.aborted) return fail('aborted');
    if (!result) {
      if (/auth|login|credential/i.test(stderr)) return fail(AUTH_ERROR);
      return fail(exitCode !== 0 ? `agy exited with code ${exitCode}` : 'ended without a result');
    }
    if (result.status !== 'SUCCESS') {
      const detail = result.error || result.status || 'unknown error';
      if (/auth|login|credential/i.test(detail) || /auth|login|credential/i.test(stderr)) return fail(AUTH_ERROR);
      return fail(detail.slice(0, 300));
    }

    let rawOutput: unknown = result.structured_output;
    if (rawOutput === undefined && typeof result.response === 'string' && result.response.trim()) {
      try { rawOutput = JSON.parse(result.response); } catch { /* handled by schema parse */ }
    }
    if (rawOutput === undefined && result.denied_actions?.length) {
      const actions = result.denied_actions.map(a => a.display_name || a.action || 'tool').join(', ');
      return fail(`no structured output (denied tool actions: ${actions})`);
    }

    const parsed = req.schema.safeParse(rawOutput);
    if (!parsed.success) return fail(`invalid structured output: ${parsed.error.message.slice(0, 300)}`);
    return { output: parsed.data, costUsd: 0 };
  } catch (error) {
    return fail(req.signal.aborted ? 'aborted' : error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(killTimer);
    if (onAbort) req.signal.removeEventListener('abort', onAbort);
    if (sandboxDir) rmSync(sandboxDir, { recursive: true, force: true });
  }
}
