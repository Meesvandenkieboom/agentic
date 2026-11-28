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

export interface SteerGeminiOptions {
  turnId?: string;
  clientMessageId?: string;
  onDelivered: () => void;
  onDropped?: () => void;
}

type Raw = Record<string, unknown>;
type ToolBlock = Extract<CodexBlock, { type: 'tool_use' }>;
type PromptResult = { stopReason: string; usage?: { outputTokens?: number } };
interface PendingSteer {
  clientMessageId?: string;
  onDelivered: () => void;
  onDropped?: () => void;
}
interface ActiveRun {
  acpSessionId: string | null;
  turnId: string | null;
  cancelling: boolean;
  settled: boolean;
  emit: CodexEventCallback;
  tools: Map<string, Raw>;
  textId: string | null;
  thoughtId: string | null;
  texts: Map<string, string>;
  seq: number;
  promptGen: number;
  activePrompt: Promise<PromptResult> | null;
  pendingSteers: PendingSteer[];
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const str = (value: unknown) => typeof value === 'string' ? value : '';
const buildPromptBlocks = (text: string, imagePaths?: string[]) => [
  ...(text.trim() ? [{ type: 'text', text }] : []),
  ...(imagePaths ?? []).map(p => ({ type: 'image', mimeType: MIME[extname(p).toLowerCase()] ?? 'image/png', data: readFileSync(p).toString('base64') })),
];

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
    const run: ActiveRun = {
      acpSessionId: null, turnId: null, cancelling: false, settled: false, emit,
      tools: new Map(), textId: null, thoughtId: null, texts: new Map(), seq: 0,
      promptGen: 0, activePrompt: null, pendingSteers: [],
    };
    this.runs.set(opts.sessionId, run);
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let success: boolean | undefined;
    const cancel = () => {
      run.cancelling = true;
      if (!run.acpSessionId || stopTimer) return;
      try { this.acp.notify('session/cancel', { sessionId: run.acpSessionId }); } catch { /* already disconnected */ }
      stopTimer = setTimeout(() => this.acp.stop(new Error('Gemini did not finish stopping. It was restarted; send a new message to resume the conversation.')), this.stopTimeoutMs);
    };
    opts.signal?.addEventListener('abort', cancel);
    try {
      if (opts.signal?.aborted) { run.settled = true; success = false; return; }
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
      if (opts.signal?.aborted) { run.settled = true; success = false; return; }

      run.turnId = randomUUID();
      emit({ type: 'turn_started', turnId: run.turnId });
      const text = fresh && opts.developerInstructions ? `${opts.developerInstructions}\n\n${prompt}` : prompt;
      const blocks = buildPromptBlocks(text, opts.imagePaths);
      let currentGen = ++run.promptGen;
      let currentPromise = this.acp.request<PromptResult>('session/prompt', { sessionId: id, prompt: blocks }, null);
      run.activePrompt = currentPromise;

      let result!: PromptResult;
      for (;;) {
        try {
          result = await currentPromise;
        } catch (error) {
          if (run.promptGen !== currentGen && run.activePrompt) {
            currentGen = run.promptGen;
            currentPromise = run.activePrompt;
            continue;
          }
          throw error;
        }
        // A mid-turn follow-up causes `agy acp` to resolve the older `session/prompt`
        // immediately while continuing the active stream under the newer request.
        if (run.promptGen !== currentGen && run.activePrompt) {
          currentGen = run.promptGen;
          currentPromise = run.activePrompt;
          continue;
        }
        break;
      }
      run.settled = true;
      if (result.stopReason === 'end_turn') this.flushPendingSteers(run);
      if (typeof result.usage?.outputTokens === 'number') emit({ type: 'token_update', outputTokens: result.usage.outputTokens });
      if (result.stopReason !== 'end_turn' && result.stopReason !== 'cancelled') {
        this.block(run, { type: 'text', id: `${run.turnId}-stop`, text: `Gemini stopped: ${result.stopReason.replace(/_/g, ' ')}.` });
      }
      success = result.stopReason === 'end_turn';
    } catch (error) {
      run.settled = true;
      if (error instanceof AcpRpcError && /auth/i.test(error.message)) {
        throw new Error('Gemini is not logged in. Run `agy acp --login` in a terminal once, then send your message again.');
      }
      throw error;
    } finally {
      run.settled = true;
      clearTimeout(stopTimer);
      opts.signal?.removeEventListener('abort', cancel);
      if (run.pendingSteers.length) {
        for (const item of run.pendingSteers.splice(0)) item.onDropped?.();
      }
      this.runs.delete(opts.sessionId);
      if (success !== undefined) emit({ type: 'result', success });
    }
  }

  /**
   * Queue a mid-turn follow-up into the active `agy acp` session without cancelling
   * in-flight tools or subagents. `agy acp` resolves the previous `session/prompt`
   * and continues streaming under this new request.
   */
  steer(sessionId: string, text: string, imagePaths: string[], opts: SteerGeminiOptions): void {
    const run = this.runs.get(sessionId);
    if (!run || !run.acpSessionId || !run.turnId || run.cancelling || run.settled) {
      throw new Error('This turn is no longer accepting input. Your draft has been kept.');
    }
    if (opts.turnId !== undefined && opts.turnId !== run.turnId) {
      throw new Error('The active turn changed. Your draft has been kept.');
    }
    if (!this.acp.connected) {
      throw new Error('Gemini (agy) is disconnected. Your draft has been kept.');
    }
    const blocks = buildPromptBlocks(text, imagePaths);
    if (!blocks.length) throw new Error('Message is empty.');

    run.pendingSteers.push({ clientMessageId: opts.clientMessageId, onDelivered: opts.onDelivered, onDropped: opts.onDropped });
    run.promptGen += 1;
    const nextPrompt = this.acp.request<PromptResult>('session/prompt', { sessionId: run.acpSessionId, prompt: blocks }, null);
    // The active `run()` loop adopts and awaits `run.activePrompt`; prevent unhandled rejections before handoff.
    nextPrompt.catch(() => {});
    run.activePrompt = nextPrompt;
  }

  private flushPendingSteers(run: ActiveRun): void {
    if (!run.pendingSteers.length) return;
    const queued = run.pendingSteers.splice(0);
    run.textId = null;
    run.thoughtId = null;
    run.emit({ type: 'input_boundary' });
    for (const item of queued) item.onDelivered();
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
      case 'usage_update': {
        // Marks the end of a model response step so a queued follow-up lands cleanly before the next step.
        run.textId = null;
        run.thoughtId = null;
        return;
      }
      case 'agent_message_chunk': case 'agent_thought_chunk': {
        const content = u.content as Raw | undefined;
        if (content?.type !== 'text') return;
        const thought = u.sessionUpdate === 'agent_thought_chunk';
        const startingNewBlock = thought ? run.thoughtId === null : run.textId === null;
        if (startingNewBlock && run.pendingSteers.length) this.flushPendingSteers(run);
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
        // Existing tools keep updating their pre-follow-up cards; a brand-new tool starts after the follow-up.
        if (u.sessionUpdate === 'tool_call' && !run.tools.has(id) && run.pendingSteers.length) {
          this.flushPendingSteers(run);
        }
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
