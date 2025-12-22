/**
 * Agent Smith - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Power, PowerOff, Loader2, Info, X, Globe, Terminal, ExternalLink, CheckCircle2, XCircle, Plug2, KeyRound, LogIn, LogOut as LogOutIcon } from 'lucide-react';
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

type ServerType = 'http' | 'stdio';

export function MCPServersTab() {
  const [servers, setServers] = useState<MCPServer[]>([]);
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
  const [loggingInId, setLoggingInId] = useState<string | null>(null);

  useEffect(() => {
    loadServers();

    // Listen for OAuth callback
    const handleOAuthCallback = (event: MessageEvent) => {
      if (event.data?.type === 'mcp-oauth-success') {
        const { serverId } = event.data;
        setServers(prev => prev.map(server =>
          server.id === serverId ? { ...server, authenticated: true, status: 'connected' } : server
        ));
        toast.success('Successfully logged in', { description: serverId });
        setLoggingInId(null);
        loadServers(); // Reload to get updated auth status
      } else if (event.data?.type === 'mcp-oauth-error') {
        toast.error('Login failed', { description: event.data.error });
        setLoggingInId(null);
      }
    };

    window.addEventListener('message', handleOAuthCallback);
    return () => window.removeEventListener('message', handleOAuthCallback);
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

  const handleLogin = async (id: string) => {
    setLoggingInId(id);
    try {
      const response = await fetch(`/api/mcp-servers/${id}/auth`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success && data.authUrl) {
        // Open OAuth popup
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        const popup = window.open(
          data.authUrl,
          'mcp-oauth',
          `width=${width},height=${height},left=${left},top=${top},popup=1`
        );

        // Check if popup was blocked
        if (!popup) {
          toast.error('Popup blocked', { description: 'Please allow popups for OAuth login' });
          setLoggingInId(null);
        }
      } else {
        toast.error('Failed to start login', { description: data.error || 'Unknown error' });
        setLoggingInId(null);
      }
    } catch (error) {
      console.error('Failed to start OAuth:', error);
      toast.error('Failed to start login');
      setLoggingInId(null);
    }
  };

  const handleLogout = async (id: string) => {
    try {
      const response = await fetch(`/api/mcp-servers/${id}/logout`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        setServers(servers.map(server =>
          server.id === id ? { ...server, authenticated: false, status: 'needs-auth' } : server
        ));
        toast.success('Logged out', { description: id });
      } else {
        toast.error('Failed to logout', { description: data.error });
      }
    } catch (error) {
      console.error('Failed to logout:', error);
      toast.error('Failed to logout');
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

  const getStatusIcon = (status?: MCPServer['status']) => {
    switch (status) {
      case 'connected':
        return <CheckCircle2 size={16} className="text-green-400" title="Connected" />;
      case 'needs-auth':
        return <KeyRound size={16} className="text-amber-400" title="Needs OAuth login" />;
      case 'error':
        return <XCircle size={16} className="text-red-400" title="Connection error" />;
      default:
        return null;
    }
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
            Add HTTP servers for web-based tools or stdio servers for local command-line tools.
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

      {/* Server list */}
      <div className="space-y-2 mb-4">
        {servers.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Plug2 className="mx-auto mb-2 opacity-50" size={32} />
            <p>No MCP servers configured</p>
            <p className="text-sm">Add a server to extend Claude&apos;s capabilities</p>
          </div>
        ) : (
          servers.map((server) => (
            <div
              key={server.id}
              className="flex items-start gap-3 p-3 bg-white/5 rounded-lg border border-white/10 hover:bg-white/[0.07] transition-colors"
            >
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
                  {getStatusIcon(server.status)}
                </div>
                <p className="text-sm text-gray-400 truncate">
                  {server.type === 'http' ? server.url : `${server.command} ${server.args?.join(' ') || ''}`}
                </p>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Test connection button */}
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

                {/* Login/Logout button - shows for servers needing OAuth */}
                {(server.status === 'needs-auth' || server.authenticated) && (
                  server.authenticated ? (
                    <button
                      onClick={() => handleLogout(server.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
                      title="Logout"
                    >
                      <LogOutIcon size={14} />
                      <span>Logout</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleLogin(server.id)}
                      disabled={loggingInId === server.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                      title="Login with OAuth"
                    >
                      {loggingInId === server.id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <LogIn size={14} />
                      )}
                      <span>{loggingInId === server.id ? 'Logging in...' : 'Login'}</span>
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
          ))
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
