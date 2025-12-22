/**
 * Agent Smith - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Power, PowerOff, Loader2, Info, X, Globe, Terminal, ExternalLink, CheckCircle2, XCircle, Plug2, KeyRound, Link, Unlink, Wrench } from 'lucide-react';
import { toast } from '../../utils/toast';

interface MCPServer {
  id: string;
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  builtin: boolean;
  status?: 'connected' | 'disconnected' | 'error' | 'needs-auth';
  authenticated?: boolean;
  authProvider?: string; // e.g., 'atlassian', 'figma', etc.
}

interface MCPConnection {
  id: string;
  name: string;
  url: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  pid?: number;
  tools?: Array<{ name: string; description: string }>;
  error?: string;
  connectedAt?: number;
}

type ServerType = 'http' | 'stdio';

export function MCPServersTab() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [connections, setConnections] = useState<MCPConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [serverType, setServerType] = useState<ServerType>('http');
  const [newServer, setNewServer] = useState({
    id: '',
    name: '',
    url: '',
    command: '',
    args: '',
    headers: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  useEffect(() => {
    loadServers();
    loadConnections();

    // Poll for connection status updates every 5 seconds
    const interval = setInterval(loadConnections, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadServers = async () => {
    try {
      const response = await fetch('/api/mcp-servers');
      const data = await response.json();
      if (data.success) {
        setServers(data.servers);
      }
    } catch (error) {
      console.error('Failed to load MCP servers:', error);
      toast.error('Failed to load MCP servers');
    } finally {
      setIsLoading(false);
    }
  };

  const loadConnections = async () => {
    try {
      const response = await fetch('/api/mcp-servers/connections');
      const data = await response.json();
      if (data.success) {
        setConnections(data.connections);
      }
    } catch (error) {
      console.error('Failed to load MCP connections:', error);
    }
  };

  // Helper to get connection status for a server
  const getConnectionForServer = (serverId: string): MCPConnection | undefined => {
    return connections.find(c => c.id === serverId);
  };

  const handleToggle = async (id: string) => {
    try {
      const response = await fetch(`/api/mcp-servers/${id}/toggle`, {
        method: 'POST',
      });
      const data = await response.json();
      if (data.success) {
        setServers(servers.map(server =>
          server.id === id ? { ...server, enabled: data.enabled } : server
        ));
        toast.success(
          data.enabled ? 'Server enabled' : 'Server disabled',
          { description: id }
        );
      }
    } catch (error) {
      console.error('Failed to toggle server:', error);
      toast.error('Failed to toggle server');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Are you sure you want to delete the MCP server "${id}"?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/mcp-servers/${id}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (data.success) {
        setServers(servers.filter(server => server.id !== id));
        toast.success('MCP server deleted', { description: id });
      } else {
        toast.error('Failed to delete server', { description: data.error });
      }
    } catch (error) {
      console.error('Failed to delete server:', error);
      toast.error('Failed to delete server');
    }
  };

  const handleTestConnection = async (id: string) => {
    setTestingId(id);
    try {
      const response = await fetch(`/api/mcp-servers/${id}/test`, {
        method: 'POST',
      });
      const data = await response.json();
      if (data.success) {
        if (data.needsAuth) {
          // Server reachable but needs OAuth
          setServers(servers.map(server =>
            server.id === id ? { ...server, status: 'needs-auth' } : server
          ));
          toast.success('Server reachable', { description: 'OAuth login will be required when used' });
        } else {
          setServers(servers.map(server =>
            server.id === id ? { ...server, status: 'connected' } : server
          ));
          toast.success('Connection successful', { description: id });
        }
      } else {
        setServers(servers.map(server =>
          server.id === id ? { ...server, status: 'error' } : server
        ));
        toast.error('Connection failed', { description: data.error || 'Unknown error' });
      }
    } catch (error) {
      console.error('Failed to test connection:', error);
      setServers(servers.map(server =>
        server.id === id ? { ...server, status: 'error' } : server
      ));
      toast.error('Connection test failed');
    } finally {
      setTestingId(null);
    }
  };

  const handleConnect = async (id: string) => {
    setConnectingId(id);
    try {
      toast.info('Connecting...', {
        description: 'A browser window may open for authentication'
      });

      const response = await fetch(`/api/mcp-servers/${id}/connect`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        const conn = data.connection as MCPConnection;
        if (conn.status === 'connected') {
          const toolCount = conn.tools?.length || 0;
          toast.success('Connected!', {
            description: `${toolCount} tools available`
          });
        } else if (conn.status === 'connecting') {
          toast.info('Connecting...', {
            description: 'Check your browser for authentication'
          });
        } else if (conn.status === 'error') {
          toast.error('Connection failed', { description: conn.error });
        }
        await loadConnections();
      } else {
        toast.error('Connection failed', { description: data.error || 'Unknown error' });
      }
    } catch (error) {
      console.error('Failed to connect:', error);
      toast.error('Connection failed');
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      const response = await fetch(`/api/mcp-servers/${id}/disconnect`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        toast.success('Disconnected', { description: id });
        await loadConnections();
      } else {
        toast.error('Disconnect failed', { description: data.error });
      }
    } catch (error) {
      console.error('Failed to disconnect:', error);
      toast.error('Disconnect failed');
    }
  };

  const handleAddServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const serverConfig: Record<string, unknown> = {
        id: newServer.id,
        name: newServer.name || newServer.id,
        type: serverType,
      };

      if (serverType === 'http') {
        serverConfig.url = newServer.url;
        if (newServer.headers.trim()) {
          try {
            serverConfig.headers = JSON.parse(newServer.headers);
          } catch {
            toast.error('Invalid headers JSON format');
            setIsSubmitting(false);
            return;
          }
        }
      } else {
        serverConfig.command = newServer.command;
        if (newServer.args.trim()) {
          serverConfig.args = newServer.args.split(',').map(a => a.trim()).filter(Boolean);
        }
      }

      const response = await fetch('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverConfig),
      });

      const data = await response.json();
      if (data.success) {
        toast.success('MCP server added', { description: newServer.id });
        setNewServer({ id: '', name: '', url: '', command: '', args: '', headers: '' });
        setShowAddForm(false);
        await loadServers();
      } else {
        toast.error('Failed to add server', { description: data.error });
      }
    } catch (error) {
      console.error('Failed to add server:', error);
      toast.error('Failed to add server');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getStatusIcon = (server: MCPServer) => {
    const conn = getConnectionForServer(server.id);

    if (conn?.status === 'connected') {
      return <CheckCircle2 size={16} className="text-green-400" title={`Connected - ${conn.tools?.length || 0} tools`} />;
    }
    if (conn?.status === 'connecting') {
      return <Loader2 size={16} className="text-blue-400 animate-spin" title="Connecting..." />;
    }
    if (conn?.status === 'error') {
      return <XCircle size={16} className="text-red-400" title={conn.error || 'Connection error'} />;
    }

    // Fallback to server status
    switch (server.status) {
      case 'connected':
        return <CheckCircle2 size={16} className="text-green-400" title="Connected" />;
      case 'needs-auth':
        return <KeyRound size={16} className="text-amber-400" title="Needs connection" />;
      case 'error':
        return <XCircle size={16} className="text-red-400" title="Connection error" />;
      default:
        return null;
    }
  };

  // Check if server supports connect (stdio servers with mcp-remote)
  const canConnect = (server: MCPServer): boolean => {
    if (server.type !== 'stdio') return false;
    const args = server.args?.join(' ') || '';
    return args.includes('mcp-remote');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Info banner */}
      <div className="mb-4 p-3 bg-purple-500/10 border border-purple-500/20 rounded-lg flex gap-3">
        <Info size={20} className="text-purple-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-gray-300">
          <p className="font-medium text-purple-300 mb-1">MCP Server Integrations</p>
          <p>
            Connect external tools and services via the Model Context Protocol (MCP).
            For OAuth-protected servers (Atlassian, Figma), use <strong>Stdio</strong> type with <code className="bg-white/10 px-1 rounded">mcp-remote</code>.
          </p>
          <a
            href="https://modelcontextprotocol.io/introduction"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-purple-400 hover:text-purple-300 mt-2"
          >
            Learn more about MCP <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {/* Quick setup cards for popular servers */}
      <div className="mb-4 grid grid-cols-2 gap-2">
        <button
          onClick={() => {
            setServerType('stdio');
            setNewServer({
              id: 'atlassian',
              name: 'Atlassian (Jira & Confluence)',
              url: '',
              command: 'npx',
              args: '-y, mcp-remote, https://mcp.atlassian.com/v1/sse',
              headers: ''
            });
            setShowAddForm(true);
          }}
          className="flex items-center gap-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 transition-colors text-left"
        >
          <div className="p-2 bg-blue-500/20 rounded-lg">
            <Globe size={18} className="text-blue-400" />
          </div>
          <div>
            <p className="font-medium text-blue-300 text-sm">Atlassian</p>
            <p className="text-xs text-gray-500">Jira & Confluence</p>
          </div>
        </button>
        <button
          onClick={() => {
            setServerType('stdio');
            setNewServer({
              id: 'figma',
              name: 'Figma',
              url: '',
              command: 'npx',
              args: '-y, mcp-remote, https://mcp.figma.com/mcp',
              headers: ''
            });
            setShowAddForm(true);
          }}
          className="flex items-center gap-3 p-3 bg-pink-500/10 border border-pink-500/20 rounded-lg hover:bg-pink-500/20 transition-colors text-left"
        >
          <div className="p-2 bg-pink-500/20 rounded-lg">
            <Globe size={18} className="text-pink-400" />
          </div>
          <div>
            <p className="font-medium text-pink-300 text-sm">Figma</p>
            <p className="text-xs text-gray-500">Design files & FigJam</p>
          </div>
        </button>
      </div>

      {/* Server list */}
      <div className="space-y-2 mb-4">
        {servers.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Plug2 className="mx-auto mb-2 opacity-50" size={32} />
            <p>No MCP servers configured</p>
            <p className="text-sm">Add a server to extend Claude&apos;s capabilities</p>
          </div>
        ) : (
          servers.map((server) => {
            const conn = getConnectionForServer(server.id);
            const isConnected = conn?.status === 'connected';
            const isConnecting = conn?.status === 'connecting' || connectingId === server.id;

            return (
            <div
              key={server.id}
              className="flex flex-col gap-2 p-3 bg-white/5 rounded-lg border border-white/10 hover:bg-white/[0.07] transition-colors"
            >
              <div className="flex items-start gap-3">
                {/* Type icon */}
                <div className={`p-2 rounded-lg ${server.type === 'http' ? 'bg-blue-500/20' : 'bg-orange-500/20'}`}>
                  {server.type === 'http' ? (
                    <Globe size={18} className="text-blue-400" />
                  ) : (
                    <Terminal size={18} className="text-orange-400" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-gray-100">{server.name || server.id}</span>
                    {server.builtin && (
                      <span className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-full">
                        Built-in
                      </span>
                    )}
                    {getStatusIcon(server)}
                  </div>
                  <p className="text-sm text-gray-400 truncate">
                    {server.type === 'http' ? server.url : `${server.command} ${server.args?.join(' ') || ''}`}
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Test connection button (for HTTP servers) */}
                  {server.type === 'http' && (
                    <button
                      onClick={() => handleTestConnection(server.id)}
                      disabled={testingId === server.id}
                      className="px-3 py-1.5 rounded-lg text-sm bg-white/5 text-gray-300 hover:bg-white/10 transition-colors disabled:opacity-50"
                      title="Test connection"
                    >
                      {testingId === server.id ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        'Test'
                      )}
                    </button>
                  )}

                  {/* Connect/Disconnect button for mcp-remote servers */}
                  {canConnect(server) && (
                    isConnected ? (
                      <button
                        onClick={() => handleDisconnect(server.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                        title="Disconnect"
                      >
                        <Unlink size={14} />
                        <span>Disconnect</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleConnect(server.id)}
                        disabled={isConnecting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
                        title="Connect (opens browser for OAuth)"
                      >
                        {isConnecting ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Link size={14} />
                        )}
                        <span>{isConnecting ? 'Connecting...' : 'Connect'}</span>
                      </button>
                    )
                  )}

                  {/* Toggle button */}
                  <button
                    onClick={() => handleToggle(server.id)}
                    className={`p-2 rounded-lg transition-colors ${
                      server.enabled
                        ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        : 'bg-gray-500/20 text-gray-400 hover:bg-gray-500/30'
                    }`}
                    title={server.enabled ? 'Disable server' : 'Enable server'}
                  >
                    {server.enabled ? (
                      <Power size={18} />
                    ) : (
                      <PowerOff size={18} />
                    )}
                  </button>

                  {/* Delete button (only for custom servers) */}
                  {!server.builtin && (
                    <button
                      onClick={() => handleDelete(server.id)}
                      className="p-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                      title="Delete server"
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </div>
              </div>

              {/* Show available tools when connected */}
              {isConnected && conn.tools && conn.tools.length > 0 && (
                <div className="ml-11 pl-3 border-l border-white/10">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
                    <Wrench size={12} />
                    <span>{conn.tools.length} tools available</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {conn.tools.slice(0, 6).map((tool) => (
                      <span
                        key={tool.name}
                        className="text-xs px-2 py-0.5 bg-white/5 text-gray-400 rounded"
                        title={tool.description}
                      >
                        {tool.name}
                      </span>
                    ))}
                    {conn.tools.length > 6 && (
                      <span className="text-xs px-2 py-0.5 text-gray-500">
                        +{conn.tools.length - 6} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
          })
        )}
      </div>

      {/* Add server section */}
      {!showAddForm ? (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full flex items-center justify-center gap-2 p-3 border-2 border-dashed border-white/20 rounded-lg text-gray-400 hover:text-gray-300 hover:border-white/30 transition-colors"
        >
          <Plus size={20} />
          <span>Add MCP Server</span>
        </button>
      ) : (
        <div className="p-4 bg-white/5 rounded-lg border border-white/10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-100">Add MCP Server</h3>
            <button
              onClick={() => {
                setShowAddForm(false);
                setNewServer({ id: '', name: '', url: '', command: '', args: '', headers: '' });
              }}
              className="text-gray-400 hover:text-gray-300"
            >
              <X size={18} />
            </button>
          </div>

          {/* Server type toggle */}
          <div className="flex gap-2 mb-4">
            <button
              type="button"
              onClick={() => setServerType('http')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg transition-colors ${
                serverType === 'http'
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  : 'bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10'
              }`}
            >
              <Globe size={18} />
              <span>HTTP Server</span>
            </button>
            <button
              type="button"
              onClick={() => setServerType('stdio')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg transition-colors ${
                serverType === 'stdio'
                  ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
                  : 'bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10'
              }`}
            >
              <Terminal size={18} />
              <span>Stdio Server</span>
            </button>
          </div>

          <form onSubmit={handleAddServer} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-300 mb-1">
                  Server ID <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={newServer.id}
                  onChange={(e) => setNewServer({ ...newServer, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  placeholder="my-mcp-server"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-white/20"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  value={newServer.name}
                  onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                  placeholder="My MCP Server"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-white/20"
                />
              </div>
            </div>

            {serverType === 'http' ? (
              <>
                <div>
                  <label className="block text-sm text-gray-300 mb-1">
                    Server URL <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="url"
                    value={newServer.url}
                    onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
                    placeholder="https://mcp.example.com"
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-white/20"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-300 mb-1">
                    Headers (optional, JSON)
                  </label>
                  <textarea
                    value={newServer.headers}
                    onChange={(e) => setNewServer({ ...newServer, headers: e.target.value })}
                    placeholder={'{"Authorization": "Bearer YOUR_TOKEN"}'}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-white/20 min-h-[60px] resize-y font-mono text-sm"
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="block text-sm text-gray-300 mb-1">
                    Command <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={newServer.command}
                    onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                    placeholder="npx"
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-white/20"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-300 mb-1">
                    Arguments (optional, comma-separated)
                  </label>
                  <input
                    type="text"
                    value={newServer.args}
                    onChange={(e) => setNewServer({ ...newServer, args: e.target.value })}
                    placeholder="-y, @modelcontextprotocol/server-everything"
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-white/20"
                  />
                </div>
              </>
            )}

            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>
                    <Plus size={18} />
                    Add Server
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
