import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel, type Content, type FunctionCall, type FunctionDeclaration, type Part } from '@google/genai';
import { realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { checkToolUse, GIT_TOOL_DESCRIPTION, gitTool, runGit, type AgentRequest, type AgentResult } from './agent';
import { toJsonSchema } from './prompts';

export const GEMINI_REVIEW_MODEL = 'gemini-4-neon';
// USD per 1M tokens, only used to enforce the per-agent and per-job budgets.
const PRICE = { input: 3, cached: 0.3, output: 15 };
const MAX_RESULT = 64 * 1024;
const MAX_READ_LINES = 2000;

const str = (description: string) => ({ type: 'string', description });
const DECLARATIONS: FunctionDeclaration[] = [
  { name: 'Read', description: 'Read a file in the repository worktree; output lines are prefixed with their 1-based line number.',
    parametersJsonSchema: { type: 'object', required: ['file_path'], properties: {
      file_path: str('Path inside the repository, relative to its root or absolute.'),
      offset: { type: 'integer', description: 'First line to read (1-based).' }, limit: { type: 'integer', description: `Lines to read, at most ${MAX_READ_LINES}.` } } } },
  { name: 'Grep', description: 'Search tracked files with a POSIX extended regex (git grep -E). Returns path:line:text.',
    parametersJsonSchema: { type: 'object', required: ['pattern'], properties: {
      pattern: str('Extended regular expression.'), path: str('File or directory to search, default the repository root.'),
      glob: str('Only files whose repo-relative path matches this glob, e.g. "src/**/*.rs".'), case_insensitive: { type: 'boolean' } } } },
  { name: 'Glob', description: 'List tracked files matching a glob, e.g. "**/*.ts".',
    parametersJsonSchema: { type: 'object', required: ['pattern'], properties: {
      pattern: str('Glob relative to path.'), path: str('Directory to list, default the repository root.') } } },
  { name: 'mcp__repo__git', description: GIT_TOOL_DESCRIPTION,
    parametersJsonSchema: { type: 'object', required: ['args'], properties: { args: { type: 'array', items: { type: 'string' } } } } },
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

export async function execute(root: string, call: FunctionCall): Promise<Part> {
  const name = call.name ?? '', input = call.args ?? {};
  let response: Record<string, unknown>;
  try {
    const denied = checkToolUse(root, name, input);
    if (denied) throw new Error(denied);
    if (name === 'mcp__repo__git') {
      const r = await gitTool(root, input.args as string[]);
      response = r.isError ? { error: r.text } : { output: r.text };
    } else {
      response = { output: await (name === 'Read' ? read : name === 'Grep' ? grep : glob)(root, input) };
    }
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  return { functionResponse: { id: call.id, name, response } };
}

/** Same contract and sandbox as runAgent, on the Gemini API: Read/Grep/Glob/git are re-implemented over the same checks. */
export async function runGeminiAgent<T>(req: AgentRequest<T>, apiKey: string): Promise<AgentResult<T>> {
  let costUsd = 0;
  const fail = (error: string): AgentResult<T> => { req.log(`${req.label}: ${error}`); return { output: null, costUsd, error }; };
  try {
    const root = realpathSync(req.worktree);
    const ai = new GoogleGenAI({ apiKey });
    const submit: FunctionDeclaration = { name: 'StructuredOutput', description: 'Submit the final result. Call exactly once, when done.', parametersJsonSchema: toJsonSchema(req.schema) };
    const contents: Content[] = [{ role: 'user', parts: [{ text: req.prompt }] }];
    const systemInstruction = req.system.filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n');
    for (let turn = 0; turn < req.maxTurns; turn++) {
      if (req.signal.aborted) return fail('aborted');
      // Out of turns or near budget: force the answer instead of losing the whole pass.
      const final = turn === req.maxTurns - 1 || costUsd >= req.maxBudgetUsd * 0.8;
      const res = await ai.models.generateContent({ model: req.model, contents, config: {
        systemInstruction, abortSignal: req.signal,
        tools: [{ functionDeclarations: final ? [submit] : [...DECLARATIONS, submit] }],
        toolConfig: { functionCallingConfig: final ? { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['StructuredOutput'] } : { mode: FunctionCallingConfigMode.AUTO } },
        thinkingConfig: { thinkingLevel: req.effort === 'high' ? ThinkingLevel.HIGH : ThinkingLevel.MEDIUM },
      } });
      const u = res.usageMetadata, cached = u?.cachedContentTokenCount ?? 0;
      costUsd += (((u?.promptTokenCount ?? 0) - cached) * PRICE.input + cached * PRICE.cached
        + ((u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)) * PRICE.output) / 1e6;
      const content = res.candidates?.[0]?.content;
      if (!content?.parts?.length) return fail(`no content (${res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? 'unknown'})`);
      // Pushed whole so thought signatures go back with the function calls.
      contents.push(content);
      const calls = res.functionCalls ?? [];
      const answer = calls.find(c => c.name === 'StructuredOutput');
      if (answer) {
        const parsed = req.schema.safeParse(answer.args);
        if (parsed.success) return { output: parsed.data, costUsd };
        if (final) return fail(`invalid structured output: ${parsed.error.message.slice(0, 300)}`);
        contents.push({ role: 'user', parts: [{ functionResponse: { id: answer.id, name: answer.name, response: { error: `Invalid: ${parsed.error.message.slice(0, 2000)}` } } }] });
        continue;
      }
      if (!calls.length) { contents.push({ role: 'user', parts: [{ text: 'Call StructuredOutput with your result.' }] }); continue; }
      contents.push({ role: 'user', parts: await Promise.all(calls.map(call => execute(root, call))) });
    }
    return fail('ended without a result');
  } catch (error) {
    return fail(req.signal.aborted ? 'aborted' : error instanceof Error ? error.message : String(error));
  }
}
