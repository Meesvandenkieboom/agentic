/**
 * WebSocket Message Handlers
 * Handles all WebSocket message types for the chat interface
 */

import type { ServerWebSocket } from "bun";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookInput, SDKCompactBoundaryMessage } from "@anthropic-ai/claude-agent-sdk";
import { sessionDb } from "../database";
import { getSystemPrompt, injectWorkingDirIntoAgents } from "../systemPrompt";
import { AVAILABLE_MODELS } from "../../client/config/models";
import { configureProvider } from "../providers";
import { getMcpServers } from "../mcpServers";
import { mcpClientManager } from "../mcpClientManager";
import { AGENT_REGISTRY } from "../agents";
import { validateDirectory, getSessionPathsFromWorkingDir } from "../directoryUtils";
import { saveImageToSessionPictures, saveFileToSessionFiles } from "../imageUtils";
import { backgroundProcessManager } from "../backgroundProcessManager";
import { loadUserConfig } from "../userConfig";
import { parseApiError, getUserFriendlyMessage } from "../utils/apiErrors";
import { sessionStreamManager, type ContentBlock, type MessageContent } from "../sessionStreamManager";
import { expandSlashCommand } from "../slashCommandExpander";
import { cleanupOrphanedMcpProcesses } from "../mcpCleanup";
import { generateChatTitle } from "../utils/chatTitles";

interface ChatWebSocketData {
  type: 'hot-reload' | 'chat';
  sessionId?: string;
}

// --- AskUserQuestion support ---
// Blocks SDK execution until user answers via WebSocket
interface PendingQuestion {
  resolve: (answer: string) => void;
  toolId: string;
}
const pendingQuestions = new Map<string, PendingQuestion>();

/**
 * Format conversation history from a branched session for context injection.
 * When a branch is created, messages are copied to the DB but the SDK has no
 * transcript to resume from. This formats prior messages so Claude knows the
 * full conversation context.
 */
function formatBranchHistory(messages: Array<{ type: string; content: string; timestamp: string }>): string {
  // Budget: cap at ~100k chars (~25k tokens) to leave room in context window
  const MAX_HISTORY_CHARS = 100_000;
  const MAX_MESSAGE_CHARS = 3_000;
  let totalChars = 0;

  // Work backwards to prioritize recent messages
  const formattedParts: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.type === 'user' ? 'Human' : 'Assistant';
    let content = msg.content;

    // For assistant messages, extract text from JSON content blocks
    if (msg.type === 'assistant') {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          const textParts = parsed
            .filter((block: Record<string, unknown>) => block.type === 'text')
            .map((block: Record<string, unknown>) => block.text as string);

          const toolUses = parsed.filter((block: Record<string, unknown>) => block.type === 'tool_use');

          content = textParts.join('\n');
          if (toolUses.length > 0) {
            const toolNames = toolUses.map((t: Record<string, unknown>) => t.name as string).join(', ');
            content += `\n[Used ${toolUses.length} tool(s): ${toolNames}]`;
          }
        }
      } catch {
        // Plain text content, use as-is
      }
    }

    // Truncate very long individual messages
    if (content.length > MAX_MESSAGE_CHARS) {
      content = content.slice(0, MAX_MESSAGE_CHARS) + '\n... [message truncated]';
    }

    const part = `${role}:\n${content}`;

    // Check budget
    if (totalChars + part.length > MAX_HISTORY_CHARS) {
      formattedParts.push('[... earlier messages omitted for brevity ...]');
      break;
    }

    formattedParts.unshift(part); // prepend to maintain chronological order
    totalChars += part.length;
  }

  return [
    '=== CONVERSATION HISTORY (branched from parent chat) ===',
    '',
    ...formattedParts,
    '',
    '=== END OF CONVERSATION HISTORY ===',
    '',
    'The user branched from the conversation above to explore a different direction. Continue naturally from this context. Your new message from the user follows:',
  ].join('\n');
}

/**
 * Type guard to check if a message is a compact boundary message
 */
function isCompactBoundaryMessage(message: unknown): message is SDKCompactBoundaryMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'system' &&
    'subtype' in message &&
    message.subtype === 'compact_boundary'
  );
}

// Build model mapping from configuration
const MODEL_MAP: Record<string, { apiModelId: string; provider: string }> = {};
AVAILABLE_MODELS.forEach(model => {
  MODEL_MAP[model.id] = {
    apiModelId: model.apiModelId,
    provider: model.provider,
  };
});

export async function handleWebSocketMessage(
  ws: ServerWebSocket<ChatWebSocketData>,
  message: string,
  activeQueries: Map<string, unknown>
): Promise<void> {
  if (ws.data?.type === 'hot-reload') return;

  try {
    const data = JSON.parse(message);

    if (data.type === 'chat') {
      await handleChatMessage(ws, data, activeQueries);
    } else if (data.type === 'approve_plan') {
      await handleApprovePlan(ws, data, activeQueries);
    } else if (data.type === 'set_permission_mode') {
      await handleSetPermissionMode(ws, data, activeQueries);
    } else if (data.type === 'answer_question') {
      handleAnswerQuestion(data);
    } else if (data.type === 'kill_background_process') {
      await handleKillBackgroundProcess(ws, data);
    } else if (data.type === 'stop_generation') {
      await handleStopGeneration(ws, data);
    } else if (data.type === 'reconnect') {
      // Client reconnected after sleep/refresh — re-associate WebSocket and cancel grace period
      const { sessionId } = data;
      if (sessionId && typeof sessionId === 'string') {
        // Validate session still exists
        const session = sessionDb.getSession(sessionId);
        if (!session) {
          console.warn(`⚠️ Reconnect for non-existent session: ${sessionId.substring(0, 8)}`);
          ws.send(JSON.stringify({
            type: 'reconnect_ack',
            sessionId,
            isGenerating: false,
          }));
          return;
        }

        ws.data = { type: 'chat', sessionId };
        sessionStreamManager.updateWebSocket(sessionId, ws);
        const generating = sessionStreamManager.isGenerating(sessionId);
        console.log(`🔄 Client reconnected for session ${sessionId.substring(0, 8)} (${generating ? '⚡ generating' : '💤 idle'})`);
        ws.send(JSON.stringify({
          type: 'reconnect_ack',
          sessionId,
          isGenerating: generating,
        }));
      }
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

async function handleChatMessage(
  ws: ServerWebSocket<ChatWebSocketData>,
  data: Record<string, unknown>,
  activeQueries: Map<string, unknown>
): Promise<void> {
  const { content, sessionId, model, timezone } = data;

  if (!content || !sessionId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing content or sessionId', sessionId }));
    return;
  }

  // Get session for working directory access
  const session = sessionDb.getSession(sessionId as string);
  if (!session) {
    console.error('❌ Session not found:', sessionId);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Session not found',
      sessionId
    }));
    return;
  }

  const workingDir = session.working_directory;

  // Process attachments (images and files)
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const imageBlocks: ContentBlock[] = []; // Keep image blocks for Claude

  // Check if content is an array (contains blocks like text/image/file)
  const contentIsArray = Array.isArray(content);
  if (contentIsArray) {
    const contentBlocks = content as Array<Record<string, unknown>>;

    // Extract and save images and files
    for (const block of contentBlocks) {
      // Handle images
      if (block.type === 'image' && typeof block.source === 'object') {
        const source = block.source as Record<string, unknown>;
        if (source.type === 'base64' && typeof source.data === 'string') {
          // Save image to pictures folder (for persistence/reference)
          const base64Data = `data:${source.media_type || 'image/png'};base64,${source.data}`;
          const imagePath = saveImageToSessionPictures(base64Data, sessionId as string, workingDir);
          imagePaths.push(imagePath);

          // ALSO keep the image block for sending to Claude (multimodal support)
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

      // Handle document files
      if (block.type === 'document' && typeof block.data === 'string' && typeof block.name === 'string') {
        const filePath = saveFileToSessionFiles(block.data as string, block.name as string, sessionId as string, workingDir);
        filePaths.push(filePath);
      }
    }
  }

  // Log attachments if any were saved
  if (imagePaths.length > 0 || filePaths.length > 0) {
    console.log(`📎 Attachments: ${imagePaths.length} image(s), ${filePaths.length} file(s)`);
  }

  // Extract text content for prompt
  let promptText = typeof content === 'string' ? content : '';
  if (Array.isArray(content)) {
    // Extract text blocks from content array
    const textBlocks = (content as Array<Record<string, unknown>>)
      .filter(b => b.type === 'text')
      .map(b => b.text as string);
    promptText = textBlocks.join('\n');
  }

  // Check for special built-in commands that need server-side handling
  const trimmedPrompt = promptText.trim();

  // Handle /compact command - show loading state while compacting
  if (trimmedPrompt === '/compact') {
    console.log('🗜️ /compact command detected - sending loading message');

    // Send loading message to client
    ws.send(JSON.stringify({
      type: 'compact_loading',
      sessionId: sessionId,
    }));
    // Continue to SDK - it will handle the actual compaction
  }

  // Handle /clear command - clear AI context but keep visual chat history
  if (trimmedPrompt === '/clear') {
    console.log('🧹 /clear command detected - clearing AI context (keeping visual history)');

    // Add system message to mark context boundary in chat history
    sessionDb.addMessage(sessionId as string, 'user', '/clear');
    sessionDb.addMessage(
      sessionId as string,
      'assistant',
      JSON.stringify([{
        type: 'text',
        text: '--- Context cleared. The AI will not remember previous messages ---'
      }])
    );

    // Clear SDK session ID to force fresh start (no resume from transcript)
    sessionDb.updateSdkSessionId(sessionId as string, null);

    // Abort current SDK subprocess if exists
    const wasAborted = sessionStreamManager.abortSession(sessionId as string);
    if (wasAborted) {
      console.log('🛑 Aborted existing SDK subprocess for clean start');
      sessionStreamManager.cleanupSession(sessionId as string, 'clear_command');
    }

    // Send context cleared message as assistant_message so client can render it
    ws.send(JSON.stringify({
      type: 'assistant_message',
      content: '--- Context cleared. The AI will not remember previous messages ---',
      sessionId: sessionId,
    }));

    ws.send(JSON.stringify({
      type: 'result',
      success: true,
      sessionId: sessionId,
    }));

    return; // Don't send to SDK
  }

  // Save user message to database (stringify if array)
  const contentForDb = typeof content === 'string' ? content : JSON.stringify(content);
  sessionDb.addMessage(sessionId as string, 'user', contentForDb);

  // Expand slash commands if detected
  if (trimmedPrompt.startsWith('/')) {
    const expandedPrompt = expandSlashCommand(trimmedPrompt, workingDir);
    if (expandedPrompt) {
      promptText = expandedPrompt;
    } else {
      console.warn(`⚠️  Slash command not found: ${promptText}`);
    }
  }

  // Build multimodal content for Claude (images + text)
  // Files still use text path injection since Claude can read them via Read tool
  let messageContent: MessageContent = promptText;

  if (imageBlocks.length > 0 || filePaths.length > 0) {
    const contentParts: ContentBlock[] = [];

    // Add images first (Claude sees them before the text)
    contentParts.push(...imageBlocks);

    // Add file path references as text (Claude reads these with Read tool)
    if (filePaths.length > 0) {
      const fileRefs = filePaths.map(p => `[File attached: ${p}]`).join('\n');
      promptText = fileRefs + '\n\n' + promptText;
    }

    // Add the text content
    if (promptText.trim()) {
      contentParts.push({ type: 'text', text: promptText });
    }

    messageContent = contentParts;
    console.log(`📷 Built multimodal message: ${imageBlocks.length} image(s), ${contentParts.filter(b => b.type === 'text').length} text block(s)`);
  }

  // Check if this is a new session or continuing existing
  const isNewStream = !sessionStreamManager.hasStream(sessionId as string);

  // Get model configuration
  const modelConfig = MODEL_MAP[model as string] || MODEL_MAP['sonnet'];
  const { apiModelId, provider } = modelConfig;

  // Configure provider (sets ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY env vars)
  const providerType = provider as 'anthropic' | 'codex';

  // Validate API key before proceeding (OAuth takes precedence over API key)
  try {
    await configureProvider(providerType);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Provider configuration error:', errorMessage);
    ws.send(JSON.stringify({
      type: 'error',
      message: errorMessage,
      sessionId
    }));
    return;
  }

  // Auto-generate title after provider auth is configured (runs in parallel with response)
  if (session.title === 'New Chat') {
    const userText = typeof content === 'string' ? content : promptText;
    generateChatTitle(userText).then(title => {
      sessionDb.renameSession(sessionId as string, title);
      sessionStreamManager.safeSend(sessionId as string, JSON.stringify({
        type: 'session_title_updated',
        sessionId,
        title,
      }));
    }).catch(err => {
      console.warn('Title generation failed:', err);
    });
  }

  // Get MCP servers for this provider
  const mcpServers = await getMcpServers(providerType, apiModelId);

  // Minimal request logging - one line summary
  // Note: At this point we haven't checked history yet, so we use isNewStream for subprocess status
  console.log(`📨 [${apiModelId} @ ${provider}] Session: ${sessionId?.toString().substring(0, 8)} (${session.mode} mode) ${isNewStream ? '🆕 NEW SUBPROCESS' : '♻️ CONTINUE SUBPROCESS'}`);

  // Validate working directory (only log on failure)
  const validation = validateDirectory(workingDir);
  if (!validation.valid) {
    console.error('❌ Working directory invalid:', validation.error);
    ws.send(JSON.stringify({
      type: 'error',
      message: `Working directory error: ${validation.error}`,
      sessionId
    }));
    return;
  }

  // Warn if on WSL with Windows filesystem (10-20x performance penalty)
  if (process.platform === 'linux' && workingDir.startsWith('/mnt/')) {
    console.warn('⚠️  WARNING: Working directory is on Windows filesystem (WSL)');
    console.warn(`   Path: ${workingDir}`);
    console.warn('   This causes 10-20x slower file I/O operations');
    console.warn('   Move project to Linux filesystem (~/projects/) for better performance');
  }

  // For existing streams: Update WebSocket, enqueue message, and return
  // Background response loop is already running
  if (!isNewStream) {
    // Check if the stream is being aborted — if so, clean up and create fresh stream
    const abortCtrl = sessionStreamManager.getAbortController(sessionId as string);
    if (abortCtrl?.signal.aborted) {
      console.log(`🔄 Session ${(sessionId as string).substring(0, 8)} was aborted, cleaning up before new message`);
      sessionStreamManager.cleanupSession(sessionId as string, 'pre_send_cleanup');
      activeQueries.delete(sessionId as string);
      // Fall through to create a new stream below
    } else {
      sessionStreamManager.updateWebSocket(sessionId as string, ws);
      sessionStreamManager.sendMessage(sessionId as string, messageContent);
      return; // Background loop handles response
    }
  }

  // For NEW streams: Spawn SDK and start background response processing

  // === CODEX PROVIDER: Use separate Codex SDK (modular, isolated from Claude) ===
  if (providerType === 'codex') {
    try {
      const { runCodexStream, isCodexAvailable } = await import('../providers/codex');

      const codexAvailable = await isCodexAvailable();
      if (!codexAvailable) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Codex is not available. Please run "bun run login" and select Codex to authenticate, or install Codex CLI with "npm install -g @openai/codex".',
          sessionId
        }));
        return;
      }

      // Save user message is already done above
      const paths = getSessionPathsFromWorkingDir(workingDir);

      ws.send(JSON.stringify({ type: 'generation_started', sessionId }));

      await runCodexStream(promptText, paths.workspace, (event) => {
        if (event.type === 'assistant_message') {
          // Save incrementally
          sessionDb.addMessage(sessionId as string, 'assistant', JSON.stringify([{ type: 'text', text: event.content }]));
          ws.send(JSON.stringify({ ...event, sessionId }));
        } else if (event.type === 'tool_use') {
          ws.send(JSON.stringify({ ...event, sessionId }));
        } else if (event.type === 'result') {
          ws.send(JSON.stringify({ ...event, sessionId }));
        } else if (event.type === 'error') {
          ws.send(JSON.stringify({ ...event, sessionId }));
        } else {
          ws.send(JSON.stringify({ ...event, sessionId }));
        }
      });

    } catch (error) {
      console.error('❌ Codex provider error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Codex provider error',
        sessionId
      }));
    }
    return; // Don't fall through to Claude SDK
  }

  // === CLAUDE PROVIDER: Use Claude Agent SDK (existing code below) ===
  try {

    // Phase 0: Clean up any orphaned MCP processes before spawning new SDK
    // This prevents port conflicts (e.g., Roblox Studio MCP on port 3002)
    await cleanupOrphanedMcpProcesses();

    // Phase 0.1: Get workspace path for actual work (workingDir is session root)
    // Use stored working_directory to support renamed sessions
    const paths = getSessionPathsFromWorkingDir(workingDir);
    const workspaceDir = paths.workspace;

    // Load user configuration
    const userConfig = loadUserConfig();

    // Build query options with provider-specific system prompt (including agent list)
    // Add working directory context to system prompt AND all agent prompts
    // Pass GitHub repo info if connected (enables git workflow instructions)
    // NOTE: Pass workspaceDir (not workingDir) for git commands
    const baseSystemPrompt = getSystemPrompt(
      providerType,
      AGENT_REGISTRY,
      userConfig,
      timezone as string | undefined,
      session.mode,
      session.github_repo,  // GitHub repo (e.g., "owner/repo") if connected
      workspaceDir          // Workspace directory for git commands
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

    // Debug: Log system prompt size
    const promptWordCount = systemPromptWithContext.split(/\s+/).length;
    const estimatedTokens = Math.round(promptWordCount * 1.3);
    console.log(`📏 System prompt size: ${promptWordCount} words (~${estimatedTokens} tokens)`);

    // Debug: Write full system prompt to temp file for inspection
    const fs = await import('fs');
    const debugPath = `/tmp/system-prompt-${session.mode || 'general'}-debug.txt`;
    fs.writeFileSync(debugPath, systemPromptWithContext);
    console.log(`📝 Full system prompt written to: ${debugPath}`);

    // Inject working directory context into all custom agent prompts (use workspace)
    const agentsWithWorkingDir = injectWorkingDirIntoAgents(AGENT_REGISTRY, workspaceDir);

    // Capture stderr output for better error messages
    let stderrOutput = '';

    // Check if we have SDK session ID from previous subprocess
    const sessionMessages = sessionDb.getSessionMessages(sessionId as string);
    const isFirstMessage = sessionMessages.length === 1; // Only current message, no prior

    // Log resume decision
    if (!isFirstMessage && session.sdk_session_id) {
      console.log(`📋 Using resume with SDK session ID: ${session.sdk_session_id}`);
    } else if (!isFirstMessage) {
      console.log(`⚠️ No SDK session ID stored, cannot use resume`);
    }

    // Branch context injection: when a session has prior messages but no SDK
    // transcript to resume from (e.g., a branched session), inject the
    // conversation history into the first message so Claude has full context.
    const isBranchStart = !isFirstMessage && !session.sdk_session_id;
    if (isBranchStart) {
      const priorMessages = sessionMessages.slice(0, -1); // Exclude the message just added
      if (priorMessages.length > 0) {
        const historyContext = formatBranchHistory(priorMessages);
        if (typeof messageContent === 'string') {
          messageContent = historyContext + '\n\n' + messageContent;
        } else if (Array.isArray(messageContent)) {
          // Multimodal: prepend history as a text block
          messageContent = [
            { type: 'text' as const, text: historyContext },
            ...messageContent,
          ];
        }
        console.log(`🌿 Branch start: injected ${priorMessages.length} prior messages as context`);
      }
    }

    const queryOptions: Record<string, unknown> = {
      model: apiModelId,
      systemPrompt: systemPromptWithContext,
      permissionMode: 'bypassPermissions', // Always spawn with bypass - then switch if needed
      // Use SDK's internal session ID for resume (if available from previous subprocess)
      ...(isFirstMessage || !session.sdk_session_id ? {} : { resume: session.sdk_session_id }),
      includePartialMessages: true,
      agents: agentsWithWorkingDir, // Register custom agents with working dir context
      cwd: workspaceDir, // Set workspace as working directory for all tool executions
      settingSources: ['project'], // Load Skills from .claude/skills/ and agents from .claude/agents/
      // Let SDK manage its own subprocess spawning - don't override executable
      // abortController will be added after stream creation

      // Capture stderr from SDK's bundled CLI for debugging and error context
      stderr: (data: string) => {
        const trimmedData = data.trim();

        // Skip logging the massive system prompt dump from CLI spawn command
        if (trimmedData.includes('Spawning Claude Code process:') && trimmedData.includes('--system-prompt')) {
          return; // Skip this line entirely
        }

        console.error(`🔴 SDK CLI stderr [${provider}/${apiModelId}]:`, trimmedData);

        // Only capture lines that look like actual errors, not debug output or command echoes
        const lowerData = trimmedData.toLowerCase();
        const isActualError =
          lowerData.includes('error:') ||
          lowerData.includes('error ') ||
          lowerData.includes('invalid api key') ||
          lowerData.includes('authentication') ||
          lowerData.includes('unauthorized') ||
          lowerData.includes('permission') ||
          lowerData.includes('forbidden') ||
          lowerData.includes('credit') ||
          lowerData.includes('insufficient') ||
          lowerData.includes('quota') ||
          lowerData.includes('billing') ||
          lowerData.includes('rate limit') ||
          lowerData.includes('failed') ||
          lowerData.includes('401') ||
          lowerData.includes('403') ||
          lowerData.includes('429') ||
          (lowerData.includes('status') && (lowerData.includes('4') || lowerData.includes('5'))); // 4xx/5xx errors

        if (isActualError) {
          // Only keep actual error messages, limit to 300 chars
          stderrOutput = (stderrOutput + '\n' + trimmedData).slice(-300);
        }
      },
    };

    // Enable extended thinking for Anthropic models
    if (providerType === 'anthropic') {
      queryOptions.maxThinkingTokens = 80000;
      console.log('🧠 Extended thinking enabled with maxThinkingTokens:', queryOptions.maxThinkingTokens);
    } else {
      console.log('⚠️ Extended thinking not supported for provider:', providerType);
    }

    // SDK automatically uses its bundled CLI at @anthropic-ai/claude-agent-sdk/cli.js
    // No need to specify pathToClaudeCodeExecutable - the SDK handles this internally

    // Add MCP servers if provider has them
    // No need to set allowedTools - bypassPermissions gives access to all tools
    // MCP tools will be available through mcpServers, built-in tools through bypassPermissions

    // Get connected MCP servers from client manager (OAuth-based servers like Atlassian, Figma)
    const connectedMcpServers = mcpClientManager.getMcpServersForSDK();

    // Merge provider MCP servers with user-connected servers
    const allMcpServers = { ...mcpServers, ...connectedMcpServers };

    if (Object.keys(allMcpServers).length > 0) {
      queryOptions.mcpServers = allMcpServers;

      // Log connected MCP servers for debugging
      const connectedIds = Object.keys(connectedMcpServers);
      if (connectedIds.length > 0) {
        console.log(`🔌 MCP: Including ${connectedIds.length} connected servers: ${connectedIds.join(', ')}`);
      }
    }

    // Add PreToolUse hook to intercept background Bash commands and long-running commands
    queryOptions.hooks = {
      PreToolUse: [{
        hooks: [async (input: HookInput, toolUseID: string | undefined) => {
          // PreToolUse hook has tool_name and tool_input properties
          type PreToolUseInput = HookInput & { tool_name: string; tool_input: Record<string, unknown> };

          if (input.hook_event_name !== 'PreToolUse') return {};

          const { tool_name, tool_input } = input as PreToolUseInput;

          // Intercept AskUserQuestion — pause SDK until user answers
          if (tool_name === 'AskUserQuestion') {
            const toolId = toolUseID || `question-${Date.now()}`;

            // Notify client that a question needs answering
            sessionStreamManager.safeSend(
              sessionId as string,
              JSON.stringify({
                type: 'ask_user_question',
                toolId,
                questions: tool_input.questions || [],
                sessionId: sessionId,
              })
            );

            // Block SDK until user answers
            const answer = await new Promise<string>((resolve) => {
              pendingQuestions.set(sessionId as string, { resolve, toolId });
            });

            return {
              decision: 'approve' as const,
              updatedInput: { ...tool_input, answers: JSON.parse(answer) },
            };
          }

          if (tool_name !== 'Bash') return {};

          const bashInput = tool_input as Record<string, unknown>;
          const command = bashInput.command as string;
          const description = bashInput.description as string | undefined;
          const bashId = toolUseID || `bg-${Date.now()}`;

          // Detect long-running commands (install, build, test)
          const isInstallCommand = /\b(npm|bun|yarn|pnpm)\s+(install|i|add)\b/i.test(command);
          const isBuildCommand = /\b(npm|bun|yarn|pnpm)\s+(run\s+)?(build|compile)\b/i.test(command);
          const isTestCommand = /\b(npm|bun|yarn|pnpm)\s+(run\s+)?test\b/i.test(command);
          const isLongRunningCommand = isInstallCommand || isBuildCommand || isTestCommand;

          // Handle long-running commands with monitored background execution
          if (isLongRunningCommand && bashInput.run_in_background !== true) {
            const commandType = isInstallCommand ? 'install' : isBuildCommand ? 'build' : 'test';

            // Spawn background process
            const { pid } = await backgroundProcessManager.spawn(command, workingDir, bashId, sessionId as string, description);

            console.log(`📦 Running ${commandType} (PID ${pid}): ${command.slice(0, 50)}${command.length > 50 ? '...' : ''}`);

            // Save long-running command to database immediately
            const longRunningCommandBlock = {
              type: 'long_running_command',
              bashId,
              command,
              commandType,
              output: '',
              status: 'running',
            };
            const dbMessage = sessionDb.addMessage(
              sessionId as string,
              'assistant',
              JSON.stringify([longRunningCommandBlock])
            );

            // Notify client that long-running command started
            // Use safeSend (looks up current WS) instead of captured ws ref
            // which can go stale after reconnection
            sessionStreamManager.safeSend(sessionId as string, JSON.stringify({
              type: 'long_running_command_started',
              bashId,
              command,
              commandType,
              description,
              startedAt: Date.now(),
              sessionId,
            }));

            let accumulatedOutput = '';

            try {
              // Wait for completion with output streaming
              const result = await backgroundProcessManager.waitForCompletion(bashId, {
                onOutput: (chunk) => {
                  // Accumulate output
                  accumulatedOutput += chunk;

                  // Update database with accumulated output
                  sessionDb.updateMessage(
                    dbMessage.id,
                    JSON.stringify([{
                      ...longRunningCommandBlock,
                      output: accumulatedOutput,
                    }])
                  );

                  // Stream output to client (safeSend survives reconnection)
                  sessionStreamManager.safeSend(sessionId as string, JSON.stringify({
                    type: 'command_output_chunk',
                    bashId,
                    output: chunk,
                    sessionId,
                  }));
                },
              });

              // Log and notify completion
              console.log(`✅ Command completed (exit ${result.exitCode}): ${command.slice(0, 50)}${command.length > 50 ? '...' : ''}`);

              // Update database with final status
              sessionDb.updateMessage(
                dbMessage.id,
                JSON.stringify([{
                  ...longRunningCommandBlock,
                  output: accumulatedOutput || result.output,
                  status: 'completed',
                }])
              );

              sessionStreamManager.safeSend(sessionId as string, JSON.stringify({
                type: 'long_running_command_completed',
                bashId,
                exitCode: result.exitCode,
                sessionId,
              }));


              // Return the actual output to Claude
              return {
                decision: 'approve' as const,
                updatedInput: {
                  command: `cat <<'EOF'\n${result.output}\nEOF`,
                  description,
                },
              };
            } catch (error) {
              console.error(`❌ Long-running command failed:`, error);

              // Update database with error status
              sessionDb.updateMessage(
                dbMessage.id,
                JSON.stringify([{
                  ...longRunningCommandBlock,
                  output: accumulatedOutput || (error instanceof Error ? error.message : String(error)),
                  status: 'failed',
                }])
              );

              // Notify error (safeSend survives reconnection)
              sessionStreamManager.safeSend(sessionId as string, JSON.stringify({
                type: 'long_running_command_failed',
                bashId,
                error: error instanceof Error ? error.message : String(error),
                sessionId,
              }));

              // Return error to Claude
              return {
                decision: 'approve' as const,
                updatedInput: {
                  command: `echo "Error: ${error instanceof Error ? error.message : String(error)}" >&2 && exit 1`,
                  description,
                },
              };
            }
          }

          // Handle regular background commands (e.g., dev servers)
          if (bashInput.run_in_background === true) {

            // Check if this specific command is already running for this session
            const existingProcess = backgroundProcessManager.findExistingProcess(sessionId as string, command);

            if (existingProcess) {
              // Check if the process is actually still alive
              try {
                // kill -0 doesn't kill the process, just checks if it exists
                process.kill(existingProcess.pid, 0);
                // Process is alive, block duplicate
                return {
                  decision: 'approve' as const,
                  updatedInput: {
                    command: `echo "✓ Command already running in background (PID ${existingProcess.pid}, started at ${new Date(existingProcess.startedAt).toLocaleTimeString()})"`,
                    description,
                  },
                };
              } catch {
                // Process is dead, remove from registry and allow respawn
                backgroundProcessManager.delete(existingProcess.bashId);
              }
            }

            // Spawn the process ourselves
            const { pid } = await backgroundProcessManager.spawn(command, workingDir, bashId, sessionId as string, description);

            console.log(`🚀 Background process spawned (PID ${pid}): ${command.slice(0, 50)}${command.length > 50 ? '...' : ''}`);

            // Notify the client (safeSend survives reconnection)
            sessionStreamManager.safeSend(sessionId as string, JSON.stringify({
              type: 'background_process_started',
              bashId,
              command,
              description,
              startedAt: Date.now(),
              sessionId,
            }));

            // Replace the command with an echo so the SDK gets a successful result
            // This prevents the agent from retrying
            return {
              decision: 'approve' as const,
              updatedInput: {
                command: `echo "✓ Background server started (PID ${pid})"`,
                description,
              },
            };
          }

          // Not a special command, let it pass through
          return {};
        }],
      }],
    };

    // Retry configuration
    const MAX_RETRIES = 3;
    const INITIAL_DELAY_MS = 2000;
    const BACKOFF_MULTIPLIER = 2;

    let attemptNumber = 0;
    let _lastError: unknown = null;

    // Retry loop
    while (attemptNumber < MAX_RETRIES) {
      attemptNumber++;

      try {
        // Only log retries (not first attempt)
        if (attemptNumber > 1) {
          console.log(`🔄 Retry attempt ${attemptNumber}/${MAX_RETRIES}`);
        }

        // Create AsyncIterable stream for this session (this creates the AbortController)
        const messageStream = sessionStreamManager.getOrCreateStream(sessionId as string);

        // Get AbortController from session stream manager (NOW it exists)
        const abortController = sessionStreamManager.getAbortController(sessionId as string);
        if (!abortController) {
          console.error('❌ No AbortController found for session:', sessionId);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Session initialization error',
            sessionId
          }));
          return;
        }

        // Add AbortController to query options
        queryOptions.abortController = abortController;

        // Spawn SDK with AsyncIterable stream (resume option loads history from transcript files)
        console.log(`🔄 [SDK] Spawning Claude SDK subprocess for session ${sessionId.toString().substring(0, 8)}...`);
        const spawnStart = Date.now();
        const result = query({
          prompt: messageStream,
          options: queryOptions
        });
        const spawnTime = Date.now() - spawnStart;
        console.log(`✅ [SDK] Subprocess spawned in ${spawnTime}ms for session ${sessionId.toString().substring(0, 8)}`);

        // Register query and store for mid-stream control
        sessionStreamManager.registerQuery(sessionId as string, result);
        activeQueries.set(sessionId as string, result);

        // Set active WebSocket for this session
        sessionStreamManager.updateWebSocket(sessionId as string, ws);

        // Enqueue current message (SDK loads history via resume option)
        sessionStreamManager.sendMessage(sessionId as string, messageContent);

        // If session is in plan mode, immediately switch after spawn
        // (SDK always spawns with bypassPermissions to allow bidirectional mode switching)
        if (session.permission_mode === 'plan') {
          try {
            console.log('🔄 Switching to plan mode');
            await result.setPermissionMode('plan');
          } catch (error) {
            console.error('❌ Failed to set permission mode to plan:', error);
            // Continue with bypassPermissions as fallback
            console.warn('⚠️  Continuing with bypassPermissions mode');
          }
        }

        // Note: We don't fetch commands from SDK here because supportedCommands()
        // only returns built-in SDK commands, not custom .md files from .claude/commands/
        // Custom commands are loaded via REST API when session is switched

        // Start background response processing loop (non-blocking)
        // This loop runs continuously, processing responses for ALL messages in the session
        (async () => {
          // Per-turn state (resets after each completion)
          let currentMessageContent: unknown[] = [];
          let currentTextResponse = '';
          let totalCharCount = 0;

          // Load previous cumulative output tokens from DB so counter continues across requests
          const sessionData = sessionDb.getSession(sessionId as string);
          const baseOutputTokens = sessionData?.output_tokens || 0;
          let currentMessageId: string | null = null; // Track DB message ID for incremental saves
          let exitPlanModeSentThisTurn = false; // Prevent duplicate plan modals
          let toolUseCount = 0; // Track number of tools executed (for hang detection logging)

          // Track session start time for heartbeat elapsed reporting
          const sessionStartTime = Date.now();

          // Heartbeat every 30 seconds to prevent WebSocket idle timeout
          const heartbeatInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);

            // Send keepalive through WebSocket to prevent Bun's idleTimeout from closing the connection
            sessionStreamManager.safeSend(
              sessionId as string,
              JSON.stringify({
                type: 'keepalive',
                elapsedSeconds: elapsed,
                sessionId: sessionId,
              })
            );
          }, 30000);

          try {
            // Stream the response - query() is an AsyncGenerator
            // Loop runs indefinitely, processing message after message
            for await (const message of result) {

              // Capture SDK's internal session ID from first system message
              if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
                const sdkSessionId = (message as { session_id?: string }).session_id;
                if (sdkSessionId && sdkSessionId !== sessionId) {
                  sessionDb.updateSdkSessionId(sessionId as string, sdkSessionId);
                }
                continue; // Skip further processing for system messages
              }

              // Detect compact boundary - conversation was compacted
              if (isCompactBoundaryMessage(message)) {
                const trigger = message.compact_metadata.trigger;
                const preTokens = message.compact_metadata.pre_tokens;

                if (trigger === 'auto') {
                  console.log(`🗜️ Auto-compact: ${preTokens.toLocaleString()} tokens → summarized`);

                  // Save divider message to database for auto-compact persistence
                  sessionDb.addMessage(
                    sessionId as string,
                    'assistant',
                    JSON.stringify([{
                      type: 'text',
                      text: `--- Auto-compact: Context reached limit (${preTokens.toLocaleString()} tokens). History was automatically summarized ---`
                    }])
                  );

                  // For auto-compact: send notification that compaction is starting (no divider)
                  // Claude will continue responding after compaction completes
                  sessionStreamManager.safeSend(
                    sessionId as string,
                    JSON.stringify({
                      type: 'compact_start',
                      trigger: 'auto',
                      preTokens: preTokens,
                      sessionId: sessionId,
                    })
                  );
                } else {
                  console.log(`🗜️ Manual compact: ${preTokens.toLocaleString()} tokens → summarized`);

                  // Save divider message to database for persistence
                  sessionDb.addMessage(
                    sessionId as string,
                    'assistant',
                    JSON.stringify([{
                      type: 'text',
                      text: `--- History compacted. Previous messages were summarized to reduce token usage (${preTokens.toLocaleString()} tokens before compact) ---`
                    }])
                  );

                  // For manual compact: send completion message to replace loading state
                  sessionStreamManager.safeSend(
                    sessionId as string,
                    JSON.stringify({
                      type: 'compact_complete',
                      preTokens: preTokens,
                      sessionId: sessionId,
                    })
                  );
                }

                continue; // Skip further processing for system messages
              }

              // Handle turn completion
              if (message.type === 'result') {
                console.log(`✅ Turn completed: ${message.subtype}`);

                // Final save (if no content was saved incrementally)
                if (!currentMessageId) {
                  if (currentMessageContent.length > 0) {
                    sessionDb.addMessage(sessionId as string, 'assistant', JSON.stringify(currentMessageContent));
                  } else if (currentTextResponse) {
                    sessionDb.addMessage(sessionId as string, 'assistant', JSON.stringify([{ type: 'text', text: currentTextResponse }]));
                  }
                }

                // Extract usage data from result message
                const resultMessage = message as {
                  usage?: {
                    input_tokens?: number;
                    output_tokens?: number;
                    cache_creation_input_tokens?: number;
                    cache_read_input_tokens?: number;
                  };
                  modelUsage?: Record<string, {
                    inputTokens: number;
                    outputTokens: number;
                    contextWindow: number;
                  }>;
                };

                // Send context usage to client if available
                if (resultMessage.modelUsage) {
                  // Get usage for the current model (not first alphabetically!)
                  // For Moonshot: Falls back to first entry if exact model not found (Moonshot returns wrong model ID)
                  // Note: Moonshot API currently returns inputTokens: 0 for all requests (API limitation)
                  let usage = resultMessage.modelUsage[apiModelId] as {
                    inputTokens: number;
                    outputTokens: number;
                    contextWindow: number;
                    cacheReadInputTokens?: number;
                    cacheCreationInputTokens?: number;
                  };

                  // Fallback: If model ID doesn't match, use first available model usage
                  if (!usage && Object.keys(resultMessage.modelUsage).length > 0) {
                    const firstModelId = Object.keys(resultMessage.modelUsage)[0];
                    usage = resultMessage.modelUsage[firstModelId] as typeof usage;
                  }

                  if (usage) {
                    // Total context = uncached tokens + cached tokens (read + created)
                    // inputTokens alone only shows the uncached portion after the last cache breakpoint
                    const totalInputTokens = (usage.inputTokens || 0)
                      + (usage.cacheReadInputTokens || 0)
                      + (usage.cacheCreationInputTokens || 0);

                    const contextPercentage = Number(((totalInputTokens / usage.contextWindow) * 100).toFixed(1));

                    console.log(`📊 Context usage: ${totalInputTokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens (${contextPercentage}%) [input: ${usage.inputTokens}, cache_read: ${usage.cacheReadInputTokens || 0}, cache_creation: ${usage.cacheCreationInputTokens || 0}]`);

                    // Save cumulative output tokens to database
                    const cumulativeOutput = baseOutputTokens + (usage.outputTokens || 0);
                    sessionDb.updateContextUsage(
                      sessionId as string,
                      totalInputTokens,
                      usage.contextWindow,
                      contextPercentage,
                      cumulativeOutput
                    );

                    sessionStreamManager.safeSend(
                      sessionId as string,
                      JSON.stringify({
                        type: 'context_usage',
                        inputTokens: totalInputTokens,
                        outputTokens: cumulativeOutput,
                        contextWindow: usage.contextWindow,
                        contextPercentage: contextPercentage,
                        sessionId: sessionId,
                      })
                    );
                  } else {
                    console.warn(`⚠️  Result message has modelUsage but no model entries`);
                  }
                } else if (resultMessage.usage?.input_tokens) {
                  // Fallback: Use basic usage field when modelUsage is missing
                  // This happens for tool-only turns, permission requests, etc.
                  const inputTokens = resultMessage.usage.input_tokens;
                  const outputTokens = resultMessage.usage.output_tokens || 0;
                  const DEFAULT_CONTEXT_WINDOW = 200000; // Standard for most models
                  const contextPercentage = Number(((inputTokens / DEFAULT_CONTEXT_WINDOW) * 100).toFixed(1));
                  const cumulativeOutput = baseOutputTokens + outputTokens;

                  console.log(`📊 Context usage (estimated): ${inputTokens.toLocaleString()}/${DEFAULT_CONTEXT_WINDOW.toLocaleString()} tokens (${contextPercentage}%)`);

                  // Save cumulative output tokens to database
                  sessionDb.updateContextUsage(
                    sessionId as string,
                    inputTokens,
                    DEFAULT_CONTEXT_WINDOW,
                    contextPercentage,
                    cumulativeOutput
                  );

                  sessionStreamManager.safeSend(
                    sessionId as string,
                    JSON.stringify({
                      type: 'context_usage',
                      inputTokens: inputTokens,
                      outputTokens: cumulativeOutput,
                      contextWindow: DEFAULT_CONTEXT_WINDOW,
                      contextPercentage: contextPercentage,
                      sessionId: sessionId,
                    })
                  );
                } else {
                  // Fallback: Estimate context usage from stored messages when SDK provides no usage data
                  // This ensures the context indicator ALWAYS updates after every response
                  const storedMessages = sessionDb.getSessionMessages(sessionId as string);
                  let totalChars = 0;
                  for (const msg of storedMessages) {
                    totalChars += msg.content.length;
                  }
                  const estimatedInputTokens = Math.floor(totalChars / 4);
                  const estimatedCurrentOutput = Math.floor(totalCharCount / 4);
                  const cumulativeOutput = baseOutputTokens + estimatedCurrentOutput;
                  const DEFAULT_CONTEXT_WINDOW = 200000;
                  const contextPercentage = Number(((estimatedInputTokens / DEFAULT_CONTEXT_WINDOW) * 100).toFixed(1));

                  console.log(`📊 Context usage (estimated from messages): ${estimatedInputTokens.toLocaleString()}/${DEFAULT_CONTEXT_WINDOW.toLocaleString()} tokens (${contextPercentage}%)`);

                  sessionDb.updateContextUsage(
                    sessionId as string,
                    estimatedInputTokens,
                    DEFAULT_CONTEXT_WINDOW,
                    contextPercentage,
                    cumulativeOutput
                  );

                  sessionStreamManager.safeSend(
                    sessionId as string,
                    JSON.stringify({
                      type: 'context_usage',
                      inputTokens: estimatedInputTokens,
                      outputTokens: cumulativeOutput,
                      contextWindow: DEFAULT_CONTEXT_WINDOW,
                      contextPercentage: contextPercentage,
                      sessionId: sessionId,
                    })
                  );
                }

                // Mark session as idle (turn complete, waiting for next user message)
                sessionStreamManager.setIdle(sessionId as string);

                // Send completion signal (safe send checks WebSocket readyState)
                sessionStreamManager.safeSend(
                  sessionId as string,
                  JSON.stringify({ type: 'result', success: true, sessionId: sessionId })
                );

                // Reset state for next turn (keep totalCharCount to accumulate across turns)
                currentMessageContent = [];
                currentTextResponse = '';
                currentMessageId = null; // Reset message ID for next turn
                exitPlanModeSentThisTurn = false; // Reset plan mode flag for next turn
                toolUseCount = 0; // Reset tool counter for next turn

                // Continue loop - wait for next message from stream
                continue;
              }

              if (message.type === 'stream_event') {
        const event = message.event;

        if (event.type === 'content_block_start') {
          // Send thinking block start notification to client
          if (event.content_block?.type === 'thinking') {
            sessionStreamManager.safeSend(
              sessionId as string,
              JSON.stringify({
                type: 'thinking_start',
                sessionId: sessionId,
              })
            );
          }
        } else if (event.type === 'content_block_delta') {
          // Count all delta types: text_delta, input_json_delta, thinking_delta
          let deltaChars = 0;

          if (event.delta?.type === 'text_delta') {
            const text = event.delta.text;
            currentTextResponse += text;
            deltaChars = text.length;

            sessionStreamManager.safeSend(
              sessionId as string,
              JSON.stringify({
                type: 'assistant_message',
                content: text,
                sessionId: sessionId,
              })
            );

            // Incremental save for text (every 500 chars or on tool boundaries)
            if (currentTextResponse.length % 500 < text.length) {
              if (!currentMessageId) {
                // Create message on first text
                const msg = sessionDb.addMessage(
                  sessionId as string,
                  'assistant',
                  JSON.stringify([{ type: 'text', text: currentTextResponse }])
                );
                currentMessageId = msg.id;
              } else {
                // Update existing message with accumulated text
                const contentToSave = currentMessageContent.length > 0
                  ? currentMessageContent.concat([{ type: 'text', text: currentTextResponse }])
                  : [{ type: 'text', text: currentTextResponse }];
                sessionDb.updateMessage(currentMessageId, JSON.stringify(contentToSave));
              }
            }
          } else if (event.delta?.type === 'input_json_delta') {
            // Tool input being generated (like Write tool file content)
            const jsonDelta = event.delta.partial_json || '';
            deltaChars = jsonDelta.length;
          } else if (event.delta?.type === 'thinking_delta') {
            // Claude's internal reasoning/thinking
            const thinkingText = event.delta.thinking || '';
            deltaChars = thinkingText.length;

            sessionStreamManager.safeSend(
              sessionId as string,
              JSON.stringify({
                type: 'thinking_delta',
                content: thinkingText,
                sessionId: sessionId,
              })
            );
          } else if (event.delta?.type === 'signature_delta') {
            // Signature deltas (internal SDK/API metadata) - silently ignore
            deltaChars = 0;
          } else if (event.delta?.type) {
            // Only log truly unexpected delta types (not signature_delta)
            console.log('⚠️ Unknown delta type:', event.delta.type);
          }

          // Update total character count and estimate tokens (~4 chars/token)
          totalCharCount += deltaChars;

          // Memory safeguard: abort if output exceeds 50MB to prevent WSL/OOM crashes
          const MAX_OUTPUT_CHARS = 50_000_000;
          if (totalCharCount > MAX_OUTPUT_CHARS) {
            console.warn(`⚠️ Session ${(sessionId as string).substring(0, 8)} exceeded ${MAX_OUTPUT_CHARS / 1_000_000}MB output limit, aborting to prevent memory issues`);
            sessionStreamManager.abortSession(sessionId as string);
            continue;
          }

          const estimatedTokens = Math.floor(totalCharCount / 4);
          // Cumulative total = previous sessions' tokens + current request's estimated tokens
          const cumulativeTokens = baseOutputTokens + estimatedTokens;

          // Send cumulative token count update
          if (deltaChars > 0) {
            sessionStreamManager.safeSend(
              sessionId as string,
              JSON.stringify({
                type: 'token_update',
                outputTokens: cumulativeTokens,
                sessionId: sessionId,
              })
            );
          }
        }
              } else if (message.type === 'user') {
                // Tool result messages - these are responses from tool executions (including spawned agents)
                // These messages are tool results - SDK processes them internally
                continue; // Continue to next message
              } else if (message.type === 'assistant') {
                // Capture full message content structure for database storage
                const content = message.message.content;
                if (Array.isArray(content)) {
                  // Append blocks instead of replacing (SDK may send multiple assistant messages)
                  currentMessageContent.push(...content);

                  // Incremental save: Create or update message in database
                  if (!currentMessageId) {
                    // First content - create message
                    const msg = sessionDb.addMessage(
                      sessionId as string,
                      'assistant',
                      JSON.stringify(currentMessageContent)
                    );
                    currentMessageId = msg.id;
                  } else {
                    // Subsequent content - update existing message
                    sessionDb.updateMessage(currentMessageId, JSON.stringify(currentMessageContent));
                  }

          // Handle tool use from complete assistant message
          for (const block of content) {
            if (block.type === 'tool_use') {
              // Hang detection logging
              toolUseCount++;
              const toolTimestamp = new Date().toISOString();
              console.log(`🔧 [${toolTimestamp}] Tool #${toolUseCount}: ${block.name}`);

              // Check if this is ExitPlanMode tool (deduplicate - only send first one per turn)
              if (block.name === 'ExitPlanMode' && !exitPlanModeSentThisTurn) {
                exitPlanModeSentThisTurn = true; // Mark as sent
                sessionStreamManager.safeSend(
                  sessionId as string,
                  JSON.stringify({
                    type: 'exit_plan_mode',
                    plan: (block.input as Record<string, unknown>)?.plan || 'No plan provided',
                    sessionId: sessionId,
                  })
                );
                // SKIP sending tool_use event for ExitPlanMode to avoid duplicate rendering
                // The exit_plan_mode event already triggers the modal, no need for chat block
                continue;
              } else if (block.name === 'ExitPlanMode') {
                continue; // Skip duplicate ExitPlanMode
              }

              // Background processes are now intercepted and spawned via PreToolUse hook
              // No need for detection here since the hook blocks SDK execution

              sessionStreamManager.safeSend(
                sessionId as string,
                JSON.stringify({
                  type: 'tool_use',
                  toolId: block.id,
                  toolName: block.name,
                  toolInput: block.input,
                  sessionId: sessionId,
                })
              );
            }
                }
              }
            }
          } // End for-await loop

          } catch (error) {
            // Check if this is a user-triggered abort (expected)
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('aborted by user') || errorMessage.includes('AbortError')) {
              console.log(`✅ Generation stopped by user: ${sessionId.toString().substring(0, 8)}`);

              // Save partial response (same as normal turn completion)
              if (!currentMessageId) {
                if (currentMessageContent.length > 0) {
                  sessionDb.addMessage(sessionId as string, 'assistant', JSON.stringify(currentMessageContent));
                  console.log(`💾 Saved ${currentMessageContent.length} content blocks from aborted response`);
                } else if (currentTextResponse) {
                  sessionDb.addMessage(sessionId as string, 'assistant', JSON.stringify([{ type: 'text', text: currentTextResponse }]));
                  console.log(`💾 Saved ${currentTextResponse.length} chars from aborted response`);
                }
              }

              // Send completion signal to client
              sessionStreamManager.safeSend(
                sessionId as string,
                JSON.stringify({ type: 'result', success: true, sessionId: sessionId })
              );

              // Wait for SDK to flush transcript file (give it 500ms)
              await new Promise(resolve => setTimeout(resolve, 500));

              // Cleanup stream - next message will spawn new subprocess and resume from transcript
              sessionStreamManager.cleanupSession(sessionId as string, 'user_aborted');
              activeQueries.delete(sessionId as string);

              // Return - next message will use resume option with SDK session ID
              return;
            }

            // Actual error - log and cleanup
            console.error(`❌ Background response loop error for session ${sessionId}:`, error);
            sessionStreamManager.cleanupSession(sessionId as string, 'loop_error');
            activeQueries.delete(sessionId as string);

            // Send error to client
            sessionStreamManager.safeSend(
              sessionId as string,
              JSON.stringify({
                type: 'error',
                message: errorMessage || 'Response processing error',
                sessionId: sessionId,
              })
            );
          } finally {
            clearInterval(heartbeatInterval);
          }
        })(); // Execute async IIFE immediately (non-blocking)

        break; // Exit retry loop

      } catch (error) {
        _lastError = error;
        console.error(`❌ Query attempt ${attemptNumber}/${MAX_RETRIES} failed:`, error);

        // Clean up failed session stream before retrying
        sessionStreamManager.cleanupSession(sessionId as string, 'retry_cleanup');
        activeQueries.delete(sessionId as string);

        // Parse error with stderr context for better error messages
        const parsedError = parseApiError(error, stderrOutput);
        console.log('📊 Parsed error:', {
          type: parsedError.type,
          message: parsedError.message,
          isRetryable: parsedError.isRetryable,
          requestId: parsedError.requestId,
          stderrContext: parsedError.stderrContext ? parsedError.stderrContext.slice(0, 100) + '...' : undefined,
        });

        // Check if error is retryable
        if (!parsedError.isRetryable) {
          console.error('❌ Non-retryable error, aborting:', parsedError.type);

          // Send error to client with specific error type
          ws.send(JSON.stringify({
            type: 'error',
            errorType: parsedError.type,
            message: getUserFriendlyMessage(parsedError),
            requestId: parsedError.requestId,
            sessionId: sessionId,
          }));

          // Clean up
          break; // Don't retry
        }

        // Check if we've exhausted retries
        if (attemptNumber >= MAX_RETRIES) {
          console.error('❌ Max retries reached, giving up');

          // Send final error to client
          ws.send(JSON.stringify({
            type: 'error',
            errorType: parsedError.type,
            message: getUserFriendlyMessage(parsedError),
            requestId: parsedError.requestId,
            sessionId: sessionId,
          }));

          // Clean up
          break;
        }

        // Calculate retry delay with exponential backoff
        let delayMs = INITIAL_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attemptNumber - 1);

        // Respect rate limit retry-after
        if (parsedError.type === 'rate_limit_error' && parsedError.retryAfterSeconds) {
          delayMs = parsedError.retryAfterSeconds * 1000;
        }

        // Cap at 16 seconds
        delayMs = Math.min(delayMs, 16000);

        // Notify client of retry
        ws.send(JSON.stringify({
          type: 'retry_attempt',
          attempt: attemptNumber,
          maxAttempts: MAX_RETRIES,
          delayMs: delayMs,
          errorType: parsedError.type,
          message: `Retrying... (attempt ${attemptNumber}/${MAX_RETRIES})`,
          sessionId,
        }));

        // Wait before retrying
        console.log(`⏳ Waiting ${delayMs}ms before retry ${attemptNumber + 1}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        // Continue to next iteration of retry loop
      }
    }

  } catch (error) {
    // This catch is for errors outside the retry loop (e.g., session validation)
    console.error('WebSocket handler error:', error);
    // No stderr context available here since this is before SDK initialization
    const parsedError = parseApiError(error);
    ws.send(JSON.stringify({
      type: 'error',
      errorType: parsedError.type,
      message: getUserFriendlyMessage(parsedError),
      sessionId: sessionId,
    }));
  }
}

/** Resolve a pending AskUserQuestion promise with the user's answer */
function handleAnswerQuestion(data: Record<string, unknown>): void {
  const { sessionId, answers } = data;
  if (!sessionId || typeof sessionId !== 'string') return;

  const pending = pendingQuestions.get(sessionId);
  if (pending) {
    console.log(`✅ User answered question for session ${sessionId.substring(0, 8)}`);
    pendingQuestions.delete(sessionId);
    pending.resolve(JSON.stringify(answers));
  } else {
    console.warn(`⚠️ No pending question for session ${sessionId.substring(0, 8)}`);
  }
}

async function handleApprovePlan(
  ws: ServerWebSocket<ChatWebSocketData>,
  data: Record<string, unknown>,
  activeQueries: Map<string, unknown>
): Promise<void> {
  const { sessionId } = data;

  if (!sessionId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId', sessionId }));
    return;
  }

  const activeQuery = activeQueries.get(sessionId as string);

  try {
    console.log('✅ Plan approved, switching to bypassPermissions mode');

    // CRITICAL FIX: Only try to switch mode if there's an active query
    // If no active query, the session will start in bypassPermissions mode on next message
    if (activeQuery) {
      console.log(`🔄 Switching SDK permission mode: plan → bypassPermissions`);
      await (activeQuery as { setPermissionMode: (mode: string) => Promise<void> }).setPermissionMode('bypassPermissions');
      console.log('✅ SDK mode switched successfully');
    } else {
      console.log('⚠️  No active query - mode will be applied on next message');
    }

    // Update database to bypassPermissions mode (important for next session load)
    sessionDb.updatePermissionMode(sessionId as string, 'bypassPermissions');

    // Send confirmation to client
    ws.send(JSON.stringify({
      type: 'permission_mode_changed',
      mode: 'bypassPermissions',
      sessionId
    }));

    console.log('✅ Plan approved, database updated to bypassPermissions');
  } catch (error) {
    console.error('❌ Failed to handle plan approval:', error);

    // Still update database even if SDK switch fails
    sessionDb.updatePermissionMode(sessionId as string, 'bypassPermissions');

    ws.send(JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to approve plan',
      sessionId
    }));
  }
}

async function handleSetPermissionMode(
  ws: ServerWebSocket<ChatWebSocketData>,
  data: Record<string, unknown>,
  activeQueries: Map<string, unknown>
): Promise<void> {
  const { sessionId, mode } = data;

  if (!sessionId || !mode) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId or mode', sessionId }));
    return;
  }

  const activeQuery = activeQueries.get(sessionId as string);

  try {
    // If there's an active query, update it mid-stream
    if (activeQuery) {
      console.log(`🔄 Switching permission mode mid-stream: ${mode}`);
      await (activeQuery as { setPermissionMode: (mode: string) => Promise<void> }).setPermissionMode(mode as string);
    }

    // Always update database
    sessionDb.updatePermissionMode(sessionId as string, mode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan');

    ws.send(JSON.stringify({
      type: 'permission_mode_changed',
      mode,
      sessionId
    }));
  } catch (error) {
    console.error('Failed to update permission mode:', error);
    ws.send(JSON.stringify({
      type: 'error',
      error: 'Failed to update permission mode',
      sessionId
    }));
  }
}

async function handleKillBackgroundProcess(
  ws: ServerWebSocket<ChatWebSocketData>,
  data: Record<string, unknown>
): Promise<void> {
  const { bashId } = data;

  if (!bashId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing bashId', sessionId: data.sessionId }));
    return;
  }

  try {
    console.log(`🛑 Killing background process: ${bashId}`);

    const success = await backgroundProcessManager.kill(bashId as string);

    if (success) {
      ws.send(JSON.stringify({
        type: 'background_process_killed',
        bashId,
        sessionId: data.sessionId
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Process not found',
        sessionId: data.sessionId
      }));
    }
  } catch (error) {
    console.error('Failed to kill background process:', error);
    ws.send(JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to kill background process',
      sessionId: data.sessionId
    }));
  }
}

async function handleStopGeneration(
  ws: ServerWebSocket<ChatWebSocketData>,
  data: Record<string, unknown>
): Promise<void> {
  const { sessionId } = data;

  if (!sessionId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId', sessionId }));
    return;
  }

  try {
    console.log(`🛑 Stop generation requested for session: ${sessionId.toString().substring(0, 8)}`);

    const success = sessionStreamManager.abortSession(sessionId as string);

    if (success) {
      console.log(`✅ Generation stopped successfully: ${sessionId.toString().substring(0, 8)}`);
      ws.send(JSON.stringify({
        type: 'generation_stopped',
        sessionId
      }));
    } else {
      console.warn(`⚠️ Failed to stop generation (session not found): ${sessionId.toString().substring(0, 8)}`);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Session not found or already stopped',
        sessionId
      }));
    }
  } catch (error) {
    console.error('❌ Error stopping generation:', error);
    ws.send(JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to stop generation',
      sessionId
    }));
  }
}
