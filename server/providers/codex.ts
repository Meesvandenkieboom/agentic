import { randomUUID } from 'node:crypto';
import { CodexAppServer, codexAppServer, type RpcId, type RpcNotification, type RpcRequest } from '../codex/appServer';
import type { CodexSkillConfigEntry } from '../skills';

export type CodexBlock =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export interface CodexQuestion {
  toolId: string;
  isBlocking: boolean;
  questions: { id: string; header: string; question: string; options: { label: string; description?: string }[]; isSecret?: boolean }[];
}
export type CodexEvent =
  | { type: 'block'; block: CodexBlock }
  | { type: 'input_boundary' }
  | { type: 'turn_started'; turnId: string }
  | { type: 'result'; success: boolean }
  | { type: 'token_update'; outputTokens: number }
  | { type: 'retry_attempt'; attempt: number; maxAttempts: number; message: string }
  | { type: 'ask_user_question'; question: CodexQuestion }
  | { type: 'question_resolved'; toolId: string };
export type CodexEventCallback = (event: CodexEvent) => void;
export interface RunCodexOptions {
  sessionId: string;
  resumeThreadId?: string | null;
  signal?: AbortSignal;
  effort?: string;
  model?: string;
  mcpServers?: Record<string, unknown>;
  developerInstructions?: string;
  imagePaths?: string[];
  skillsConfig?: CodexSkillConfigEntry[];
  onThreadId?: (id: string) => void;
}
export function buildCodexConfig(options: Pick<RunCodexOptions, 'mcpServers' | 'developerInstructions' | 'skillsConfig'>): Record<string, unknown> {
  return {
    ...(options.mcpServers && Object.keys(options.mcpServers).length ? { mcp_servers: options.mcpServers } : {}),
    ...(options.developerInstructions ? { developer_instructions: options.developerInstructions } : {}),
    ...(options.skillsConfig !== undefined ? { skills: { config: options.skillsConfig } } : {}),
  };
}
export function buildCodexInput(prompt: string, imagePaths: string[] = []) {
  return [
    ...(prompt.trim() ? [{ type: 'text', text: prompt, text_elements: [] }] : []),
    ...imagePaths.map(path => ({ type: 'localImage', path })),
  ];
}
export function parseCodexRetryNotice(message: string | undefined): Extract<CodexEvent, { type: 'retry_attempt' }> | null {
  const match = message?.match(/^Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)\s*(?:\(([\s\S]*)\))?$/);
  return match ? { type: 'retry_attempt', attempt: Number(match[1]), maxAttempts: Number(match[2]), message: match[3] || 'Connection interrupted' } : null;
}

type Item = { id: string; type: string; [key: string]: unknown };
interface PendingQuestion { question: CodexQuestion; requestId?: RpcId }
interface ActiveRun {
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  emit: CodexEventCallback;
  blocks: Map<string, CodexBlock>;
  questions: Map<string, PendingQuestion>;
  inputs: Map<string, () => void>;
  resolvedQuestions: Set<string>;
  settle: (error?: Error) => void;
  interrupting: boolean;
  settled: boolean;
  result?: boolean;
}
const messageOf = (value: unknown, fallback: string) => value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : fallback;

/** Owns native turn identities, question requests, cancellation, and error completion. */
export class CodexSessions {
  private runs = new Map<string, ActiveRun>();
  constructor(private readonly app: CodexAppServer, private readonly stopTimeoutMs = 30_000) {
    app.onNotification(event => this.notification(event));
    app.onRequest(request => this.serverRequest(request));
    app.onDisconnect(error => { for (const run of this.runs.values()) run.settle(error); });
  }

  activeTurnId(sessionId: string): string | null { return this.runs.get(sessionId)?.turnId || null; }
  isActive(sessionId: string) { return this.runs.has(sessionId); }
  pendingQuestion(sessionId: string): CodexQuestion | null { return this.runs.get(sessionId)?.questions.values().next().value?.question || null; }

  async run(prompt: string, cwd: string, emit: CodexEventCallback, opts: RunCodexOptions): Promise<void> {
    if (this.runs.has(opts.sessionId)) throw new Error('This chat already has an active Codex turn. Send a follow-up instead.');
    let finished = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // A disconnect can arrive while initialization is still being awaited.
    void done.catch(() => {});
    const run: ActiveRun = {
      sessionId: opts.sessionId, threadId: null, turnId: null, emit,
      blocks: new Map(), questions: new Map(), inputs: new Map(), resolvedQuestions: new Set(), interrupting: false, settled: false,
      settle: error => { if (finished) return; finished = true; run.settled = true; if (error) rejectDone(error); else resolveDone(); },
    };
    this.runs.set(opts.sessionId, run);
    const interrupt = () => {
      if (!run.turnId || !run.threadId || run.interrupting || finished) return;
      run.interrupting = true;
      stopTimer = setTimeout(() => {
        // Unsubscribing only detaches events; it cannot stop an unresponsive turn.
        // Reset the managed runtime so every affected chat gets an explicit failure.
        this.app.stop(new Error('Codex did not finish stopping. Its runtime was reset; send a new message to resume the saved conversation.'));
      }, this.stopTimeoutMs);
      void this.app.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(error => run.settle(error));
    };
    opts.signal?.addEventListener('abort', interrupt);
    try {
      if (opts.signal?.aborted) { run.result = false; return; }
      const params = {
        cwd, model: opts.model, sandbox: 'danger-full-access', approvalPolicy: 'never',
        developerInstructions: opts.developerInstructions,
        config: { ...buildCodexConfig(opts), web_search: 'live', ...(opts.effort ? { model_reasoning_effort: opts.effort } : {}) },
      };
      const response = await this.app.request<{ thread: { id: string } }>(
        opts.resumeThreadId ? 'thread/resume' : 'thread/start',
        opts.resumeThreadId ? { ...params, threadId: opts.resumeThreadId, excludeTurns: true } : params,
      );
      if (finished) return await done;
      run.threadId = response.thread.id;
      opts.onThreadId?.(run.threadId);
      if (opts.signal?.aborted) { run.result = false; return; }
      const started = await this.app.request<{ turn: { id: string } }>('turn/start', {
        threadId: run.threadId, input: buildCodexInput(prompt, opts.imagePaths), model: opts.model, effort: opts.effort,
      });
      if (run.turnId !== started.turn.id && !finished) emit({ type: 'turn_started', turnId: started.turn.id });
      run.turnId = started.turn.id;
      if (opts.signal?.aborted) interrupt();
      await done;
    } finally {
      clearTimeout(stopTimer);
      opts.signal?.removeEventListener('abort', interrupt);
      for (const { question } of run.questions.values()) emit({ type: 'question_resolved', toolId: question.toolId });
      // Release our subscription before a subsequent turn resumes this thread.
      try {
        if (run.threadId && this.app.connected) await this.app.request('thread/unsubscribe', { threadId: run.threadId });
      } catch { /* A failed connection already rejected the active turn. */ }
      finally { this.runs.delete(opts.sessionId); }
      if (run.result !== undefined) emit({ type: 'result', success: run.result });

    }
  }

  async steer(sessionId: string, text: string, images: string[], onAccepted: () => void, clientId = randomUUID()): Promise<void> {
    const run = this.runs.get(sessionId);
    if (!run?.threadId || !run.turnId || run.interrupting || run.settled) throw new Error('This turn is no longer accepting input. Your draft has been kept.');
    if (run.inputs.has(clientId)) throw new Error('This input is already being submitted.');
    let accepted = false;
    let acceptanceError: unknown;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      try {
        run.emit({ type: 'input_boundary' });
        onAccepted();
      } catch (error) { acceptanceError = error; run.settle(error instanceof Error ? error : new Error('Could not save the follow-up.')); }
    };
    run.inputs.set(clientId, accept);
    try {
      await this.app.request('turn/steer', { threadId: run.threadId, expectedTurnId: run.turnId, clientUserMessageId: clientId, input: buildCodexInput(text, images) });
      accept();
    } catch (error) {
      if (!accepted) throw error;
    } finally { run.inputs.delete(clientId); }
    if (acceptanceError) throw acceptanceError;
  }

  async answer(sessionId: string, toolId: string, answers: Record<string, string>, onAccepted: () => void = () => {}): Promise<void> {
    const run = this.runs.get(sessionId);
    const pending = run?.questions.get(toolId);
    if (!run || run.settled || !pending) throw new Error('This question is no longer active.');
    if (pending.requestId !== undefined) {
      this.app.respond(pending.requestId, { answers: Object.fromEntries(pending.question.questions.map(q => [q.id, { answers: [answers[q.id] || answers[q.header] || 'Skipped'] }])) });
      run.emit({ type: 'input_boundary' });
      onAccepted();
    } else {
      const text = pending.question.questions.map(q => `${q.question}\n${answers[q.id] || answers[q.header] || 'Skipped'}`).join('\n\n');
      await this.steer(sessionId, text, [], onAccepted);
    }
    this.resolveQuestion(run, toolId);
  }

  private addQuestion(run: ActiveRun, pending: PendingQuestion): void {
    if (run.questions.has(pending.question.toolId) || run.resolvedQuestions.has(pending.question.toolId)) return;
    run.questions.set(pending.question.toolId, pending);
    if (run.questions.size === 1) run.emit({ type: 'ask_user_question', question: pending.question });
  }
  private resolveQuestion(run: ActiveRun, toolId: string): void {
    if (!run.questions.delete(toolId)) return;
    run.resolvedQuestions.add(toolId);
    run.emit({ type: 'question_resolved', toolId });
    const next = run.questions.values().next().value;
    if (next) run.emit({ type: 'ask_user_question', question: next.question });
  }
  private serverRequest(request: RpcRequest): void {
    const run = [...this.runs.values()].find(run => run.threadId === request.params.threadId);
    if (!run || run.settled || request.params.turnId !== run.turnId || request.method !== 'item/tool/requestUserInput') {
      this.app.respondError(request.id, 'This request is not supported by the active Agentic session.'); return;
    }
    const questions = request.params.questions as CodexQuestion['questions'];
    if (!Array.isArray(questions) || !questions.length || questions.some(q => !q || typeof q.id !== 'string' || typeof q.question !== 'string')) { this.app.respondError(request.id, 'Invalid question request.'); return; }
    this.addQuestion(run, { requestId: request.id, question: {
      toolId: String(request.id), isBlocking: request.params.isBlocking !== false,
      questions: questions.map(q => ({ ...q, options: q.options || [] })),
    } });
  }

  private notification({ method, params: p }: RpcNotification): void {
    const run = [...this.runs.values()].find(run => run.threadId === p.threadId);
    if (!run || run.settled) return;
    try {
      if (method === 'turn/started') { run.turnId = (p.turn as { id: string }).id; run.emit({ type: 'turn_started', turnId: run.turnId }); return; }
      if (typeof p.turnId === 'string' && run.turnId && p.turnId !== run.turnId) return;
      if (method === 'serverRequest/resolved') {
        for (const [id, q] of run.questions) if (q.requestId === p.requestId) this.resolveQuestion(run, id);
      } else if (method === 'error') {
        const message = messageOf(p.error, 'Codex reported an error.');
        if (p.willRetry) run.emit(parseCodexRetryNotice(message) || { type: 'retry_attempt', attempt: 1, maxAttempts: 1, message });
        else run.settle(new Error(message));
      } else if (method === 'turn/completed') {
        const turn = p.turn as { id: string; status: string; error?: unknown; items?: Item[] };
        if (run.turnId && turn.id !== run.turnId) return;
        for (const item of turn.items || []) this.item(run, item);
        if (turn.status === 'failed') run.settle(new Error(messageOf(turn.error, 'Codex turn failed.')));
        else if (turn.status === 'completed' || turn.status === 'interrupted') { run.result = turn.status === 'completed'; run.settle(); }
      } else if (method === 'item/started' || method === 'item/completed') {
        this.item(run, p.item as Item);
      } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
        const id = String(p.itemId);
        const block = run.blocks.get(id);
        if (method === 'item/agentMessage/delta') this.block(run, { type: 'text', id, text: (block?.type === 'text' ? block.text : '') + String(p.delta || '') });
        else this.block(run, { type: 'thinking', id, thinking: (block?.type === 'thinking' ? block.thinking : '') + String(p.delta || '') });
      } else if (method === 'item/commandExecution/outputDelta') {
        const block = run.blocks.get(String(p.itemId));
        if (block?.type === 'tool_use') this.block(run, { ...block, input: { ...block.input, output: String(block.input.output || '') + String(p.delta || '') } });
      } else if (method === 'thread/tokenUsage/updated') {
        const usage = p.tokenUsage as { last?: { outputTokens?: number } };
        if (typeof usage?.last?.outputTokens === 'number') run.emit({ type: 'token_update', outputTokens: usage.last.outputTokens });
      } else if (method === 'turn/plan/updated') {
        const plan = p.plan as { step: string; status: string }[];
        this.block(run, { type: 'tool_use', id: `plan-${run.turnId}`, name: 'TodoWrite', input: { todos: plan.map(step => ({ content: step.step, activeForm: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })) } });
      }
    } catch (error) { run.settle(error instanceof Error ? error : new Error('Could not process a Codex event.')); }
  }
  private block(run: ActiveRun, block: CodexBlock): void { run.blocks.set(block.id, block); run.emit({ type: 'block', block }); }
  private item(run: ActiveRun, item: Item): void {
    if (!item?.id) return;
    switch (item.type) {
      case 'userMessage':
        if (typeof item.clientId === 'string') run.inputs.get(item.clientId)?.();
        break;
      case 'agentMessage':
        this.block(run, { type: 'text', id: item.id, text: String(item.text || '') });
        if (item.delivery === 'async' && Array.isArray(item.questions) && item.questions.length > 0) this.addQuestion(run, { question: {
          toolId: item.id, isBlocking: false,
          questions: item.questions.map((q, i) => ({ id: `question_${i}`, header: `question_${i}`, question: q.title, options: (q.options || []).map((label: string) => ({ label })) })),
        } });
        break;
      case 'reasoning': this.block(run, { type: 'thinking', id: item.id, thinking: Array.isArray(item.summary) ? item.summary.join('\n') : '' }); break;
      case 'commandExecution': this.block(run, { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command, output: item.aggregatedOutput || '', exit_code: item.exitCode, status: item.status } }); break;
      case 'fileChange': this.block(run, { type: 'tool_use', id: item.id, name: 'Edit', input: { changes: (item.changes as { path: string; kind: { type: string }; diff: string }[] || []).map(c => ({ path: c.path, kind: c.kind.type, diff: c.diff })), status: item.status } }); break;
      case 'mcpToolCall': this.block(run, { type: 'tool_use', id: item.id, name: `${item.server}.${item.tool}`, input: { arguments: item.arguments, result: item.result, error: item.error, status: item.status } }); break;
      case 'webSearch': this.block(run, { type: 'tool_use', id: item.id, name: 'WebSearch', input: { query: item.query, action: item.action } }); break;
      case 'dynamicToolCall': this.block(run, { type: 'tool_use', id: item.id, name: String(item.tool), input: { arguments: item.arguments, status: item.status } }); break;
    }
  }
}

export const codexSessions = new CodexSessions(codexAppServer);
export const runCodexStream = (prompt: string, cwd: string, emit: CodexEventCallback, opts: RunCodexOptions) => codexSessions.run(prompt, cwd, emit, opts);
