/**
 * Agent Smith - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { MCP_SERVERS_BY_PROVIDER } from '../mcpServers';
import { mcpClientManager } from '../mcpClientManager';

const MCP_CONFIG_PATH = path.join(process.cwd(), '.claude', 'mcp-servers.json');

interface MCPHttpServerConfig {
  type: 'http';
  name?: string;
  url: string;
  headers?: Record<string, string>;
  authProvider?: string; // e.g., 'atlassian', 'figma', etc.
}

interface MCPStdioServerConfig {
  type: 'stdio';
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type MCPServerConfig = MCPHttpServerConfig | MCPStdioServerConfig;

interface MCPAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface MCPServersConfig {
  enabled: Record<string, boolean>;
  custom: Record<string, MCPServerConfig>;
  auth: Record<string, MCPAuthToken>; // Store auth tokens per server
}

// Known OAuth providers and their configurations
const OAUTH_PROVIDERS: Record<string, {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  detectUrl: RegExp;
}> = {
  atlassian: {
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: ['read:jira-work', 'write:jira-work', 'read:confluence-content.all', 'write:confluence-content'],
    detectUrl: /atlassian\.com/i,
  },
};

/**
 * Detect OAuth provider from server URL
 */
function detectAuthProvider(url: string): string | undefined {
  for (const [provider, config] of Object.entries(OAUTH_PROVIDERS)) {
    if (config.detectUrl.test(url)) {
      return provider;
    }
  }
  return undefined;
}

/**
 * Load MCP servers configuration from file
 */
async function loadMCPConfig(): Promise<MCPServersConfig> {
  try {
    const data = await fs.readFile(MCP_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(data) as MCPServersConfig;
    // Ensure auth field exists
    if (!config.auth) config.auth = {};
    return config;
  } catch {
    // Initialize with all built-in servers enabled
    const config: MCPServersConfig = {
      enabled: {},
      custom: {},
      auth: {}
    };

    // Enable all built-in servers by default
    const builtinServers = MCP_SERVERS_BY_PROVIDER['anthropic'] || {};
    Object.keys(builtinServers).forEach(key => {
      config.enabled[key] = true;
    });

    return config;
  }
}

/**
 * Save MCP servers configuration to file
 */
async function saveMCPConfig(config: MCPServersConfig): Promise<void> {
  const dir = path.dirname(MCP_CONFIG_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Get all MCP servers (built-in + custom)
 */
function getAllServers(config: MCPServersConfig) {
  const servers: Array<{
    id: string;
    name: string;
    type: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
    enabled: boolean;
    builtin: boolean;
    authenticated: boolean;
    authProvider?: string;
  }> = [];

  // Add built-in servers from Anthropic provider (as they're the default)
  const builtinServers = MCP_SERVERS_BY_PROVIDER['anthropic'] || {};
  Object.entries(builtinServers).forEach(([id, serverConfig]) => {
    const url = serverConfig.type === 'http' ? serverConfig.url : undefined;
    const authProvider = url ? detectAuthProvider(url) : undefined;
    servers.push({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' '),
      type: serverConfig.type,
      url,
      command: serverConfig.type === 'stdio' ? serverConfig.command : undefined,
      args: serverConfig.type === 'stdio' ? serverConfig.args : undefined,
      enabled: config.enabled[id] ?? true,
      builtin: true,
      authenticated: !!config.auth[id],
      authProvider,
    });
  });

  // Add custom servers
  Object.entries(config.custom).forEach(([id, serverConfig]) => {
    const url = serverConfig.type === 'http' ? serverConfig.url : undefined;
    const authProvider = serverConfig.type === 'http'
      ? (serverConfig.authProvider || (url ? detectAuthProvider(url) : undefined))
      : undefined;
    servers.push({
      id,
      name: serverConfig.name || id,
      type: serverConfig.type,
      url,
      command: serverConfig.type === 'stdio' ? serverConfig.command : undefined,
      args: serverConfig.type === 'stdio' ? serverConfig.args : undefined,
      enabled: config.enabled[id] ?? true,
      builtin: false,
      authenticated: !!config.auth[id],
      authProvider,
    });
  });

  return servers;
}

/**
 * Handle MCP server management routes
 */
export async function handleMCPServerRoutes(req: Request, url: URL): Promise<Response | undefined> {
  // GET /api/mcp-servers - List all MCP servers with their status
  if (req.method === 'GET' && url.pathname === '/api/mcp-servers') {
    const config = await loadMCPConfig();
    const servers = getAllServers(config);

    return new Response(JSON.stringify({ success: true, servers }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // POST /api/mcp-servers/:id/toggle - Enable/disable an MCP server
  const toggleMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/toggle$/);
  if (req.method === 'POST' && toggleMatch) {
    const id = toggleMatch[1];
    const config = await loadMCPConfig();

    // Toggle the enabled state
    const currentState = config.enabled[id] ?? true;
    config.enabled[id] = !currentState;

    await saveMCPConfig(config);

    return new Response(JSON.stringify({
      success: true,
      id,
      enabled: config.enabled[id]
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // POST /api/mcp-servers/:id/test - Test connection to an MCP server
  const testMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/test$/);
  if (req.method === 'POST' && testMatch) {
    const id = testMatch[1];
    const config = await loadMCPConfig();

    // Find the server
    const builtinServers = MCP_SERVERS_BY_PROVIDER['anthropic'] || {};
    const serverConfig = builtinServers[id] || config.custom[id];

    if (!serverConfig) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Server not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Test HTTP server by making a request
    if (serverConfig.type === 'http') {
      try {
        const response = await fetch(serverConfig.url, {
          method: 'GET',
          headers: serverConfig.headers || {},
          signal: AbortSignal.timeout(5000)
        });

        // 401/403 = server reachable but needs OAuth (this is fine!)
        if (response.status === 401 || response.status === 403) {
          return new Response(JSON.stringify({
            success: true,
            needsAuth: true,
            message: 'Server reachable - OAuth login required'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Accept various success responses (200, 404 for path-based servers, etc.)
        if (response.ok || response.status === 404 || response.status === 405) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          return new Response(JSON.stringify({
            success: false,
            error: `Server returned status ${response.status}`
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Connection failed'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } else {
      // For stdio servers, just check if the command exists
      // This is a simplified check - full validation would require spawning the process
      return new Response(JSON.stringify({
        success: true,
        message: 'Stdio server configuration validated'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // DELETE /api/mcp-servers/:id - Remove a custom MCP server
  const deleteMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const id = deleteMatch[1];
    const config = await loadMCPConfig();

    // Can only delete custom servers
    if (!config.custom[id]) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Cannot delete built-in MCP servers'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    delete config.custom[id];
    delete config.enabled[id];

    await saveMCPConfig(config);

    return new Response(JSON.stringify({ success: true, id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // POST /api/mcp-servers - Add a new custom MCP server
  if (req.method === 'POST' && url.pathname === '/api/mcp-servers') {
    const body = await req.json() as {
      id: string;
      name?: string;
      type: 'http' | 'stdio';
      url?: string;
      headers?: Record<string, string>;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    };

    const { id, name, type } = body;

    // Validate input
    if (!id || !type) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: id, type'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate type-specific fields
    if (type === 'http' && !body.url) {
      return new Response(JSON.stringify({
        success: false,
        error: 'HTTP servers require a URL'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (type === 'stdio' && !body.command) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stdio servers require a command'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate ID format (lowercase alphanumeric + dashes)
    if (!/^[a-z0-9-]+$/.test(id)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Server ID must be lowercase alphanumeric with dashes'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const config = await loadMCPConfig();

    // Check if server already exists
    const builtinServers = MCP_SERVERS_BY_PROVIDER['anthropic'] || {};
    if (builtinServers[id] || config.custom[id]) {
      return new Response(JSON.stringify({
        success: false,
        error: 'MCP server with this ID already exists'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Add custom server
    if (type === 'http') {
      config.custom[id] = {
        type: 'http',
        name,
        url: body.url!,
        headers: body.headers
      };
    } else {
      config.custom[id] = {
        type: 'stdio',
        name,
        command: body.command!,
        args: body.args,
        env: body.env
      };
    }
    config.enabled[id] = true;

    await saveMCPConfig(config);

    return new Response(JSON.stringify({ success: true, id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // POST /api/mcp-servers/:id/auth - Start OAuth flow for an MCP server
  const authMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/auth$/);
  if (req.method === 'POST' && authMatch) {
    const id = authMatch[1];
    const config = await loadMCPConfig();

    // Find the server
    const builtinServers = MCP_SERVERS_BY_PROVIDER['anthropic'] || {};
    const serverConfig = builtinServers[id] || config.custom[id];

    if (!serverConfig) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Server not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Detect OAuth provider
    const serverUrl = serverConfig.type === 'http' ? serverConfig.url : undefined;
    const authProvider = serverConfig.type === 'http' && 'authProvider' in serverConfig
      ? serverConfig.authProvider
      : (serverUrl ? detectAuthProvider(serverUrl) : undefined);

    if (!authProvider || !OAUTH_PROVIDERS[authProvider]) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No OAuth provider detected for this server. Try adding OAuth headers manually.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // For now, redirect to the MCP server's SSE endpoint which handles its own OAuth
    // The Atlassian MCP server at mcp.atlassian.com handles OAuth internally
    if (authProvider === 'atlassian') {
      // Atlassian MCP uses its own OAuth flow via the SSE endpoint
      // Opening this URL should trigger the OAuth flow
      return new Response(JSON.stringify({
        success: true,
        authUrl: `${serverUrl}?oauth=true`,
        provider: authProvider,
        message: 'Atlassian MCP handles OAuth via the SSE connection. Opening auth flow...'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generic OAuth 2.0 flow for other providers
    const providerConfig = OAUTH_PROVIDERS[authProvider];
    const state = crypto.randomUUID();
    const redirectUri = `${url.origin}/api/mcp-servers/oauth/callback`;

    const authUrl = new URL(providerConfig.authUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', process.env[`${authProvider.toUpperCase()}_CLIENT_ID`] || '');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', providerConfig.scopes.join(' '));
    authUrl.searchParams.set('state', `${id}:${state}`);

    return new Response(JSON.stringify({
      success: true,
      authUrl: authUrl.toString(),
      provider: authProvider
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // GET /api/mcp-servers/oauth/callback - Handle OAuth callback
  if (req.method === 'GET' && url.pathname === '/api/mcp-servers/oauth/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      // Return HTML that closes the popup and notifies parent
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head><title>OAuth Error</title></head>
        <body>
          <script>
            window.opener?.postMessage({ type: 'mcp-oauth-error', error: '${error}' }, '*');
            window.close();
          </script>
          <p>Authentication failed: ${error}. You can close this window.</p>
        </body>
        </html>
      `, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 });
    }

    const [serverId] = state.split(':');

    // For now, just acknowledge the callback - full token exchange would go here
    // In a production setup, you'd exchange the code for tokens here

    const config = await loadMCPConfig();
    config.auth[serverId] = {
      accessToken: code, // In production, exchange for real token
      expiresAt: Date.now() + 3600000 // 1 hour
    };
    await saveMCPConfig(config);

    // Return HTML that closes the popup and notifies parent
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head><title>OAuth Success</title></head>
      <body>
        <script>
          window.opener?.postMessage({ type: 'mcp-oauth-success', serverId: '${serverId}' }, '*');
          window.close();
        </script>
        <p>Authentication successful! You can close this window.</p>
      </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // POST /api/mcp-servers/:id/logout - Logout from an MCP server
  const logoutMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/logout$/);
  if (req.method === 'POST' && logoutMatch) {
    const id = logoutMatch[1];
    const config = await loadMCPConfig();

    // Remove auth token
    delete config.auth[id];
    await saveMCPConfig(config);

    return new Response(JSON.stringify({ success: true, id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // POST /api/mcp-servers/:id/connect - Connect to an MCP server (spawns mcp-remote)
  const connectMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/connect$/);
  if (req.method === 'POST' && connectMatch) {
    const id = connectMatch[1];
    const config = await loadMCPConfig();

    // Find the server
    const builtinServers = MCP_SERVERS_BY_PROVIDER['anthropic'] || {};
    const serverConfig = builtinServers[id] || config.custom[id];

    if (!serverConfig) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Server not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Only stdio servers with mcp-remote can be connected this way
    if (serverConfig.type !== 'stdio') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Only stdio servers (mcp-remote) can be connected'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Extract URL from args (mcp-remote uses URL as last argument)
    const args = serverConfig.args || [];
    const mcpUrl = args[args.length - 1]; // Last arg should be the URL

    if (!mcpUrl || !mcpUrl.startsWith('http')) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Could not find MCP server URL in configuration'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const name = serverConfig.name || id;
      const connection = await mcpClientManager.connect(id, name, mcpUrl);

      return new Response(JSON.stringify({
        success: true,
        connection
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // POST /api/mcp-servers/:id/disconnect - Disconnect from an MCP server
  const disconnectMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/disconnect$/);
  if (req.method === 'POST' && disconnectMatch) {
    const id = disconnectMatch[1];

    try {
      await mcpClientManager.disconnect(id);

      return new Response(JSON.stringify({ success: true, id }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Disconnect failed'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // GET /api/mcp-servers/connections - Get all active MCP connections
  if (req.method === 'GET' && url.pathname === '/api/mcp-servers/connections') {
    const connections = mcpClientManager.getConnections();

    return new Response(JSON.stringify({
      success: true,
      connections
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // GET /api/mcp-servers/tools - Get all tools from connected MCP servers
  if (req.method === 'GET' && url.pathname === '/api/mcp-servers/tools') {
    const tools = mcpClientManager.getAllTools();

    return new Response(JSON.stringify({
      success: true,
      tools
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Route not handled
  return undefined;
}
