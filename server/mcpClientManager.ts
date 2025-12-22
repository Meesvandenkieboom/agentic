/**
 * Agent Smith - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * MCP Client Manager
 * Spawns and manages mcp-remote processes for OAuth-based MCP servers (Atlassian, Figma, etc.)
 * Makes MCP tools available to Claude SDK as if they were native tools.
 */

import type { Subprocess } from "bun";
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

// Config path for connected servers
const MCP_CONNECTIONS_PATH = path.join(process.cwd(), '.claude', 'mcp-connections.json');

interface MCPConnection {
  id: string;
  name: string;
  url: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  pid?: number;
  tools?: MCPTool[];
  error?: string;
  connectedAt?: number;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPProcess {
  id: string;
  subprocess: Subprocess;
  process?: ReturnType<typeof spawn>;
  stdin?: NodeJS.WritableStream;
  stdout?: NodeJS.ReadableStream;
  pid: number;
  url: string;
  messageQueue: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  requestId: number;
  tools: MCPTool[];
  buffer: string;
}

class MCPClientManager {
  private connections = new Map<string, MCPConnection>();
  private processes = new Map<string, MCPProcess>();

  constructor() {
    // Load persisted connections on startup
    this.loadConnections();
  }

  /**
   * Load connections from disk
   */
  private async loadConnections(): Promise<void> {
    try {
      const data = await fs.readFile(MCP_CONNECTIONS_PATH, 'utf-8');
      const connections = JSON.parse(data) as Record<string, MCPConnection>;

      // Restore connection metadata but mark as disconnected (processes don't survive restart)
      for (const [id, conn] of Object.entries(connections)) {
        this.connections.set(id, {
          ...conn,
          status: 'disconnected',
          pid: undefined,
        });
      }

      console.log(`📦 MCP: Loaded ${Object.keys(connections).length} saved connections`);
    } catch {
      // No saved connections
    }
  }

  /**
   * Save connections to disk
   */
  private async saveConnections(): Promise<void> {
    const connectionsObj: Record<string, MCPConnection> = {};
    for (const [id, conn] of this.connections) {
      connectionsObj[id] = {
        ...conn,
        // Don't persist runtime data
        pid: undefined,
      };
    }

    const dir = path.dirname(MCP_CONNECTIONS_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(MCP_CONNECTIONS_PATH, JSON.stringify(connectionsObj, null, 2));
  }

  /**
   * Connect to an MCP server via mcp-remote
   * This spawns the mcp-remote process which handles OAuth in the browser
   */
  async connect(id: string, name: string, url: string): Promise<MCPConnection> {
    // Check if already connected
    const existing = this.processes.get(id);
    if (existing) {
      try {
        process.kill(existing.pid, 0);
        // Process still alive
        const conn = this.connections.get(id);
        if (conn) return conn;
      } catch {
        // Process dead, clean up
        this.processes.delete(id);
      }
    }

    console.log(`🔌 MCP: Connecting to ${name} (${url})...`);

    // Update status to connecting
    const connection: MCPConnection = {
      id,
      name,
      url,
      status: 'connecting',
    };
    this.connections.set(id, connection);

    try {
      // Spawn mcp-remote as stdio proxy
      // mcp-remote handles OAuth flow automatically (opens browser)
      const proc = spawn('npx', ['-y', 'mcp-remote', url], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      if (!proc.pid) {
        throw new Error('Failed to spawn mcp-remote process');
      }

      const mcpProcess: MCPProcess = {
        id,
        subprocess: null as unknown as Subprocess, // We use child_process spawn instead
        process: proc,
        stdin: proc.stdin as unknown as NodeJS.WritableStream,
        stdout: proc.stdout as unknown as NodeJS.ReadableStream,
        pid: proc.pid,
        url,
        messageQueue: [],
        requestId: 0,
        tools: [],
        buffer: '',
      };

      this.processes.set(id, mcpProcess);

      // Handle stdout (JSON-RPC responses)
      proc.stdout?.on('data', (data: Buffer) => {
        this.handleStdout(id, data.toString());
      });

      // Handle stderr (logs, OAuth messages)
      proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          // Check for OAuth-related messages
          if (msg.includes('Opening browser') || msg.includes('authorization')) {
            console.log(`🌐 MCP [${name}]: OAuth flow started - check your browser`);
          } else if (msg.includes('authenticated') || msg.includes('success')) {
            console.log(`✅ MCP [${name}]: Authentication successful`);
          } else {
            console.log(`📝 MCP [${name}]: ${msg}`);
          }
        }
      });

      // Handle process exit
      proc.on('exit', (code) => {
        console.log(`🔌 MCP [${name}]: Process exited with code ${code}`);
        this.processes.delete(id);

        const conn = this.connections.get(id);
        if (conn) {
          conn.status = 'disconnected';
          conn.pid = undefined;
        }
      });

      // Wait a moment for mcp-remote to initialize
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Initialize MCP connection via JSON-RPC
      await this.sendRequest(id, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'agent-smith',
          version: '1.0.0',
        },
      });

      // Send initialized notification
      await this.sendNotification(id, 'notifications/initialized', {});

      // Discover available tools
      const toolsResponse = await this.sendRequest(id, 'tools/list', {}) as { tools: MCPTool[] };
      mcpProcess.tools = toolsResponse.tools || [];

      console.log(`✅ MCP [${name}]: Connected with ${mcpProcess.tools.length} tools`);
      mcpProcess.tools.forEach(tool => {
        console.log(`   - ${tool.name}: ${tool.description?.slice(0, 60) || 'No description'}...`);
      });

      // Update connection status
      connection.status = 'connected';
      connection.pid = proc.pid;
      connection.tools = mcpProcess.tools;
      connection.connectedAt = Date.now();

      await this.saveConnections();
      return connection;

    } catch (error) {
      console.error(`❌ MCP [${name}]: Connection failed:`, error);

      connection.status = 'error';
      connection.error = error instanceof Error ? error.message : String(error);

      // Clean up failed process
      const proc = this.processes.get(id);
      if (proc?.process) {
        proc.process.kill();
      }
      this.processes.delete(id);

      await this.saveConnections();
      return connection;
    }
  }

  /**
   * Handle stdout data from mcp-remote (JSON-RPC messages)
   */
  private handleStdout(id: string, data: string): void {
    const mcpProcess = this.processes.get(id);
    if (!mcpProcess) return;

    // Buffer data and process complete JSON-RPC messages
    mcpProcess.buffer += data;

    // Process line by line (JSON-RPC uses newline-delimited JSON)
    const lines = mcpProcess.buffer.split('\n');
    mcpProcess.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);

        // Handle response to our request
        if ('id' in message && message.id !== undefined) {
          const pending = mcpProcess.messageQueue.shift();
          if (pending) {
            if ('error' in message) {
              pending.reject(new Error(message.error.message || 'MCP error'));
            } else {
              pending.resolve(message.result);
            }
          }
        }
      } catch (e) {
        console.warn(`⚠️ MCP [${id}]: Failed to parse message:`, line.slice(0, 100));
      }
    }
  }

  /**
   * Send JSON-RPC request to MCP server
   */
  private sendRequest(id: string, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const mcpProcess = this.processes.get(id);
      if (!mcpProcess || !mcpProcess.process?.stdin) {
        reject(new Error(`MCP server ${id} not connected`));
        return;
      }

      const requestId = ++mcpProcess.requestId;
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method,
        params,
      }) + '\n';

      mcpProcess.messageQueue.push({ resolve, reject });

      try {
        mcpProcess.process.stdin.write(message);
      } catch (error) {
        mcpProcess.messageQueue.pop();
        reject(error);
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        const index = mcpProcess.messageQueue.findIndex(p => p.resolve === resolve);
        if (index >= 0) {
          mcpProcess.messageQueue.splice(index, 1);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * Send JSON-RPC notification (no response expected)
   */
  private async sendNotification(id: string, method: string, params: unknown): Promise<void> {
    const mcpProcess = this.processes.get(id);
    if (!mcpProcess || !mcpProcess.process?.stdin) {
      throw new Error(`MCP server ${id} not connected`);
    }

    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }) + '\n';

    mcpProcess.process.stdin.write(message);
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(id: string): Promise<void> {
    const mcpProcess = this.processes.get(id);
    if (mcpProcess?.process) {
      console.log(`🔌 MCP: Disconnecting ${id}...`);
      mcpProcess.process.kill();
    }

    this.processes.delete(id);

    const conn = this.connections.get(id);
    if (conn) {
      conn.status = 'disconnected';
      conn.pid = undefined;
    }

    await this.saveConnections();
  }

  /**
   * Get all connections
   */
  getConnections(): MCPConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get a specific connection
   */
  getConnection(id: string): MCPConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * Check if a server is connected
   */
  isConnected(id: string): boolean {
    const conn = this.connections.get(id);
    return conn?.status === 'connected';
  }

  /**
   * Call a tool on a connected MCP server
   */
  async callTool(id: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const mcpProcess = this.processes.get(id);
    if (!mcpProcess) {
      throw new Error(`MCP server ${id} not connected`);
    }

    console.log(`🔧 MCP [${id}]: Calling tool ${toolName}`);

    const result = await this.sendRequest(id, 'tools/call', {
      name: toolName,
      arguments: args,
    });

    return result;
  }

  /**
   * Get all tools from connected MCP servers in Claude SDK format
   * These can be passed to mcpServers option
   */
  getMcpServersForSDK(): Record<string, { type: 'stdio'; command: string; args: string[] }> {
    const servers: Record<string, { type: 'stdio'; command: string; args: string[] }> = {};

    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') {
        servers[conn.id] = {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'mcp-remote', conn.url],
        };
      }
    }

    return servers;
  }

  /**
   * Get all available tools from connected servers
   */
  getAllTools(): Array<{ serverId: string; serverName: string; tool: MCPTool }> {
    const tools: Array<{ serverId: string; serverName: string; tool: MCPTool }> = [];

    for (const conn of this.connections.values()) {
      if (conn.status === 'connected' && conn.tools) {
        for (const tool of conn.tools) {
          tools.push({
            serverId: conn.id,
            serverName: conn.name,
            tool,
          });
        }
      }
    }

    return tools;
  }

  /**
   * Remove a saved connection
   */
  async removeConnection(id: string): Promise<void> {
    await this.disconnect(id);
    this.connections.delete(id);
    await this.saveConnections();
  }
}

// Export singleton instance
export const mcpClientManager = new MCPClientManager();
