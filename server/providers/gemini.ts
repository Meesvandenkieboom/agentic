import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createPatch } from 'diff';
import { AcpConnection, AcpRpcError, acpConnection, type AcpNotification, type AcpRequest } from '../gemini/acp';
import { noteAgentCommand } from '../review';
import type { CodexBlock, CodexEventCallback } from './codex';

// Gemini emits the same events as Codex so both share the chat persistence and UI paths.
export interface RunGeminiOptions {
  sessionId: string;
  resumeSessionId?: string | null;
  signal?: AbortSignal;
  model: string;
  effort?: string;
  mcpServers?: unknown[];
  developerInstructions?: string;
  imagePaths?: string[];
  onSessionId?: (id: string) => void;
}

type Raw = Record<string, unknown>;
type ToolBlock = Extract<CodexBlock, { type: 'tool_use' }>;
interface ActiveRun {
  acpSessionId: string | null;
  turnId: string | null;
  emit: CodexEventCallback;
  tools: Map<string, Raw>;
  textId: string | null;
  thoughtId: string | null;
  texts: Map<string, string>;
  seq: number;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const str = (value: unknown) => typeof value === 'string' ? value : '';

/** Agentic's MCP map → ACP's mcpServers list (stdio and http). */
export function toAcpMcpServers(servers: Record<string, unknown>): unknown[] {
  const pairs = (record: unknown) => Object.entries((record ?? {}) as Record<string, string>).map(([name, value]) => ({ name, value }));
  return Object.entries(servers).flatMap(([name, raw]): unknown[] => {
    const cfg = raw as Raw;
    if ((cfg?.type === 'http' || cfg?.type === 'sse') && typeof cfg.url === 'string') return [{ type: cfg.type, name, url: cfg.url, headers: pairs(cfg.headers) }];
    if (cfg?.type === 'stdio' && typeof cfg.command === 'string') return [{ name, command: cfg.command, args: (cfg.args as string[]) ?? [], env: pairs(cfg.env) }];
    return [];
  });
}

/** Merged ACP tool_call snapshot → the tool block shapes the chat UI already renders. */
export function toToolBlock(t: Raw): ToolBlock {
  const id = String(t.toolCallId), status = str(t.status);
  const input = (t.rawInput ?? t.args ?? {}) as Raw;
  const content = Array.isArray(t.content) ? t.content as Raw[] : [];
  const output = content.flatMap(c => c.type === 'content' && (c.content as Raw)?.type === 'text' ? [str((c.content as Raw).text)] : []).join('\n');
  const diffs = content.filter(c => c.type === 'diff');
  const path = str((t.locations as Raw[] | undefined)?.[0]?.path);
  if (t.kind === 'execute') return { type: 'tool_use', id, name: 'Bash', input: { command: str(input.CommandLine) || str(t.title), output, status } };
  if (diffs.length === 1) {
    const d = diffs[0];
    return d.oldText == null
      ? { type: 'tool_use', id, name: 'Write', input: { file_path: str(d.path), content: str(d.newText), status } }
      : { type: 'tool_use', id, name: 'Edit', input: { file_path: str(d.path), old_string: str(d.oldText), new_string: str(d.newText), status } };
  }
  if (diffs.length > 1) return { type: 'tool_use', id, name: 'Edit', input: { status, changes: diffs.map(d => ({
    path: str(d.path), kind: d.oldText == null ? 'add' : 'update', diff: createPatch(str(d.path), str(d.oldText), str(d.newText)),
  })) } };
  if (t.kind === 'read' && path) return { type: 'tool_use', id, name: 'Read', input: { file_path: path, status } };
  return { type: 'tool_use', id, name: str(t.name) || str(t.title) || str(t.kind) || 'tool', input: { ...input, ...(output ? { output } : {}), status } };
}

/** Owns ACP session identity per chat, turn cancellation, and update → block mapping. */
export class GeminiSessions {
  private runs = new Map<string, ActiveRun>();
  // ACP sessions already resumed in the current agy process.
  private live = new Set<string>();
  constructor(private readonly acp: AcpConnection, private readonly stopTimeoutMs = 30_000) {
    acp.onNotification(event => this.notification(event));
    acp.onRequest(request => this.serverRequest(request));
    acp.onDisconnect(() => this.live.clear());
  }

  isActive(sessionId: string) { return this.runs.has(sessionId); }
  activeTurnId(sessionId: string): string | null { return this.runs.get(sessionId)?.turnId ?? null; }

  async run(prompt: string, cwd: string, emit: CodexEventCallback, opts: RunGeminiOptions): Promise<void> {
    if (this.runs.has(opts.sessionId)) throw new Error('This chat already has an active Gemini turn.');
    const run: ActiveRun = { acpSessionId: null, turnId: null, emit, tools: new Map(), textId: null, thoughtId: null, texts: new Map(), seq: 0 };
    this.runs.set(opts.sessionId, run);
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let success: boolean | undefined;
    const cancel = () => {
      if (!run.acpSessionId || stopTimer) return;
      try { this.acp.notify('session/cancel', { sessionId: run.acpSessionId }); } catch { /* already disconnected */ }
      stopTimer = setTimeout(() => this.acp.stop(new Error('Gemini did not finish stopping. It was restarted; send a new message to resume the conversation.')), this.stopTimeoutMs);
    };
    opts.signal?.addEventListener('abort', cancel);
    try {
      if (opts.signal?.aborted) { success = false; return; }
      const mcpServers = opts.mcpServers ?? [];
      let id = opts.resumeSessionId ?? null, fresh = false;
      if (id && !this.live.has(id)) {
        try { await this.acp.request('session/resume', { sessionId: id, cwd, mcpServers }); }
        catch (error) {
          if (!(error instanceof AcpRpcError)) throw error;
          console.warn(`Gemini session ${id} could not be resumed (${error.message}); starting a new one.`);
          id = null;
        }
      }
      if (!id) {
        id = (await this.acp.request<{ sessionId: string }>('session/new', { cwd, mcpServers })).sessionId;
        fresh = true;
        opts.onSessionId?.(id);
      }
      this.live.add(id);
      run.acpSessionId = id;
      await this.acp.request('session/set_config_option', { sessionId: id, configId: 'model', value: opts.model });
      // Not every model offers every level; keep the session default then.
      if (opts.effort) await this.acp.request('session/set_config_option', { sessionId: id, configId: 'thought_level', value: opts.effort }).catch(() => {});
      if (opts.signal?.aborted) { success = false; return; }

      run.turnId = randomUUID();
      emit({ type: 'turn_started', turnId: run.turnId });
      const text = fresh && opts.developerInstructions ? `${opts.developerInstructions}\n\n${prompt}` : prompt;
      const blocks = [
        ...(text.trim() ? [{ type: 'text', text }] : []),
        ...(opts.imagePaths ?? []).map(p => ({ type: 'image', mimeType: MIME[extname(p).toLowerCase()] ?? 'image/png', data: readFileSync(p).toString('base64') })),
      ];
      const result = await this.acp.request<{ stopReason: string; usage?: { outputTokens?: number } }>('session/prompt', { sessionId: id, prompt: blocks }, null);
      if (typeof result.usage?.outputTokens === 'number') emit({ type: 'token_update', outputTokens: result.usage.outputTokens });
      if (result.stopReason !== 'end_turn' && result.stopReason !== 'cancelled') {
        this.block(run, { type: 'text', id: `${run.turnId}-stop`, text: `Gemini stopped: ${result.stopReason.replace(/_/g, ' ')}.` });
      }
      success = result.stopReason === 'end_turn';
    } catch (error) {
      if (error instanceof AcpRpcError && /auth/i.test(error.message)) {
        throw new Error('Gemini is not logged in. Run `agy acp --login` in a terminal once, then send your message again.');
      }
      throw error;
    } finally {
      clearTimeout(stopTimer);
      opts.signal?.removeEventListener('abort', cancel);
      this.runs.delete(opts.sessionId);
      if (success !== undefined) emit({ type: 'result', success });
    }
  }

  /** Runs unattended like Codex: tool permission requests are approved. */
  private serverRequest(request: AcpRequest): void {
    if (request.method !== 'session/request_permission') { this.acp.respondError(request.id, 'Not supported by Agentic.'); return; }
    const options = (request.params.options ?? []) as { optionId: string; kind?: string }[];
    const allow = options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind?.startsWith('allow'));
    this.acp.respond(request.id, allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  private notification({ method, params }: AcpNotification): void {
    if (method !== 'session/update') return;
    const run = [...this.runs.values()].find(r => r.acpSessionId === params.sessionId);
    const u = params.update as Raw | undefined;
    if (!run?.turnId || !u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': case 'agent_thought_chunk': {
        const content = u.content as Raw | undefined;
        if (content?.type !== 'text') return;
        const thought = u.sessionUpdate === 'agent_thought_chunk';
        if (thought) { run.textId = null; run.thoughtId ??= `${run.turnId}-${run.seq++}`; }
        else { run.thoughtId = null; run.textId ??= `${run.turnId}-${run.seq++}`; }
        const id = (thought ? run.thoughtId : run.textId)!;
        const next = (run.texts.get(id) ?? '') + str(content.text);
        run.texts.set(id, next);
        this.block(run, thought ? { type: 'thinking', id, thinking: next } : { type: 'text', id, text: next });
        return;
      }
      case 'tool_call': case 'tool_call_update': {
        run.textId = run.thoughtId = null;
        const id = String(u.toolCallId);
        const merged = { ...run.tools.get(id), ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined && v !== null)) };
        run.tools.set(id, merged);
        const block = toToolBlock(merged);
        if (u.sessionUpdate === 'tool_call' && block.name === 'Bash') noteAgentCommand(block.input.command);
        this.block(run, block);
        return;
      }
      case 'plan': {
        const entries = (u.entries ?? []) as { content: string; status: string }[];
        this.block(run, { type: 'tool_use', id: `plan-${run.turnId}`, name: 'TodoWrite', input: { todos: entries.map(e => ({ content: e.content, activeForm: e.content, status: e.status })) } });
      }
    }
  }

  private block(run: ActiveRun, block: CodexBlock): void { run.emit({ type: 'block', block }); }
}

export const geminiSessions = new GeminiSessions(acpConnection);
