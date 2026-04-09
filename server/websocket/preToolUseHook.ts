/**
 * PreToolUse hook factory
 *
 * Creates the PreToolUse hook that intercepts Bash commands for:
 * - Long-running commands (install, build, test) with monitored output streaming
 * - Background processes (dev servers) with duplicate detection
 */

import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { sessionDb } from "../database";
import { backgroundProcessManager } from "../backgroundProcessManager";
import { sessionStreamManager } from "../sessionStreamManager";

type PreToolUseInput = HookInput & { tool_name: string; tool_input: Record<string, unknown> };

/**
 * Create PreToolUse hooks for a given session
 */
export function createPreToolUseHooks(sessionId: string, workingDir: string) {
  return {
    PreToolUse: [{
      hooks: [async (input: HookInput, toolUseID: string | undefined) => {
        if (input.hook_event_name !== 'PreToolUse') return {};

        const { tool_name, tool_input } = input as PreToolUseInput;

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
          return handleLongRunningCommand(
            sessionId, workingDir, bashId, command, description,
            isInstallCommand, isBuildCommand,
          );
        }

        // Handle regular background commands (e.g., dev servers)
        if (bashInput.run_in_background === true) {
          return handleBackgroundCommand(sessionId, workingDir, bashId, command, description);
        }

        // Not a special command, let it pass through
        return {};
      }],
    }],
  };
}

async function handleLongRunningCommand(
  sessionId: string,
  workingDir: string,
  bashId: string,
  command: string,
  description: string | undefined,
  isInstallCommand: boolean,
  isBuildCommand: boolean,
) {
  const commandType = isInstallCommand ? 'install' : isBuildCommand ? 'build' : 'test';

  // Spawn background process
  const { pid } = await backgroundProcessManager.spawn(command, workingDir, bashId, sessionId, description);

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
    sessionId,
    'assistant',
    JSON.stringify([longRunningCommandBlock])
  );

  // Notify client that long-running command started
  sessionStreamManager.safeSend(sessionId, JSON.stringify({
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
        sessionStreamManager.safeSend(sessionId, JSON.stringify({
          type: 'command_output_chunk',
          bashId,
          output: chunk,
          sessionId,
        }));
      },
    });

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

    sessionStreamManager.safeSend(sessionId, JSON.stringify({
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
    sessionStreamManager.safeSend(sessionId, JSON.stringify({
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

async function handleBackgroundCommand(
  sessionId: string,
  workingDir: string,
  bashId: string,
  command: string,
  description: string | undefined,
) {
  // Check if this specific command is already running for this session
  const existingProcess = backgroundProcessManager.findExistingProcess(sessionId, command);

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
  const { pid } = await backgroundProcessManager.spawn(command, workingDir, bashId, sessionId, description);

  console.log(`🚀 Background process spawned (PID ${pid}): ${command.slice(0, 50)}${command.length > 50 ? '...' : ''}`);

  // Notify the client (safeSend survives reconnection)
  sessionStreamManager.safeSend(sessionId, JSON.stringify({
    type: 'background_process_started',
    bashId,
    command,
    description,
    startedAt: Date.now(),
    sessionId,
  }));

  // Replace the command with an echo so the SDK gets a successful result
  return {
    decision: 'approve' as const,
    updatedInput: {
      command: `echo "✓ Background server started (PID ${pid})"`,
      description,
    },
  };
}
