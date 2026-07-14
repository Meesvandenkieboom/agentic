/**
 * WebSocket Message Handlers — Router
 *
 * Dispatches incoming WebSocket messages to focused handler modules.
 * The core chat flow is handled in handleChatMessage (this file),
 * with sub-responsibilities delegated to:
 *   - controlHandlers.ts  — plan approval, permission mode, stop, kill, answer
 *   - responseLoop.ts     — background response streaming from SDK
 *   - preToolUseHook.ts   — Bash interception (background/long-running commands)
 *   - branchContext.ts    — branch history formatting
 *   - contextUsageHandler.ts — token usage tracking
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { sessionDb } from "../database";
import { getSystemPrompt, injectWorkingDirIntoAgents } from "../systemPrompt";
import { configureProvider } from "../providers";
import { getMcpServers, toCodexMcpServers } from "../mcpServers";
import { getPortOwnerPid } from "../mcpCleanup";
import { getOrCreateMcpBridge, isMcpBridgeRegistered } from "../mcpSingletonBridge";
import { mcpClientManager } from "../mcpClientManager";
import { AGENT_REGISTRY } from "../agents";
import { validateDirectory, getSessionPathsFromWorkingDir } from "../directoryUtils";
import { saveImageToSessionPictures, saveFileToSessionFiles } from "../imageUtils";
import { loadUserConfig } from "../userConfig";
import { parseApiError, getUserFriendlyMessage } from "../utils/apiErrors";
import { sessionStreamManager, type ContentBlock, type MessageContent } from "../sessionStreamManager";
import { expandSlashCommand } from "../slashCommandExpander";
import { generateChatTitle } from "../utils/chatTitles";

import type { ChatWebSocket } from "./types";
import { MODEL_MAP, pendingQuestions } from "./types";
import { formatBranchHistory } from "./branchContext";
import { createPreToolUseHooks } from "./preToolUseHook";
import { startResponseLoop } from "./responseLoop";
import {
  handleAnswerQuestion,
  handleApprovePlan,
  handleSetPermissionMode,
  handleKillBackgroundProcess,
  handleStopGeneration,
} from "./controlHandlers";
import { normalizeModelId } from "../../client/config/models";
import { isAdaptiveThinkingModel } from "../../shared/adaptiveThinkingModels.mjs";

// ───────────────────────────────────────────────
// Main message router
// ───────────────────────────────────────────────

export async function handleWebSocketMessage(
  ws: ChatWebSocket,
  message: string,
  activeQueries: Map<string, unknown>
): Promise<void> {
  if (ws.data?.type === 'hot-reload') return;

  try {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'chat':
        await handleChatMessage(ws, data, activeQueries);
        break;
      case 'approve_plan':
        await handleApprovePlan(ws, data, activeQueries);
        break;
      case 'set_permission_mode':
        await handleSetPermissionMode(ws, data, activeQueries);
        break;
      case 'answer_question':
        handleAnswerQuestion(data);
        break;
      case 'kill_background_process':
        await handleKillBackgroundProcess(ws, data);
        break;
      case 'stop_generation':
        await handleStopGeneration(ws, data);
        break;
      case 'reconnect':
        handleReconnect(ws, data);
        break;
    }
  } catch (error) {
    console.error('WebSocket message error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Invalid message format',
      sessionId: ws.data?.sessionId
    }));
  }
}

// ───────────────────────────────────────────────
// Reconnect handler
// ───────────────────────────────────────────────

function handleReconnect(ws: ChatWebSocket, data: Record<string, unknown>): void {
  const { sessionId } = data;
  if (!sessionId || typeof sessionId !== 'string') return;

  const session = sessionDb.getSession(sessionId);
  if (!session) {
    console.warn(`⚠️ Reconnect for non-existent session: ${sessionId.substring(0, 8)}`);
    ws.send(JSON.stringify({ type: 'reconnect_ack', sessionId, isGenerating: false }));
    return;
  }

  ws.data = { type: 'chat', sessionId };
  sessionStreamManager.updateWebSocket(sessionId, ws);
  const generating = sessionStreamManager.isGenerating(sessionId);
  console.log(`🔄 Client reconnected for session ${sessionId.substring(0, 8)} (${generating ? '⚡ generating' : '💤 idle'})`);
  ws.send(JSON.stringify({ type: 'reconnect_ack', sessionId, isGenerating: generating }));
}

// ───────────────────────────────────────────────
// Chat message handler
// ───────────────────────────────────────────────

async function handleChatMessage(
  ws: ChatWebSocket,
  data: Record<string, unknown>,
  activeQueries: Map<string, unknown>
): Promise<void> {
  const { content, sessionId, model, timezone, effort } = data;

  if (!content || !sessionId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing content or sessionId', sessionId }));
    return;
  }

  const session = sessionDb.getSession(sessionId as string);
  if (!session) {
    console.error('❌ Session not found:', sessionId);
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found', sessionId }));
    return;
  }

  const requestedModelId = typeof model === 'string' ? normalizeModelId(model) : undefined;
  const storedModelId = session.model ? normalizeModelId(session.model) : undefined;
  const hasPriorMessages = session.message_count > 0;
  const effectiveModelId = hasPriorMessages
    ? (storedModelId || normalizeModelId())
    : (requestedModelId || storedModelId || normalizeModelId());

  if (session.model !== effectiveModelId) {
    sessionDb.updateSessionModel(sessionId as string, effectiveModelId);

    if (session.sdk_session_id && storedModelId && storedModelId !== effectiveModelId) {
      sessionDb.updateSdkSessionId(sessionId as string, null);
      session.sdk_session_id = undefined;
      console.log(`🔄 Cleared SDK session ID after model changed from ${storedModelId} to ${effectiveModelId}`);
    }

    session.model = effectiveModelId;
  }

  const workingDir = session.working_directory;

  // Process attachments
  const { imageBlocks, filePaths } = processAttachments(content, sessionId as string, workingDir);

  // Extract text content for prompt
  let promptText = typeof content === 'string' ? content : '';
  if (Array.isArray(content)) {
    const textBlocks = (content as Array<Record<string, unknown>>)
      .filter(b => b.type === 'text')
      .map(b => b.text as string);
    promptText = textBlocks.join('\n');
  }

  // Handle special commands
  const trimmedPrompt = promptText.trim();
  if (handleSpecialCommands(ws, trimmedPrompt, sessionId as string)) return;

  // Save user message to database
  const contentForDb = typeof content === 'string' ? content : JSON.stringify(content);
  sessionDb.addMessage(sessionId as string, 'user', contentForDb);

  // Expand slash commands
  if (trimmedPrompt.startsWith('/')) {
    const expandedPrompt = expandSlashCommand(trimmedPrompt, workingDir);
    if (expandedPrompt) {
      promptText = expandedPrompt;
    } else {
      console.warn(`⚠️  Slash command not found: ${promptText}`);
    }
  }

  // Build multimodal content
  let messageContent: MessageContent = promptText;
  if (imageBlocks.length > 0 || filePaths.length > 0) {
    const contentParts: ContentBlock[] = [];
    contentParts.push(...imageBlocks);

    if (filePaths.length > 0) {
      const fileRefs = filePaths.map(p => `[File attached: ${p}]`).join('\n');
      promptText = fileRefs + '\n\n' + promptText;
    }
    if (promptText.trim()) {
      contentParts.push({ type: 'text', text: promptText });
    }
    messageContent = contentParts;
    console.log(`📷 Built multimodal message: ${imageBlocks.length} image(s), ${contentParts.filter(b => b.type === 'text').length} text block(s)`);
  }

  // Check if continuing existing stream or starting new
  const isNewStream = !sessionStreamManager.hasStream(sessionId as string);

  // Configure model and provider
  const modelConfig = MODEL_MAP[effectiveModelId] || MODEL_MAP[normalizeModelId()];
  const { apiModelId, provider } = modelConfig;
  const providerType = provider as 'anthropic' | 'codex';

  try {
    await configureProvider(providerType);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Provider configuration error:', errorMessage);
    ws.send(JSON.stringify({ type: 'error', message: errorMessage, sessionId }));
    return;
  }

  // Auto-generate title
  if (session.title === 'New Chat') {
    const userText = typeof content === 'string' ? content : promptText;
    generateChatTitle(userText).then(title => {
      sessionDb.renameSession(sessionId as string, title);
      sessionStreamManager.safeSend(sessionId as string, JSON.stringify({
        type: 'session_title_updated', sessionId, title,
      }));
    }).catch(err => console.warn('Title generation failed:', err));
  }

  // Get MCP servers
  const mcpServers = await getMcpServers(providerType, apiModelId);

  console.log(`📨 [${apiModelId} @ ${provider}] Session: ${sessionId?.toString().substring(0, 8)} (${session.mode} mode) ${isNewStream ? '🆕 NEW SUBPROCESS' : '♻️ CONTINUE SUBPROCESS'}`);

  // Validate working directory
  const validation = validateDirectory(workingDir);
  if (!validation.valid) {
    console.error('❌ Working directory invalid:', validation.error);
    ws.send(JSON.stringify({ type: 'error', message: `Working directory error: ${validation.error}`, sessionId }));
    return;
  }

  if (process.platform === 'linux' && workingDir.startsWith('/mnt/')) {
    console.warn('⚠️  WARNING: Working directory is on Windows filesystem (WSL) — 10-20x slower I/O');
  }

  // For existing streams: update WebSocket, enqueue message, return
  if (!isNewStream) {
    const abortCtrl = sessionStreamManager.getAbortController(sessionId as string);
    if (abortCtrl?.signal.aborted) {
      console.log(`🔄 Session ${(sessionId as string).substring(0, 8)} was aborted, cleaning up`);
      sessionStreamManager.cleanupSession(sessionId as string, 'pre_send_cleanup');
      activeQueries.delete(sessionId as string);
      // Fall through to create new stream
    } else {
      sessionStreamManager.updateWebSocket(sessionId as string, ws);
      sessionStreamManager.sendMessage(sessionId as string, messageContent);
      return;
    }
  }

  // Codex provider (separate SDK)
  if (providerType === 'codex') {
    await handleCodexProvider(
      ws, session, sessionId as string, promptText, workingDir,
      effort as string | undefined,
      apiModelId,
      mcpServers,
    );
    return;
  }

  // Claude SDK — spawn new stream
  await spawnClaudeStream(
    ws, session, sessionId as string, workingDir, messageContent,
    apiModelId, providerType, timezone as string | undefined,
    mcpServers, activeQueries, effort as string | undefined,
  );
}

// ───────────────────────────────────────────────
// Reasoning effort → thinking token budget
// ───────────────────────────────────────────────

/**
 * Map a user-facing reasoning effort level to the underlying
 * maxThinkingTokens budget used by the Claude Agent SDK.
 */
function effortToThinkingTokens(effort: string | undefined): number {
  switch (effort) {
    case 'low':    return 2_000;
    case 'medium': return 16_000;
    case 'high':   return 80_000;   // previous hard-coded default
    case 'xhigh':  return 128_000;
    case 'max':    return 200_000;
    case 'ultra':  return 200_000;  // Codex-only level; treat as max if it slips through
    default:       return 80_000;
  }
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function processAttachments(
  content: unknown,
  sessionId: string,
  workingDir: string,
): { imageBlocks: ContentBlock[]; filePaths: string[] } {
  const imageBlocks: ContentBlock[] = [];
  const filePaths: string[] = [];

  if (!Array.isArray(content)) return { imageBlocks, filePaths };

  const contentBlocks = content as Array<Record<string, unknown>>;

  for (const block of contentBlocks) {
    if (block.type === 'image' && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>;
      if (source.type === 'base64' && typeof source.data === 'string') {
        const base64Data = `data:${source.media_type || 'image/png'};base64,${source.data}`;
        saveImageToSessionPictures(base64Data, sessionId, workingDir);
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: (source.media_type as string) || 'image/png',
            data: source.data as string,
          },
        });
      }
    }

    if (block.type === 'document' && typeof block.data === 'string' && typeof block.name === 'string') {
      const filePath = saveFileToSessionFiles(block.data as string, block.name as string, sessionId, workingDir);
      filePaths.push(filePath);
    }
  }

  if (imageBlocks.length > 0 || filePaths.length > 0) {
    console.log(`📎 Attachments: ${imageBlocks.length} image(s), ${filePaths.length} file(s)`);
  }

  return { imageBlocks, filePaths };
}

/** Handle /compact and /clear commands. Returns true if the command was handled. */
function handleSpecialCommands(ws: ChatWebSocket, trimmedPrompt: string, sessionId: string): boolean {
  if (trimmedPrompt === '/compact') {
    console.log('🗜️ /compact command detected');
    ws.send(JSON.stringify({ type: 'compact_loading', sessionId }));
    return false; // Continue to SDK
  }

  if (trimmedPrompt === '/clear') {
    console.log('🧹 /clear command detected — clearing AI context');
    sessionDb.addMessage(sessionId, 'user', '/clear');
    sessionDb.addMessage(sessionId, 'assistant', JSON.stringify([{
      type: 'text',
      text: '--- Context cleared. The AI will not remember previous messages ---'
    }]));
    sessionDb.updateSdkSessionId(sessionId, null);

    const wasAborted = sessionStreamManager.abortSession(sessionId);
    if (wasAborted) {
      console.log('🛑 Aborted existing SDK subprocess for clean start');
      sessionStreamManager.cleanupSession(sessionId, 'clear_command');
    }

    ws.send(JSON.stringify({
      type: 'assistant_message',
      content: '--- Context cleared. The AI will not remember previous messages ---',
      sessionId,
    }));
    ws.send(JSON.stringify({ type: 'result', success: true, sessionId }));
    return true;
  }

  return false;
}

/**
 * A single persisted content block for a Codex assistant message. Mirrors the
 * shape the Claude path stores (see responseLoop.ts) so the client renders
 * Codex and Claude history identically on reload.
 */
type CodexBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/**
 * Runs one Codex turn and bridges its events onto Agentic's WebSocket + DB.
 *
 * Unlike the Claude path (which keeps a long-lived SDK subprocess per session),
 * each Codex turn is self-contained: we register a stream purely so the Stop
 * button has an AbortController to cancel, then tear it down in `finally`.
 * Multi-turn continuity comes from Codex's own `resumeThread` keyed on the
 * thread id we persist in `sdk_session_id` — NOT from the in-memory queue.
 */
async function handleCodexProvider(
  ws: ChatWebSocket,
  session: ReturnType<typeof sessionDb.getSession> & object,
  sessionId: string,
  promptText: string,
  workingDir: string,
  effort: string | undefined,
  model: string | undefined,
  mcpServers: Record<string, unknown>,
): Promise<void> {
  // Register a stream so Stop/reconnect work and an AbortController exists.
  // We never consume the message queue — only the AbortController matters here.
  sessionStreamManager.getOrCreateStream(sessionId);
  sessionStreamManager.updateWebSocket(sessionId, ws);
  sessionStreamManager.setGenerating(sessionId, true);
  const signal = sessionStreamManager.getAbortController(sessionId)?.signal;

  // Ordered content blocks accumulated across the turn. Keep a single DB
  // assistant row updated so reload/reconnect can restore in-progress Codex
  // output instead of only the user prompt.
  const blocks: CodexBlock[] = [];
  let assistantMessageId: string | null = null;
  const persist = (): void => {
    if (blocks.length === 0) return;
    const content = JSON.stringify(blocks);
    if (assistantMessageId) {
      sessionDb.updateMessage(assistantMessageId, content);
    } else {
      const msg = sessionDb.addMessage(sessionId, 'assistant', content);
      assistantMessageId = msg.id;
    }
  };

  try {
    const { runCodexStream, isCodexAvailable } = await import('../providers/codex');

    const codexAvailable = await isCodexAvailable();
    if (!codexAvailable) {
      sessionStreamManager.safeSend(sessionId, JSON.stringify({
        type: 'error',
        message: 'Codex is not available. Run "bun run login" and select Codex to authenticate.',
        sessionId,
      }));
      return;
    }

    const paths = getSessionPathsFromWorkingDir(workingDir);

    // Merge UI-connected MCP servers, then bridge port-bound stdio MCPs (eg
    // rbxstudio-mcp on :3002) through the shared singleton — exactly like the
    // Claude path (see spawnClaudeStream). This makes Codex connect to the same
    // HTTP-wrapped child instead of spawning its own and colliding on the port.
    // Finally convert to the Codex CLI's `mcp_servers.*` config shape.
    const connectedMcpServers = mcpClientManager.getMcpServersForSDK();
    const allMcpServers: Record<string, unknown> = { ...mcpServers, ...connectedMcpServers };
    await bridgeOrExcludePortBoundMcps(allMcpServers);
    const codexMcpServers = toCodexMcpServers(allMcpServers);

    await runCodexStream(
      promptText,
      paths.workspace,
      (event) => {
        // Accumulate structured blocks for the single end-of-turn DB save.
        if (event.type === 'assistant_message' && event.content) {
          const last = blocks[blocks.length - 1];
          if (last && last.type === 'text') {
            last.text += event.content;
          } else {
            blocks.push({ type: 'text', text: event.content });
          }
          persist();
        } else if (event.type === 'tool_use' && event.toolId) {
          blocks.push({
            type: 'tool_use',
            id: event.toolId,
            name: event.toolName ?? 'tool',
            input: event.toolInput ?? {},
          });
          persist();
        } else if (event.type === 'result') {
          persist();
        }

        // Relay the event to the client (caller spreads sessionId on top).
        sessionStreamManager.safeSend(sessionId, JSON.stringify({ ...event, sessionId }));
      },
      {
        resumeThreadId: session.sdk_session_id ?? null,
        signal,
        effort,
        model,
        mcpServers: codexMcpServers,
        onThreadId: (id) => sessionDb.updateSdkSessionId(sessionId, id),
      },
    );

    // Save whatever we have if the SDK exits without an explicit result.
    // On Stop, `generation_stopped` was already sent by abortSession.
    persist();
  } catch (error) {
    console.error('❌ Codex provider error:', error);
    persist(); // keep any partial work produced before the failure
    sessionStreamManager.safeSend(sessionId, JSON.stringify({
      type: 'error',
      message: error instanceof Error ? error.message : 'Codex provider error',
      sessionId,
    }));
  } finally {
    // Tear down the in-memory stream; next turn resumes via resumeThread.
    sessionStreamManager.setIdle(sessionId);
    sessionStreamManager.cleanupSession(sessionId, 'codex_done');
  }
}

// ───────────────────────────────────────────────
// Port-bound stdio MCP servers
// ───────────────────────────────────────────────
//
// Some stdio MCP servers ALSO open a TCP listener on a fixed port (eg
// rbxstudio-mcp listens on 3002 for the Roblox Studio plugin to poll).
// That means only ONE instance can run system-wide.
//
// Each chat session gets its own SDK subprocess, and each SDK subprocess
// would normally spawn its OWN MCP children. So if chat A is using
// rbxstudio (holding 3002) and the user opens chat B, the SDK in B
// would fire up `npx -y rbxstudio-mcp` and crash with EADDRINUSE — and
// chat B would see zero rbxstudio tools with no error message.
//
// Claude Desktop avoids this because it's a single process — it spawns
// each MCP child once and reuses it across all conversations.
//
// Our fix: spawn port-bound MCPs as singletons inside the Bun server
// (see ../mcpSingletonBridge.ts). Each singleton is wrapped in a tiny
// HTTP MCP server on 127.0.0.1:<random>. Then for each chat session, we
// REWRITE the MCP config from `{type: stdio, command: npx, ...}` to
// `{type: http, url: http://127.0.0.1:.../mcp}`. The SDK opens an HTTP
// connection to the bridge instead of spawning its own stdio child, and
// all chat sessions share the one MCP instance just like Claude Desktop.
//
// If we can't bridge (eg another external process already owns port
// 3002, or the singleton fails to start), fall back to excluding the
// MCP from this session's config and logging a clear warning — better
// than silently broken tools.
const PORT_BOUND_MCP_PACKAGES: Record<string, number> = {
  'rbxstudio-mcp': 3002,
  'robloxstudio-mcp': 3002, // legacy alias
};

interface DetectedPortBoundMcp {
  id: string;
  pkg: string;
  port: number;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function detectPortBoundMcps(
  allMcpServers: Record<string, unknown>,
): DetectedPortBoundMcp[] {
  const matches: DetectedPortBoundMcp[] = [];
  for (const [id, cfg] of Object.entries(allMcpServers)) {
    const c = cfg as Record<string, unknown>;
    if (c.type !== 'stdio') continue;
    const args = (c.args as string[] | undefined) ?? [];
    const command = c.command as string | undefined;
    if (!command) continue;
    for (const [pkg, port] of Object.entries(PORT_BOUND_MCP_PACKAGES)) {
      if (args.some(a => typeof a === 'string' && (a === pkg || a.endsWith('/' + pkg)))) {
        matches.push({
          id,
          pkg,
          port,
          command,
          args,
          env: c.env as Record<string, string> | undefined,
        });
        break;
      }
    }
  }
  return matches;
}

/**
 * For each port-bound MCP in this session's config:
 *
 *   1. If we already have a singleton bridge for it (registered earlier
 *      in this Bun process's lifetime), REUSE its URL. The bridge will
 *      respawn its child if needed — we don't need to check the port.
 *
 *   2. Else, check if the port is free:
 *      - Free → spin up a new singleton bridge, rewrite the entry from
 *        stdio → HTTP. All future sessions reuse this same bridge.
 *      - Held by some other process → exclude this MCP from the session
 *        and log clearly. Common cause: user ran `npx rbxstudio-mcp`
 *        manually in a terminal, or a previous Bun process leaked.
 *
 * Mutates `allMcpServers`.
 */
async function bridgeOrExcludePortBoundMcps(
  allMcpServers: Record<string, unknown>,
): Promise<void> {
  const portBound = detectPortBoundMcps(allMcpServers);
  if (portBound.length === 0) return;

  for (const { id, pkg, port, command, args, env } of portBound) {
    if (!isMcpBridgeRegistered(id)) {
      // No singleton yet — make sure the port isn't held by something
      // we don't control before trying to spawn one.
      const ownerPid = await getPortOwnerPid(port);
      if (ownerPid !== null) {
        console.warn(
          `⚠️  MCP '${id}' (${pkg}) excluded — port ${port} held by external ` +
          `PID ${ownerPid}. Stop that process (or restart agentic) to let the ` +
          `singleton manager take over.`,
        );
        delete allMcpServers[id];
        continue;
      }
    }

    try {
      const url = await getOrCreateMcpBridge(id, { command, args, env });
      allMcpServers[id] = { type: 'http', url };
      console.log(`🌉 MCP '${id}' bridged via singleton at ${url}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `❌ MCP '${id}' (${pkg}) bridge failed: ${msg} — excluding from this session`,
      );
      delete allMcpServers[id];
    }
  }
}

async function spawnClaudeStream(
  ws: ChatWebSocket,
  session: ReturnType<typeof sessionDb.getSession> & object,
  sessionId: string,
  workingDir: string,
  messageContent: MessageContent,
  apiModelId: string,
  providerType: 'anthropic' | 'codex',
  timezone: string | undefined,
  mcpServers: Record<string, unknown>,
  activeQueries: Map<string, unknown>,
  effort: string | undefined,
): Promise<void> {
  try {
    // NOTE: Do NOT call cleanupOrphanedMcpProcesses() here. It does a
    // system-wide pgrep kill of patterns like 'robloxstudio-mcp',
    // 'mcp-remote', 'mcp-server' — which murders MCP children belonging to
    // OTHER active chat sessions and can leave port 3002 in TIME_WAIT,
    // preventing the SDK's freshly-spawned rbxstudio-mcp from binding.
    // Startup cleanup (server.ts) is sufficient; the SDK reaps its own
    // MCP children when it exits.

    const paths = getSessionPathsFromWorkingDir(workingDir);
    const workspaceDir = paths.workspace;
    const userConfig = loadUserConfig();

    // Build system prompt
    const baseSystemPrompt = getSystemPrompt(
      providerType, AGENT_REGISTRY, userConfig,
      timezone, session.mode,
      session.github_repo, workspaceDir,
    );
    const systemPromptWithContext = `${baseSystemPrompt}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 ENVIRONMENT CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WORKING DIRECTORY: ${workspaceDir}

When creating files for this session, use the workspace directory above.
All file paths should be relative to this directory or use absolute paths within it.

IMPORTANT: Do not modify files outside the workspace directory.
- Chat metadata: ${paths.metadata} (read-only)
- CLAUDE.md: ${paths.claudeMd} (read-only)
`;

    const promptWordCount = systemPromptWithContext.split(/\s+/).length;
    const estimatedTokens = Math.round(promptWordCount * 1.3);
    console.log(`📏 System prompt size: ${promptWordCount} words (~${estimatedTokens} tokens)`);

    const agentsWithWorkingDir = injectWorkingDirIntoAgents(AGENT_REGISTRY, workspaceDir);

    let stderrOutput = '';
    // Set when the SDK CLI reports the resume target is missing. A stored
    // sdk_session_id can point at a conversation the local CLI has no
    // transcript for (imported chats, deleted transcripts, moved machines);
    // resuming it exits the subprocess 1, and since the id stays in the DB
    // every later message fails identically. Detected here so onLoopError
    // can clear the id and retry the turn fresh.
    let resumeSessionNotFound = false;
    let recoveryAttempted = false;

    // Check resume capability
    const sessionMessages = sessionDb.getSessionMessages(sessionId);
    const isFirstMessage = sessionMessages.length === 1;

    if (!isFirstMessage && session.sdk_session_id) {
      console.log(`📋 Using resume with SDK session ID: ${session.sdk_session_id}`);
    }

    // Branch context injection
    const isBranchStart = !isFirstMessage && !session.sdk_session_id;
    if (isBranchStart) {
      const priorMessages = sessionMessages.slice(0, -1);
      if (priorMessages.length > 0) {
        const historyContext = formatBranchHistory(priorMessages);
        if (typeof messageContent === 'string') {
          messageContent = historyContext + '\n\n' + messageContent;
        } else if (Array.isArray(messageContent)) {
          messageContent = [{ type: 'text' as const, text: historyContext }, ...messageContent];
        }
        console.log(`🌿 Branch start: injected ${priorMessages.length} prior messages as context`);
      }
    }

    // Build query options
    const queryOptions: Record<string, unknown> = {
      model: apiModelId,
      systemPrompt: systemPromptWithContext,
      canUseTool: async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }) => {
        if (toolName === 'AskUserQuestion') {
          const toolId = options.toolUseID || `question-${Date.now()}`;
          console.log(`❓ AskUserQuestion intercepted (toolId: ${toolId})`);

          sessionStreamManager.safeSend(sessionId, JSON.stringify({
            type: 'ask_user_question',
            toolId,
            questions: input.questions || [],
            sessionId,
          }));

          const answer = await new Promise<string>((resolve) => {
            pendingQuestions.set(sessionId, { resolve, toolId });
          });

          console.log(`✅ AskUserQuestion answered (toolId: ${toolId})`);
          return { behavior: 'allow' as const, updatedInput: { ...input, answers: JSON.parse(answer) } };
        }
        return { behavior: 'allow' as const, updatedInput: input };
      },
      ...(isFirstMessage || !session.sdk_session_id ? {} : { resume: session.sdk_session_id }),
      includePartialMessages: true,
      agents: agentsWithWorkingDir,
      cwd: workspaceDir,
      settingSources: ['project'],
      stderr: (data: string) => {
        const trimmedData = data.trim();
        if (trimmedData.includes('Spawning Claude Code process:') && trimmedData.includes('--system-prompt')) return;
        console.error(`🔴 SDK CLI stderr [${providerType}/${apiModelId}]:`, trimmedData);

        if (trimmedData.includes('No conversation found with session ID')) {
          resumeSessionNotFound = true;
        }

        const lowerData = trimmedData.toLowerCase();
        const isActualError = /error[:\s]|invalid api key|authentication|unauthorized|permission|forbidden|credit|insufficient|quota|billing|rate limit|failed|401|403|429/.test(lowerData);
        if (isActualError) {
          stderrOutput = (stderrOutput + '\n' + trimmedData).slice(-300);
        }
      },
    };

    if (providerType === 'anthropic') {
      let thinkingTokens = effortToThinkingTokens(effort);

      // Anthropic API enforces max_tokens <= 128000 on Claude 4.x models.
      // The SDK derives max_tokens = max(B+1, wz0(model)) for non-adaptive
      // (legacy) thinking. If B+1 > 128000 the API rejects the request and
      // the SDK silently falls back to non-streaming, which our response
      // loop renders as missing text/thinking blocks (only tool calls show).
      // Adaptive-thinking models (Opus 4.7+, Sonnet 5, Fable 5, Mythos) get
      // capped via the SDK patch in scripts/patch-sdk-reminders.mjs
      // (`opus-4-8-max-tokens-cap`).
      // Here we cap legacy/non-adaptive models so max_tokens stays under
      // the 128000 ceiling. Uses the same shared regex the SDK patch embeds
      // (shared/adaptiveThinkingModels.mjs) so the two can't drift.
      const isAdaptiveThinking = isAdaptiveThinkingModel(apiModelId);
      if (!isAdaptiveThinking && thinkingTokens > 127_000) {
        console.log(`⚠️  Capping maxThinkingTokens for ${apiModelId}: ${thinkingTokens} → 127000 (API ceiling)`);
        thinkingTokens = 127_000;
      }

      queryOptions.maxThinkingTokens = thinkingTokens;
      console.log(`🧠 Extended thinking enabled — effort=${effort ?? 'high(default)'}, maxThinkingTokens=${thinkingTokens}`);
    }

    // Merge MCP servers
    const connectedMcpServers = mcpClientManager.getMcpServersForSDK();
    const allMcpServers = { ...mcpServers, ...connectedMcpServers };

    // Bridge port-bound stdio MCPs through a singleton (eg rbxstudio-mcp
    // gets one shared HTTP-wrapped child for all chat sessions). Falls
    // back to exclusion if the port is held by something we don't own.
    // See PORT_BOUND_MCP_PACKAGES above for the why.
    await bridgeOrExcludePortBoundMcps(allMcpServers);

    if (Object.keys(allMcpServers).length > 0) {
      queryOptions.mcpServers = allMcpServers;
      const connectedIds = Object.keys(connectedMcpServers).filter(id => id in allMcpServers);
      if (connectedIds.length > 0) {
        console.log(`🔌 MCP: Including ${connectedIds.length} connected servers: ${connectedIds.join(', ')}`);
      }
    }

    // Diagnostic: dump the FINAL list of MCP servers being passed to the SDK
    // so we can debug "MCP not visible" issues. Strip env vars from output to
    // avoid leaking secrets.
    const mcpDiag = Object.entries(allMcpServers).map(([id, cfg]) => {
      const c = cfg as Record<string, unknown>;
      const safe: Record<string, unknown> = { type: c.type };
      if (c.type === 'http' || c.type === 'sse') safe.url = c.url;
      if (c.type === 'stdio') {
        safe.command = c.command;
        safe.args = c.args;
        if (c.env) safe.envKeys = Object.keys(c.env as Record<string, string>);
      }
      return `${id}=${JSON.stringify(safe)}`;
    });
    console.log(`🔌 MCP → SDK (${mcpDiag.length} servers): ${mcpDiag.join(' | ') || '(none)'}`);

    // PreToolUse hooks
    queryOptions.hooks = createPreToolUseHooks(sessionId, workingDir);

    // Self-heal a stale resume target: if the SDK CLI can't find the
    // conversation we asked it to resume, clear the dead sdk_session_id and
    // re-run this turn fresh (branch injection rebuilds full context from the
    // DB). Guarded to fire once so it can never loop. Only reachable on the
    // resume path, so `messageContent` here is still the untouched user
    // message (branch injection mutates it only when not resuming).
    const onLoopError = (): boolean => {
      if (!resumeSessionNotFound || recoveryAttempted) return false;
      recoveryAttempted = true;
      console.warn(
        `♻️ Resume target missing for ${sessionId.substring(0, 8)} ` +
        `(stale SDK session ${session.sdk_session_id}) — clearing and retrying fresh`,
      );
      sessionDb.updateSdkSessionId(sessionId, null);
      sessionStreamManager.cleanupSession(sessionId, 'resume_recovery');
      activeQueries.delete(sessionId);
      void spawnClaudeStream(
        ws, { ...session, sdk_session_id: undefined }, sessionId, workingDir,
        messageContent, apiModelId, providerType, timezone,
        mcpServers, activeQueries, effort,
      );
      return true;
    };

    // Retry loop
    const MAX_RETRIES = 3;
    const INITIAL_DELAY_MS = 2000;
    const BACKOFF_MULTIPLIER = 2;
    let attemptNumber = 0;

    while (attemptNumber < MAX_RETRIES) {
      attemptNumber++;

      try {
        if (attemptNumber > 1) console.log(`🔄 Retry attempt ${attemptNumber}/${MAX_RETRIES}`);

        const messageStream = sessionStreamManager.getOrCreateStream(sessionId);
        const abortController = sessionStreamManager.getAbortController(sessionId);
        if (!abortController) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session initialization error', sessionId }));
          return;
        }

        queryOptions.abortController = abortController;

        console.log(`🔄 [SDK] Spawning Claude SDK subprocess for session ${sessionId.substring(0, 8)}...`);
        const spawnStart = Date.now();
        const result = query({ prompt: messageStream, options: queryOptions });
        console.log(`✅ [SDK] Subprocess spawned in ${Date.now() - spawnStart}ms for session ${sessionId.substring(0, 8)}`);

        sessionStreamManager.registerQuery(sessionId, result);
        activeQueries.set(sessionId, result);
        sessionStreamManager.updateWebSocket(sessionId, ws);
        sessionStreamManager.sendMessage(sessionId, messageContent);

        // Switch to plan mode if needed
        if (session.permission_mode === 'plan') {
          try {
            console.log('🔄 Switching to plan mode');
            await result.setPermissionMode('plan');
          } catch (error) {
            console.error('❌ Failed to set plan mode:', error);
          }
        }

        // Start background response loop (non-blocking)
        startResponseLoop(sessionId, apiModelId, result, activeQueries, onLoopError);

        break; // Exit retry loop on success
      } catch (error) {
        console.error(`❌ Query attempt ${attemptNumber}/${MAX_RETRIES} failed:`, error);
        sessionStreamManager.cleanupSession(sessionId, 'retry_cleanup');
        activeQueries.delete(sessionId);

        const parsedError = parseApiError(error, stderrOutput);

        if (!parsedError.isRetryable || attemptNumber >= MAX_RETRIES) {
          ws.send(JSON.stringify({
            type: 'error',
            errorType: parsedError.type,
            message: getUserFriendlyMessage(parsedError),
            requestId: parsedError.requestId,
            sessionId,
          }));
          break;
        }

        let delayMs = INITIAL_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attemptNumber - 1);
        if (parsedError.type === 'rate_limit_error' && parsedError.retryAfterSeconds) {
          delayMs = parsedError.retryAfterSeconds * 1000;
        }
        delayMs = Math.min(delayMs, 16000);

        ws.send(JSON.stringify({
          type: 'retry_attempt',
          attempt: attemptNumber, maxAttempts: MAX_RETRIES,
          delayMs, errorType: parsedError.type,
          message: `Retrying... (attempt ${attemptNumber}/${MAX_RETRIES})`,
          sessionId,
        }));

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  } catch (error) {
    console.error('WebSocket handler error:', error);
    const parsedError = parseApiError(error);
    ws.send(JSON.stringify({
      type: 'error',
      errorType: parsedError.type,
      message: getUserFriendlyMessage(parsedError),
      sessionId,
    }));
  }
}
