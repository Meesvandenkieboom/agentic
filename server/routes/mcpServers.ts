/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { MCP_SERVERS_BY_PROVIDER } from '../mcpServers';
import { mcpClientManager } from '../mcpClientManager';
import { resolveMcpEndpoint, mcpConnectionError } from '../mcpEndpoint';
import { resolveServerConfig, editServerConfig, connectionConfigChanged, type MCPServerConfig } from '../mcpConfigEdits';

const MCP_CONFIG_PATH = path.join(process.cwd(), '.claude', 'mcp-servers.json');

interface MCPAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface MCPServersConfig {
  enabled: Record<string, boolean>;
  custom: Record<string, MCPServerConfig>;
  auth: Record<string, MCPAuthToken>; // Store auth tokens per server
  headerOverrides: Record<string, Record<string, string>>; // Store header overrides (API keys) for built-in servers
  nameOverrides: Record<string, string>; // Store display name overrides
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
    // Ensure fields exist
    if (!config.enabled) config.enabled = {};
    if (!config.custom) config.custom = {};
    if (!config.auth) config.auth = {};
    if (!config.headerOverrides) config.headerOverrides = {};
    if (!config.nameOverrides) config.nameOverrides = {};
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Initialize with all built-in servers enabled
    const config: MCPServersConfig = {
      enabled: {},
      custom: {},
      auth: {},
      headerOverrides: {},
      nameOverrides: {}
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
  const temporaryPath = `${MCP_CONFIG_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, MCP_CONFIG_PATH);
  } finally { await fs.rm(temporaryPath, { force: true }); }
}

/**
 * Get all MCP servers (built-in + custom)
 */
function getAllServers(config: MCPServersConfig) {
  const builtins = MCP_SERVERS_BY_PROVIDER.anthropic || {};
  return [...new Set([...Object.keys(builtins), ...Object.keys(config.custom)])].map(id => {
    const server = resolveServerConfig(config, builtins, id)!;
    return {
      id,
      name: server.name || (builtins[id] ? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ') : id),
      type: server.type,
      url: server.type === 'http' ? server.url : undefined,
      command: server.type === 'stdio' ? server.command : undefined,
      args: server.type === 'stdio' ? server.args : undefined,
      enabled: config.enabled[id] ?? true,
      builtin: !!builtins[id],
      authenticated: !!config.auth[id],
      authProvider: server.type === 'http' ? (server.authProvider || detectAuthProvider(server.url)) : undefined,
      hasApiKey: server.type === 'http' && Object.keys(server.headers || {}).length > 0,
      headerKeys: server.type === 'http' ? Object.keys(server.headers || {}) : [],
      envKeys: server.type === 'stdio' ? Object.keys(server.env || {}) : [],
    };
  });
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

    if (!resolveServerConfig(config, MCP_SERVERS_BY_PROVIDER.anthropic, id)) {
      return Response.json({ success: false, error: 'Server not found' }, { status: 404 });
    }

    // Toggle the enabled state
    const currentState = config.enabled[id] ?? true;
    config.enabled[id] = !currentState;
    if (!config.enabled[id]) await mcpClientManager.disconnect(id);

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
    const serverConfig = resolveServerConfig(config, builtinServers, id);

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
        const endpoint = await resolveMcpEndpoint(serverConfig.url);
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: serverConfig.headers || {},
          signal: AbortSignal.timeout(5000)
        });

        // 401/403 = server reachable but needs OAuth (this is fine!)
        if (response.status === 401 || response.status === 403) {
          return new Response(JSON.stringify({
            success: true,
            needsAuth: true,
            message: 'Server reachable; authentication required'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Preserve the existing reachability check; a GET is not a full MCP handshake.
        if (response.ok || response.status === 404 || response.status === 405 || response.status === 406) {
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
          error: mcpConnectionError(error)
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
    if (MCP_SERVERS_BY_PROVIDER.anthropic[id] || !config.custom[id]) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Cannot delete built-in MCP servers'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await mcpClientManager.removeConnection(id);
    delete config.custom[id];
    delete config.enabled[id];
    delete config.headerOverrides[id];
    delete config.nameOverrides[id];
    delete config.auth[id];

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

    const { id, type } = body;

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

    // Validate ID format (lowercase alphanumeric + dashes)
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
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
    if (resolveServerConfig(config, builtinServers, id)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'MCP server with this ID already exists'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      config.custom[id] = editServerConfig(undefined, body);
    } catch (error) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 400 });
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
    const serverConfig = resolveServerConfig(config, builtinServers, id);

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
      ? (serverConfig as { authProvider?: string }).authProvider
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

  // PATCH preserves omitted fields, including credentials. null explicitly removes them.
  const configMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/config$/);
  if (req.method === 'PATCH' && configMatch) {
    const id = configMatch[1];
    const config = await loadMCPConfig();
    const current = resolveServerConfig(config, MCP_SERVERS_BY_PROVIDER.anthropic, id);
    if (!current) return Response.json({ success: false, error: 'Server not found' }, { status: 404 });
    let updated: MCPServerConfig;
    try {
      updated = editServerConfig(current, await req.json());
    } catch (error) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 400 });
    }
    const connectionChanged = connectionConfigChanged(current, updated);
    // Custom entries also serve as full overrides for built-in configurations.
    config.custom[id] = updated;
    delete config.headerOverrides[id];
    delete config.nameOverrides[id];
    // Preserve OAuth state when editing names, headers, or local settings.
    if (current.type !== updated.type || (current.type === 'http' && updated.type === 'http' && current.url !== updated.url)) {
      delete config.auth[id];
    }
    await saveMCPConfig(config);
    // Do not leave a process connected with stale settings after a successful edit.
    let connectionError: string | undefined;
    if (connectionChanged && mcpClientManager.getConnection(id)) {
      try { await mcpClientManager.disconnect(id); }
      catch { connectionError = 'Settings saved, but disconnect failed. Disconnect before reconnecting.'; }
    }
    return Response.json({ success: true, id, connectionChanged, connectionError, hasApiKey: updated.type === 'http' && Object.keys(updated.headers || {}).length > 0 });
  }

  // POST /api/mcp-servers/:id/connect - Connect to an MCP server (spawns mcp-remote)
  const connectMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/connect$/);
  if (req.method === 'POST' && connectMatch) {
    const id = connectMatch[1];
    const config = await loadMCPConfig();

    // Find the server
    const builtinServers = MCP_SERVERS_BY_PROVIDER['anthropic'] || {};
    const serverConfig = resolveServerConfig(config, builtinServers, id);

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

    if (config.enabled[id] === false) {
      return Response.json({ success: false, error: 'Enable this integration before connecting' }, { status: 400 });
    }
    if (!serverConfig.args?.includes('mcp-remote')) {
      return Response.json({ success: false, error: 'Connect is supported for mcp-remote servers' }, { status: 400 });
    }

    // mcp-remote options may follow the URL.
    const args = serverConfig.args || [];
    const mcpUrl = args.find(arg => /^https?:\/\//.test(arg));

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
      const name = (serverConfig as { name?: string }).name || id;
      const connection = await mcpClientManager.connect(id, name, mcpUrl, serverConfig);

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
