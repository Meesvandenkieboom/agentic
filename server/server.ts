/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Check for --setup flag before starting the server
if (process.argv.includes('--setup')) {
  const { runSetup } = await import('../setup');
  await runSetup();
  process.exit(0);
}

// Check for CLI flags before starting the server
// Run cli.ts as a separate process to avoid importing server modules
const cliFlag = process.argv.find(arg =>
  arg === '--login' || arg === 'login' ||
  arg === '--logout' || arg === 'logout' ||
  arg === '--status' || arg === 'status' || arg === '--auth-status' ||
  arg === '--update' || arg === 'update'
);

if (cliFlag) {
  const proc = Bun.spawn(['bun', 'run', 'cli.ts', cliFlag], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  process.exit(exitCode);
}

import { watch } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { existsSync } from "fs";
import { getDefaultWorkingDirectory, ensureDirectory } from "./directoryUtils";
import { handleStaticFile } from "./staticFileServer";
import { initializeStartup, checkNodeAvailability } from "./startup";
import { handleSessionRoutes } from "./routes/sessions";
import { handleDirectoryRoutes } from "./routes/directory";
import { handleUserConfigRoutes } from "./routes/userConfig";
import { handleCommandRoutes } from "./routes/commands";
import { handleImportRoutes } from "./routes/import";
import { handleGitHubRoutes } from "./routes/github";
import { handleAgentRoutes } from "./routes/agents";
import { handleMCPServerRoutes } from "./routes/mcpServers";
import { handleWebSocketMessage } from "./websocket/messageHandlers";
import type { ChatWebSocketData } from "./websocket/types";
import { sessionStreamManager } from "./sessionStreamManager";
import { runStartupMigrations } from "./utils/configMigration";
import { cleanupOrphanedMcpProcesses } from "./mcpCleanup";
import { shutdownAllMcpBridges } from "./mcpSingletonBridge";
import type { ServerWebSocket, Server as ServerType } from "bun";

// Initialize startup configuration (loads env vars, sets up PostCSS)
const { isStandalone: IS_STANDALONE, binaryDir: BINARY_DIR, postcss, tailwindcss, autoprefixer } = await initializeStartup();

// Check Node.js availability for Claude SDK subprocess
await checkNodeAvailability();

// Run config migrations (updates schemas, preserves user data)
await runStartupMigrations();

// Clean up any orphaned MCP processes from previous sessions/crashes
// This prevents port conflicts (e.g., Roblox Studio MCP on port 3002)
await cleanupOrphanedMcpProcesses();

// Make sure singleton MCP bridges (eg rbxstudio-mcp) are torn down on
// shutdown so they don't leak into the next agentic process. Registered
// for SIGINT/SIGTERM here so it covers both `--tunnel` and normal mode.
// The bridge module also installs a synchronous `process.on('exit')`
// handler as a last-resort fallback for crashes.
//
// IMPORTANT: registering a SIGINT handler suppresses Node's default
// terminate-on-Ctrl+C behavior, so we MUST call process.exit() ourselves.
// Otherwise the parent stays alive while the SDK subprocesses receive
// the signal and crash with "Claude Code process terminated by signal
// SIGINT", and Ctrl+C feels broken from the terminal.
let _shuttingDown = false;
const _mcpShutdownHandler = (signal: 'SIGINT' | 'SIGTERM') => {
  // Second Ctrl+C: bail out hard instead of waiting for cleanup again.
  if (_shuttingDown) {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
  _shuttingDown = true;

  // Hard cap on shutdown so a stuck MCP child can't hold the process open.
  const forceExit = setTimeout(() => {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }, 2_000);
  forceExit.unref();

  shutdownAllMcpBridges()
    .catch((err) => console.error(`MCP bridge shutdown error on ${signal}:`, err))
    .finally(() => {
      clearTimeout(forceExit);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
};
process.on('SIGINT', () => _mcpShutdownHandler('SIGINT'));
process.on('SIGTERM', () => _mcpShutdownHandler('SIGTERM'));

// Initialize default working directory
const DEFAULT_WORKING_DIR = getDefaultWorkingDirectory();
ensureDirectory(DEFAULT_WORKING_DIR);

// Hot reload WebSocket clients
interface HotReloadClient {
  send: (message: string) => void;
}

// Store active queries for mid-stream control
const activeQueries = new Map<string, unknown>();

const hotReloadClients = new Set<HotReloadClient>();

// Watch for file changes (hot reload) - only in dev mode
if (!IS_STANDALONE) {
  watch('./client', { recursive: true }, (_eventType, filename) => {
    if (filename && (filename.endsWith('.tsx') || filename.endsWith('.ts') || filename.endsWith('.css') || filename.endsWith('.html'))) {
      // Notify all hot reload clients
      hotReloadClients.forEach(client => {
        try {
          client.send(JSON.stringify({ type: 'reload' }));
        } catch {
          hotReloadClients.delete(client);
        }
      });
    }
  });
}

const server = Bun.serve({
  port: 3001,
  idleTimeout: 255, // 4.25 minutes (Bun's maximum) - keepalive messages every 30s prevent timeout

  websocket: {
    open(ws: ServerWebSocket<ChatWebSocketData>) {
      if (ws.data?.type === 'hot-reload') {
        hotReloadClients.add(ws);
      }
      // Session ID is assigned in first message, not on connection
    },

    async message(ws: ServerWebSocket<ChatWebSocketData>, message: string) {
      await handleWebSocketMessage(ws, message, activeQueries);
    },

    close(ws: ServerWebSocket<ChatWebSocketData>) {
      if (ws.data?.type === 'hot-reload') {
        hotReloadClients.delete(ws);
      } else if (ws.data?.type === 'chat') {
        // Find ALL sessions that were using this WebSocket (not just ws.data.sessionId)
        // This fixes a bug where only the last-reconnected session got a grace period,
        // leaving other sessions as orphaned zombies consuming API tokens.
        const affectedSessions = sessionStreamManager.getSessionsByWebSocket(ws);

        if (affectedSessions.length > 0) {
          console.log(`🔌 WebSocket disconnected: ${affectedSessions.length} session(s) affected [${affectedSessions.map(s => s.substring(0, 8)).join(', ')}]`);

          for (const sid of affectedSessions) {
            const remainingSockets = sessionStreamManager.detachWebSocket(sid, ws);
            if (remainingSockets === 0 && sessionStreamManager.hasStream(sid)) {
              sessionStreamManager.startDisconnectGracePeriod(sid, () => {
                console.log(`⏱️ Grace period expired for session ${sid.substring(0, 8)} — aborting generation`);
                sessionStreamManager.abortSession(sid);
                sessionStreamManager.cleanupSession(sid, 'websocket_disconnected');
                activeQueries.delete(sid);
              }, 60000);
            } else if (remainingSockets > 0) {
              console.log(`🔌 Session ${sid.substring(0, 8)} still has ${remainingSockets} connected client(s)`);
            }
          }
        } else {
          // Fallback: check ws.data.sessionId for sessions that were never registered
          const sid = ws.data.sessionId;
          if (sid) {
            console.log(`🔌 WebSocket disconnected: session ${sid.substring(0, 8)} (fallback)`);
            const remainingSockets = sessionStreamManager.detachWebSocket(sid, ws);
            if (remainingSockets === 0 && sessionStreamManager.hasStream(sid)) {
              sessionStreamManager.startDisconnectGracePeriod(sid, () => {
                console.log(`⏱️ Grace period expired for session ${sid.substring(0, 8)} — aborting generation`);
                sessionStreamManager.abortSession(sid);
                sessionStreamManager.cleanupSession(sid, 'websocket_disconnected');
                activeQueries.delete(sid);
              }, 60000);
            }
          }
        }
      }
    }
  },

  async fetch(req: Request, server: ServerType<ChatWebSocketData>) {
    const url = new URL(req.url);

    // WebSocket endpoints
    if (url.pathname === '/hot-reload') {
      const upgraded = server.upgrade(req, { data: { type: 'hot-reload' } });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return;
    }

    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, { data: { type: 'chat' } });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return;
    }

    // Try session routes
    const sessionResponse = await handleSessionRoutes(req, url, activeQueries);
    if (sessionResponse) {
      return sessionResponse;
    }

    // Try directory routes
    const directoryResponse = await handleDirectoryRoutes(req, url);
    if (directoryResponse) {
      return directoryResponse;
    }

    // Try user config routes
    const userConfigResponse = await handleUserConfigRoutes(req, url);
    if (userConfigResponse) {
      return userConfigResponse;
    }

    // Try command routes
    const commandResponse = await handleCommandRoutes(req, url);
    if (commandResponse) {
      return commandResponse;
    }

    // Try import routes
    const importResponse = await handleImportRoutes(req, url);
    if (importResponse) {
      return importResponse;
    }

    // Try GitHub routes
    const githubResponse = await handleGitHubRoutes(req, url);
    if (githubResponse) {
      return githubResponse;
    }

    // Try agent routes
    const agentResponse = await handleAgentRoutes(req, url);
    if (agentResponse) {
      return agentResponse;
    }

    // Try MCP server routes
    const mcpServerResponse = await handleMCPServerRoutes(req, url);
    if (mcpServerResponse) {
      return mcpServerResponse;
    }

    // Try to handle as static file
    const staticResponse = await handleStaticFile(req, {
      binaryDir: BINARY_DIR,
      isStandalone: IS_STANDALONE,
      postcss,
      tailwindcss,
      autoprefixer,
    });

    if (staticResponse) {
      return staticResponse;
    }

    return new Response('Not Found', { status: 404 });
  },
});

// Check for --tunnel flag
const ENABLE_TUNNEL = process.argv.includes('--tunnel') || process.argv.includes('-t');

// ASCII Art Banner
console.log('\n');
console.log('  █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗ ██████╗');
console.log(' ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║██╔════╝');
console.log(' ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║██║     ');
console.log(' ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║██║     ');
console.log(' ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║╚██████╗');
console.log(' ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝ ╚═════╝');
console.log('\n');
console.log(`  👉 Local:  http://localhost:${server.port}`);

// Start tunnel if enabled (using cloudflared)
if (ENABLE_TUNNEL) {
  // Find cloudflared binary
  const cloudflaredPaths = [
    `${homedir()}/.local/bin/cloudflared`,
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    'cloudflared' // PATH fallback
  ];

  const cloudflaredPath = cloudflaredPaths.find(p => p === 'cloudflared' || existsSync(p)) || 'cloudflared';

  try {
    const tunnelProcess = spawn(cloudflaredPath, ['tunnel', '--url', 'http://localhost:3001'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let urlPrinted = false;

    const handleOutput = (data: Buffer) => {
      const output = data.toString();
      // cloudflared outputs the URL in a line like: "https://xxx.trycloudflare.com"
      const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !urlPrinted) {
        urlPrinted = true;
        console.log(`  📱 Public: ${urlMatch[0]}`);
        console.log('\n');
        console.log('  ═══════════════════════════════════════════════════════════════════════════════');
        console.log('\n');
        console.log('  All logs will show below this:');
        console.log('\n');
      }
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);

    tunnelProcess.on('error', (err) => {
      console.error('\n  ❌ Tunnel error:', err.message);
      console.log('\n');
      console.log('  Install cloudflared: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared');
    });

    tunnelProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.log(`\n  🔌 Tunnel closed (exit code: ${code})`);
      }
    });

    // Clean up tunnel on exit
    process.on('SIGINT', () => {
      tunnelProcess.kill();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      tunnelProcess.kill();
      process.exit(0);
    });

    // Wait a bit for the URL to be printed, then show fallback message
    setTimeout(() => {
      if (!urlPrinted) {
        console.log('  📱 Tunnel starting... (URL will appear shortly)');
        console.log('\n');
        console.log('  ═══════════════════════════════════════════════════════════════════════════════');
        console.log('\n');
        console.log('  All logs will show below this:');
        console.log('\n');
      }
    }, 3000);

  } catch (error) {
    console.log('\n');
    console.error('  ❌ Failed to start tunnel:', error);
    console.log('  Install cloudflared: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared');
  }
} else {
  console.log('  💡 Tip: Run with --tunnel to access from your phone');
  console.log('\n');
  console.log('  ═══════════════════════════════════════════════════════════════════════════════');
  console.log('\n');
  console.log('  All logs will show below this:');
  console.log('\n');
}
