/**
 * Codex Provider
 *
 * Modular wrapper for @openai/codex-sdk that maps Codex events to Agentic's
 * WebSocket protocol. Fully isolated - if Codex breaks, Claude keeps working.
 *
 * The SDK is lazy-loaded at runtime so a missing/broken install can never crash
 * the Claude path. Types are imported with `import type` (erased at compile time,
 * no runtime dependency).
 *
 * @module server/providers/codex
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  Codex as CodexClass,
  CodexOptions,
  Input,
  ModelReasoningEffort,
  ThreadEvent,
  ThreadItem,
} from "@openai/codex-sdk";
import type { CodexSkillConfigEntry } from '../skills';

/**
 * Events emitted to the caller. These map 1:1 onto Agentic's client WebSocket
 * contract (the caller spreads `sessionId` on top before sending).
 *
 * - assistant_message / thinking_delta carry **deltas** (the client appends them)
 * - tool_use always carries a stable `toolId` (the client dedupes/keys on it)
 */
export interface CodexEvent {
  type:
    | 'assistant_message'
    | 'thinking_start'
    | 'thinking_delta'
    | 'tool_use'
    | 'token_update'
    | 'result'
    | 'retry_attempt'
    | 'error';
  content?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  outputTokens?: number;
  success?: boolean;
  message?: string;
  attempt?: number;
  maxAttempts?: number;
}

export type CodexEventCallback = (event: CodexEvent) => void;

export interface RunCodexOptions {
  /** Codex thread id to resume (multi-turn continuity). Null/undefined = new thread. */
  resumeThreadId?: string | null;
  /** Abort signal wired to the Stop button. */
  signal?: AbortSignal;
  /** Raw effort string from the UI; mapped to Codex reasoning effort. */
  effort?: string;
  /**
   * Codex model slug to run (e.g. 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra').
   * Omitted/undefined falls back to the CLI default — which may not be
   * entitled on every account, so the caller should always pass one.
   */
  model?: string;
  /**
   * MCP servers to expose to Codex, already in the CLI's `mcp_servers.*` shape
   * (see `toCodexMcpServers` in ../mcpServers). Injected via the SDK's
   * `CodexOptions.config`, which flattens this into `--config` overrides.
   * Empty/undefined = no MCP servers.
   */
  mcpServers?: Record<string, unknown>;
  /** Agentic-specific guidance injected before AGENTS.md on every Codex turn. */
  developerInstructions?: string;
  /** Absolute paths to images attached to this turn. */
  imagePaths?: string[];
  /** Explicit per-session user-skill overrides. Undefined preserves native config. */
  skillsConfig?: CodexSkillConfigEntry[];
  /** Fired with the thread id as soon as the thread starts (persist for resume). */
  onThreadId?: (id: string) => void;
}

export function buildCodexConfig(
  options: Pick<RunCodexOptions, 'mcpServers' | 'developerInstructions' | 'skillsConfig'>,
): NonNullable<CodexOptions['config']> {
  const config: Record<string, unknown> = {};

  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    config.mcp_servers = options.mcpServers;
  }
  if (options.developerInstructions) {
    config.developer_instructions = options.developerInstructions;
  }
  if (options.skillsConfig !== undefined) {
    config.skills = { config: options.skillsConfig };
  }

  return config as NonNullable<CodexOptions['config']>;
}

// Lazy-loaded Codex SDK constructor (prevents import errors if not installed).
let CodexCtor: typeof CodexClass | null = null;
let sdkLoadError: Error | null = null;

/** Attempts to load the Codex SDK dynamically. */
async function loadCodexSDK(): Promise<typeof CodexClass> {
  if (CodexCtor) return CodexCtor;
  if (sdkLoadError) throw sdkLoadError;

  try {
    const mod = await import("@openai/codex-sdk");
    CodexCtor = mod.Codex;
    console.log("🤖 Codex SDK loaded successfully");
    return CodexCtor;
  } catch (error) {
    sdkLoadError = error as Error;
    console.warn("🤖 Codex SDK not available:", (error as Error).message);
    throw new Error("Codex SDK not installed. Run: bun install");
  }
}

/**
 * Checks if Codex is installed and authenticated.
 *
 * @returns Promise<boolean> - true if Codex is available
 */
export async function isCodexAvailable(): Promise<boolean> {
  try {
    await loadCodexSDK();

    // Auth file indicates the CLI is logged in (ChatGPT or API key).
    const authPath = join(homedir(), ".codex", "auth.json");
    if (existsSync(authPath)) {
      console.log("🤖 Codex authentication found");
      return true;
    }

    // Fallback: probe the CLI binary.
    const proc = Bun.spawn(["codex", "--version"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log("🤖 Codex CLI is available");
      return true;
    }

    console.warn("🤖 Codex CLI not authenticated or not found");
    return false;
  } catch (error) {
    console.warn("🤖 Codex availability check failed:", (error as Error).message);
    return false;
  }
}

/** Map the UI effort string to the SDK's reasoning-effort enum (undefined = CLI default). */
function toReasoningEffort(effort?: string): ModelReasoningEffort | undefined {
  switch (effort) {
    case 'minimal': return 'minimal';
    case 'low':     return 'low';
    case 'medium':  return 'medium';
    case 'high':    return 'high';
    case 'xhigh':   return 'xhigh';
    case 'max':     return 'max';
    case 'ultra':   return 'ultra';
    default:        return undefined;
  }
}

/**
 * Codex reports its OWN transient retries as `error` stream events — e.g.
 * "Reconnecting... 1/5 (stream disconnected before completion: Internal server
 * error)" (see `notify_stream_error` in codex-rs). The turn keeps running and
 * usually completes, so surfacing these as errors spams the chat with bubbles
 * that disappear on reload. Map them to `retry_attempt` (a toast) instead.
 */
export function parseCodexRetryNotice(message: string | undefined): CodexEvent | null {
  const match = message?.match(/^Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)\s*(?:\(([\s\S]*)\))?$/);
  if (!match) return null;
  return {
    type: 'retry_attempt',
    attempt: Number(match[1]),
    maxAttempts: Number(match[2]),
    message: match[3] || 'Connection interrupted',
  };
}

/** Build the structured SDK input required for Codex image attachments. */
export function buildCodexInput(prompt: string, imagePaths: string[] = []): Input {
  if (imagePaths.length === 0) return prompt;

  return [
    ...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []),
    ...imagePaths.map((imagePath) => ({ type: 'local_image' as const, path: imagePath })),
  ];
}

/**
 * Emit only the newly-appended slice of a cumulative text field.
 * Codex sends the *full* text on every item.updated/completed, but the client
 * appends deltas — so we diff against what we've already forwarded.
 */
function emitTextDelta(
  id: string,
  fullText: string,
  sentLen: Map<string, number>,
  emit: (delta: string) => void,
): void {
  const prev = sentLen.get(id) ?? 0;
  if (fullText.length > prev) {
    emit(fullText.slice(prev));
    sentLen.set(id, fullText.length);
  }
}

/** Map a single Codex thread item to client events. */
function handleItem(
  item: ThreadItem,
  phase: 'item.started' | 'item.updated' | 'item.completed',
  onEvent: CodexEventCallback,
  sentLen: Map<string, number>,
  thinkingStarted: Set<string>,
): void {
  switch (item.type) {
    case 'agent_message':
      emitTextDelta(item.id, item.text, sentLen, (delta) =>
        onEvent({ type: 'assistant_message', content: delta }));
      break;

    case 'reasoning':
      if (!thinkingStarted.has(item.id)) {
        thinkingStarted.add(item.id);
        onEvent({ type: 'thinking_start' });
      }
      emitTextDelta(item.id, item.text, sentLen, (delta) =>
        onEvent({ type: 'thinking_delta', content: delta }));
      break;

    // Tools: emit once, when terminal, always with a stable toolId.
    case 'command_execution':
      if (phase === 'item.completed') {
        onEvent({
          type: 'tool_use',
          toolId: item.id,
          toolName: 'Bash',
          toolInput: {
            command: item.command,
            output: item.aggregated_output,
            exit_code: item.exit_code,
            status: item.status,
          },
        });
      }
      break;

    case 'file_change':
      if (phase === 'item.completed') {
        onEvent({
          type: 'tool_use',
          toolId: item.id,
          toolName: 'Edit',
          toolInput: { changes: item.changes, status: item.status },
        });
      }
      break;

    case 'mcp_tool_call':
      if (phase === 'item.completed') {
        onEvent({
          type: 'tool_use',
          toolId: item.id,
          toolName: `${item.server}.${item.tool}`,
          toolInput: { arguments: item.arguments, status: item.status },
        });
      }
      break;

    case 'web_search':
      if (phase === 'item.completed') {
        onEvent({
          type: 'tool_use',
          toolId: item.id,
          toolName: 'WebSearch',
          toolInput: { query: item.query },
        });
      }
      break;

    case 'todo_list':
      if (phase === 'item.completed') {
        onEvent({
          type: 'tool_use',
          toolId: item.id,
          toolName: 'TodoWrite',
          toolInput: { items: item.items },
        });
      }
      break;

    case 'error':
      onEvent({ type: 'error', message: item.message });
      break;
  }
}

/**
 * Runs a Codex streaming conversation and maps events to Agentic's protocol.
 *
 * @param prompt - User prompt to send to Codex
 * @param workingDir - Working directory for file operations
 * @param onEvent - Callback for streaming events
 * @param opts - Resume id, abort signal, effort, and thread-id callback
 * @throws Error if Codex SDK is not available or execution fails (non-abort)
 */
export async function runCodexStream(
  prompt: string,
  workingDir: string,
  onEvent: CodexEventCallback,
  opts: RunCodexOptions = {},
): Promise<void> {
  const Codex = await loadCodexSDK();

  // Inject Agentic's session-specific configuration through the SDK. The SDK
  // flattens this object into CLI `--config` flags, with the same shape as
  // ~/.codex/config.toml.
  const hasMcp = !!opts.mcpServers && Object.keys(opts.mcpServers).length > 0;
  const config = buildCodexConfig(opts);
  const codexOptions: CodexOptions = { config };
  const codex = Object.keys(config).length > 0 ? new Codex(codexOptions) : new Codex();

  if (hasMcp) {
    console.log(`🔌 Codex MCP: ${Object.keys(opts.mcpServers ?? {}).join(', ')}`);
  }

  const reasoningEffort = toReasoningEffort(opts.effort);
  const threadOptions = {
    workingDirectory: workingDir,
    skipGitRepoCheck: true,
    // `danger-full-access` (not `workspace-write`) is required for MCP tool
    // calls to execute. Under the managed `workspace-write`/`read-only`
    // sandboxes, `codex exec` cancels every MCP tool call with "user cancelled
    // MCP tool call" — even with `approvalPolicy: 'never'` — because exec mode
    // has no interactive approval channel (a known Codex regression, see
    // openai/codex#16685, #19430). Full access matches Agentic's local
    // full-filesystem design and the Anthropic provider's allow-all posture.
    sandboxMode: 'danger-full-access' as const,
    approvalPolicy: 'never' as const,
    networkAccessEnabled: true,
    webSearchEnabled: true,
    ...(opts.model ? { model: opts.model } : {}),
    ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
  };

  const thread = opts.resumeThreadId
    ? codex.resumeThread(opts.resumeThreadId, threadOptions)
    : codex.startThread(threadOptions);

  console.log(
    `🤖 Codex ${opts.resumeThreadId ? 'resume' : 'start'} [${opts.model ?? 'cli-default'}] in ${workingDir} — prompt: ${prompt.slice(0, 80)}...`,
  );

  // Per-item cumulative-length tracking for delta diffing.
  const sentLen = new Map<string, number>();
  const thinkingStarted = new Set<string>();
  const input = buildCodexInput(prompt, opts.imagePaths);

  try {
    const { events } = await thread.runStreamed(input, { signal: opts.signal });

    for await (const event of events as AsyncIterable<ThreadEvent>) {
      switch (event.type) {
        case 'thread.started':
          if (event.thread_id) opts.onThreadId?.(event.thread_id);
          break;

        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          handleItem(event.item, event.type, onEvent, sentLen, thinkingStarted);
          break;

        case 'turn.completed':
          if (event.usage) {
            onEvent({ type: 'token_update', outputTokens: event.usage.output_tokens });
          }
          onEvent({ type: 'result', success: true });
          break;

        case 'turn.failed': {
          // Codex delivers the real reason (e.g. "model not supported") here as
          // a JSON event on stdout — the SDK separately throws a generic
          // "exited with code 1", so log this explicitly or it gets buried.
          const failMsg = event.error?.message || 'Codex turn failed';
          console.error(`🤖 Codex turn failed [${opts.model ?? 'cli-default'}]:`, failMsg);
          onEvent({ type: 'error', message: failMsg });
          break;
        }

        case 'error': {
          const retry = parseCodexRetryNotice(event.message);
          if (retry) {
            console.warn(`🤖 Codex retrying ${retry.attempt}/${retry.maxAttempts}: ${retry.message}`);
            onEvent(retry);
            break;
          }
          console.error(`🤖 Codex error [${opts.model ?? 'cli-default'}]:`, event.message);
          onEvent({ type: 'error', message: event.message || 'Unknown Codex error' });
          break;
        }
      }
    }

    console.log("🤖 Codex stream completed");
  } catch (error) {
    // Graceful stop: the Stop button aborted the turn — not a real error.
    if (opts.signal?.aborted) {
      console.log("🤖 Codex stream aborted by user");
      return;
    }
    console.error("🤖 Codex stream error:", error);
    onEvent({ type: 'error', message: error instanceof Error ? error.message : 'Unknown Codex error' });
    throw error;
  }
}
