/**
 * Codex Provider
 *
 * Modular wrapper for @openai/codex-sdk that maps Codex events to Agentic's
 * WebSocket protocol. Fully isolated - if Codex breaks, Claude keeps working.
 *
 * @module server/providers/codex
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Codex event callback interface matching Agentic's WebSocket protocol
export interface CodexEvent {
  type: 'assistant_message' | 'tool_use' | 'result' | 'error' | 'thinking_start' | 'thinking_delta';
  content?: string;
  toolName?: string;
  toolInput?: object;
  success?: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  };
  message?: string;
}

export type CodexEventCallback = (event: CodexEvent) => void;

// Type definition for Codex SDK
interface CodexSDKConstructor {
  new (): CodexSDKInstance;
}

interface CodexThreadOptions {
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
}

interface CodexSDKInstance {
  startThread(): CodexThread;
}

interface CodexThread {
  runStreamed(prompt: string): Promise<{ events: AsyncIterable<CodexSDKEvent> }>;
}

interface CodexSDKEvent {
  type: string;
  item?: {
    type?: string;
    text?: string;
    isThinking?: boolean;
    command?: string;
    exitCode?: number;
    output?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

// Lazy-loaded Codex SDK to prevent import errors if not installed
let CodexSDK: CodexSDKConstructor | null = null;
let sdkLoadError: Error | null = null;

/**
 * Attempts to load the Codex SDK dynamically
 */
async function loadCodexSDK() {
  if (CodexSDK) return CodexSDK;
  if (sdkLoadError) throw sdkLoadError;

  try {
    const module = await import("@openai/codex-sdk");
    CodexSDK = module.Codex;
    console.log("🤖 Codex SDK loaded successfully");
    return CodexSDK;
  } catch (error) {
    sdkLoadError = error as Error;
    console.warn("🤖 Codex SDK not available:", (error as Error).message);
    throw new Error("Codex SDK not installed. Run: npm install @openai/codex-sdk");
  }
}

/**
 * Checks if Codex CLI is installed and authenticated
 *
 * @returns Promise<boolean> - true if Codex is available
 */
export async function isCodexAvailable(): Promise<boolean> {
  try {
    // Check if SDK can be loaded
    await loadCodexSDK();

    // Check for auth file (indicates CLI is authenticated)
    const authPath = join(homedir(), ".codex", "auth.json");
    if (existsSync(authPath)) {
      console.log("🤖 Codex authentication found");
      return true;
    }

    // Try to execute codex --version as fallback check
    const proc = Bun.spawn(["codex", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });

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

/**
 * Runs a Codex streaming conversation and maps events to Agentic's protocol
 *
 * @param prompt - User prompt to send to Codex
 * @param workingDir - Working directory for file operations
 * @param onEvent - Callback for streaming events
 * @throws Error if Codex SDK is not available or execution fails
 */
export async function runCodexStream(
  prompt: string,
  workingDir: string,
  onEvent: CodexEventCallback
): Promise<void> {
  try {
    console.log("🤖 Starting Codex stream in directory:", workingDir);

    // Load SDK
    const Codex = await loadCodexSDK();

    const codex = new Codex();
    const thread = codex.startThread({
      workingDirectory: workingDir,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });

    console.log("🤖 Running Codex with prompt:", prompt.slice(0, 100) + "...");

    // Start streaming
    const { events } = await thread.runStreamed(prompt);

    let currentItemType: string | null = null;

    for await (const event of events) {
      console.log("🤖 Codex event:", event.type);

      switch (event.type) {
        case "thread.started":
          console.log("🤖 Thread started");
          break;

        case "turn.started":
          console.log("🤖 Turn started");
          break;

        case "item.started":
          currentItemType = event.item?.type ?? null;
          if (currentItemType === "agent_message") {
            // Some models emit thinking/reasoning traces
            if (event.item?.isThinking) {
              onEvent({ type: "thinking_start" });
            }
          }
          break;

        case "item.updated":
          if (event.item?.type === "agent_message" && event.item?.text) {
            if (event.item?.isThinking) {
              onEvent({
                type: "thinking_delta",
                content: event.item.text,
              });
            } else {
              onEvent({
                type: "assistant_message",
                content: event.item.text,
              });
            }
          }
          break;

        case "item.completed":
          if (event.item?.type === "agent_message" && event.item?.text) {
            // Final message chunk
            onEvent({
              type: "assistant_message",
              content: event.item.text,
            });
          } else if (event.item?.type === "command_execution") {
            // Tool/command execution
            onEvent({
              type: "tool_use",
              toolName: event.item.command || "unknown_command",
              toolInput: {
                command: event.item.command,
                exitCode: event.item.exitCode,
                output: event.item.output,
              },
            });
          }
          break;

        case "turn.completed":
          console.log("🤖 Turn completed with usage:", event.usage);
          onEvent({
            type: "result",
            success: true,
            usage: event.usage ? {
              input_tokens: event.usage.input_tokens || 0,
              output_tokens: event.usage.output_tokens || 0,
              cached_input_tokens: event.usage.cached_input_tokens,
            } : undefined,
          });
          break;

        case "turn.failed":
          console.error("🤖 Turn failed:", event.error);
          onEvent({
            type: "error",
            message: event.error?.message || "Codex turn failed",
          });
          break;

        case "error":
          console.error("🤖 Codex error:", event.error);
          onEvent({
            type: "error",
            message: event.error?.message || "Unknown Codex error",
          });
          break;

        default:
          console.log("🤖 Unhandled event type:", event.type);
      }
    }

    console.log("🤖 Codex stream completed successfully");
  } catch (error) {
    console.error("🤖 Codex stream error:", error);

    // Send error event to client
    onEvent({
      type: "error",
      message: error instanceof Error ? error.message : "Unknown Codex error",
    });

    // Re-throw to allow caller to handle
    throw error;
  }
}
