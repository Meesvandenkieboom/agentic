/** MCP integration management: one editor for new and existing connections. */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  Loader2,
  Globe,
  Terminal,
  Plug2,
  Pencil,
  MoreHorizontal,
  Trash2,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from '../../utils/toast';
import { MCPServerForm, type MCPServer } from './MCPServerForm';

interface MCPConnection {
  id: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  tools?: Array<{ name: string; description: string }>;
  error?: string;
}
interface Feedback {
  status: string;
  error?: string;
  note?: string;
  retryAction?: 'test' | 'connect' | 'disconnect' | 'toggle' | 'delete';
}
const actionClass =
  'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-white/5 text-gray-200 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';
const menuClass =
  'flex items-center gap-2 px-3 py-2 text-sm rounded outline-none cursor-pointer data-[highlighted]:bg-white/10 data-[disabled]:opacity-40';
const blankServer: MCPServer = {
  id: '',
  name: '',
  type: 'http',
  enabled: true,
  builtin: false,
};
const supportsConnect = (server: MCPServer) =>
  server.type === 'stdio' && !!server.args?.includes('mcp-remote');

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/mcp-servers${path}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok || !data.success)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export function MCPServersTab({
  onEditStateChange,
}: {
  onEditStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [connections, setConnections] = useState<MCPConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [editor, setEditor] = useState<{
    server: MCPServer;
    isNew: boolean;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    onEditStateChange?.({ dirty, saving });
  }, [dirty, saving, onEditStateChange]);

  const loadServers = useCallback(async () => {
    try {
      const data = await request('');
      setServers(data.servers);
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const loadConnections = useCallback(async () => {
    try {
      const data = await request('/connections');
      setConnections(data.connections);
      setConnectionError('');
    } catch {
      setConnectionError('Connection status could not be refreshed.');
    }
  }, []);
  useEffect(() => {
    void loadServers();
    void loadConnections();
    const interval = setInterval(() => void loadConnections(), 5000);
    return () => clearInterval(interval);
  }, [loadServers, loadConnections]);

  const openEditor = (next: typeof editor) => {
    if (
      saving ||
      (dirty && !window.confirm('Discard your unsaved integration changes?'))
    )
      return;
    setDirty(false);
    setEditorKey((key) => key + 1);
    setEditor(next);
  };
  const setServerFeedback = (id: string, value: Feedback) =>
    setFeedback((prev) => ({ ...prev, [id]: value }));

  const connect = async (id: string) => {
    const data = await request(`/${encodeURIComponent(id)}/connect`, 'POST');
    if (data.connection.status === 'error')
      throw new Error(data.connection.error || 'Connection failed');
    setConnections((prev) => [
      ...prev.filter((conn) => conn.id !== id),
      data.connection,
    ]);
    setServerFeedback(id, {
      status:
        data.connection.status === 'connected' ? 'Connected' : 'Connecting…',
    });
  };

  const runAction = async (
    server: MCPServer,
    action: 'test' | 'connect' | 'disconnect' | 'toggle' | 'delete'
  ) => {
    const id = server.id;
    if (
      action === 'delete' &&
      !window.confirm(`Delete “${server.name}” and its saved credentials?`)
    )
      return;
    setBusy((prev) => ({ ...prev, [id]: action }));
    try {
      if (action === 'connect') {
        setServerFeedback(id, {
          status: 'Connecting…',
          note: 'Check your browser if authentication is requested.',
        });
        await connect(id);
      } else {
        const data = await request(
          `/${encodeURIComponent(id)}${action === 'delete' ? '' : `/${action}`}`,
          action === 'delete' ? 'DELETE' : 'POST'
        );
        if (action === 'test')
          setServerFeedback(id, {
            status: data.needsAuth ? 'Authentication required' : 'Reachable',
            note: data.needsAuth
              ? 'Update your credentials, or authenticate when the integration is used.'
              : 'The endpoint responded. Tool availability is checked when a chat connects.',
          });
        if (action === 'toggle') {
          setServers((prev) =>
            prev.map((item) =>
              item.id === id ? { ...item, enabled: data.enabled } : item
            )
          );
          setServerFeedback(id, {
            status: data.enabled ? 'Not checked' : 'Disabled',
            note: 'Start a new chat to use the updated enabled integrations.',
          });
        }
        if (action === 'disconnect')
          setServerFeedback(id, { status: 'Disconnected' });
        if (action === 'delete') {
          setServers((prev) => prev.filter((item) => item.id !== id));
          toast.success('Integration deleted');
        }
      }
      await loadConnections();
    } catch (e) {
      setServerFeedback(id, {
        status: 'Action failed',
        error: (e as Error).message,
        retryAction: action,
      });
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const save = async (
    id: string,
    body: Record<string, unknown>,
    reconnect: boolean
  ) => {
    setSaving(true);
    try {
      const data = await request(
        editor?.isNew ? '' : `/${encodeURIComponent(id)}/config`,
        editor?.isNew ? 'POST' : 'PATCH',
        editor?.isNew ? { ...body, id } : body
      );
      setEditor(null);
      setDirty(false);
      toast.success('Integration saved');
      setServerFeedback(id, {
        status: data.connectionChanged
          ? 'Not checked'
          : feedback[id]?.status || 'Not checked',
        error: data.connectionError,
        retryAction: data.connectionError ? 'disconnect' : undefined,
        note: data.connectionChanged
          ? 'Settings saved. Start a new chat to use them in the assistant.'
          : undefined,
      });
      if (reconnect && !data.connectionError) {
        setBusy((prev) => ({ ...prev, [id]: 'connect' }));
        try {
          await connect(id);
        } catch (e) {
          setServerFeedback(id, {
            status: 'Reconnect failed',
            error: `Settings saved, but reconnection failed: ${(e as Error).message}`,
            retryAction: 'connect',
          });
        } finally {
          setBusy((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }
      }
      await Promise.all([loadServers(), loadConnections()]);
    } finally {
      setSaving(false);
    }
  };

  const preset = (id: 'atlassian' | 'figma') => {
    const existing = servers.find((server) => server.id === id);
    openEditor({
      isNew: !existing,
      server:
        existing ||
        (id === 'atlassian'
          ? {
              ...blankServer,
              id,
              name: 'Atlassian',
              type: 'stdio',
              command: 'npx',
              args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse'],
            }
          : {
              ...blankServer,
              id,
              name: 'Figma',
              url: 'https://mcp.figma.com/mcp',
            }),
    });
  };

  if (loading)
    return (
      <div
        className="flex justify-center p-12"
        role="status"
        aria-label="Loading integrations"
      >
        <Loader2 className="animate-spin text-gray-400" />
      </div>
    );
  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-gray-100">Integrations</h2>
          <p className="text-sm text-gray-400 mt-1">
            Connect tools and services to your chats with MCP.
          </p>
        </div>
        <button
          disabled={saving}
          className={actionClass}
          onClick={() => openEditor({ server: blankServer, isNew: true })}
        >
          <Plus size={16} />
          Add integration
        </button>
      </div>
      {loadError && (
        <div role="alert" className="text-sm text-red-300">
          Could not load integrations: {loadError}{' '}
          <button className="underline" onClick={() => void loadServers()}>
            Retry
          </button>
        </div>
      )}
      {connectionError && (
        <div role="alert" className="text-sm text-amber-300">
          {connectionError}{' '}
          <button className="underline" onClick={() => void loadConnections()}>
            Retry
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="py-2 text-gray-500">Quick setup</span>
        <button
          disabled={saving}
          className={actionClass}
          onClick={() => preset('atlassian')}
        >
          Atlassian
        </button>
        <button
          disabled={saving}
          className={actionClass}
          onClick={() => preset('figma')}
        >
          Figma
        </button>
      </div>
      {editor?.isNew && (
        <MCPServerForm
          key={editorKey}
          server={editor.server}
          isNew
          onSave={save}
          onCancel={() => openEditor(null)}
          onDirtyChange={setDirty}
        />
      )}
      {!servers.length && !loadError && (
        <div className="text-center py-8 text-gray-500">
          <Plug2 className="mx-auto mb-2" size={28} />
          <p>No integrations yet. Add one above to get started.</p>
        </div>
      )}
      <div className="space-y-3">
        {servers.map((server) => {
          const conn = connections.find((item) => item.id === server.id);
          const message = feedback[server.id];
          const active = conn?.status === 'connected';
          const pending = !!busy[server.id] || conn?.status === 'connecting';
          const editing = editor?.server.id === server.id && !editor.isNew;
          const locked = pending || saving || editing;
          const status = !server.enabled
            ? 'Disabled'
            : pending
              ? busy[server.id] === 'test'
                ? 'Testing…'
                : busy[server.id] === 'connect' || conn?.status === 'connecting'
                  ? 'Connecting…'
                  : 'Updating…'
              : connectionError
                ? 'Status unavailable'
                : active
                  ? 'Connected'
                  : message?.status ||
                    (conn?.status === 'error'
                      ? 'Connection error'
                      : conn
                        ? 'Disconnected'
                        : 'Not checked');
          const error =
            message?.error ||
            (server.enabled && conn?.status === 'error'
              ? conn.error
              : undefined);
          const tools = conn?.tools || [];
          return (
            <section
              key={server.id}
              aria-label={server.name}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3"
            >
              <div className="flex flex-wrap items-start gap-3">
                <div
                  className={`p-2 rounded-lg ${server.type === 'http' ? 'bg-blue-500/15 text-blue-300' : 'bg-orange-500/15 text-orange-300'}`}
                >
                  {server.type === 'http' ? (
                    <Globe size={18} />
                  ) : (
                    <Terminal size={18} />
                  )}
                </div>
                <div className="flex-1 min-w-40">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-gray-100">{server.name}</h3>
                    {server.builtin && (
                      <span className="text-[11px] text-gray-500 rounded border border-white/10 px-1.5">
                        Built-in
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 break-all">
                    {server.type === 'http'
                      ? server.url
                      : `${server.command} ${server.args?.join(' ') || ''}`}
                  </p>
                  <p
                    className={`text-xs mt-2 flex items-center gap-1.5 ${!server.enabled ? 'text-gray-500' : error ? 'text-red-300' : active || status === 'Reachable' ? 'text-green-300' : 'text-gray-400'}`}
                  >
                    {pending && <Loader2 size={12} className="animate-spin" />}
                    {status}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={server.enabled}
                    aria-label={`Enable ${server.name}`}
                    disabled={locked}
                    onClick={() => void runAction(server, 'toggle')}
                    className="flex items-center gap-2 text-xs text-gray-400 disabled:opacity-40"
                  >
                    <span>{server.enabled ? 'Enabled' : 'Disabled'}</span>
                    <span
                      className={`flex items-center w-8 h-5 rounded-full p-0.5 ${server.enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
                    >
                      <span
                        className={`block w-4 h-4 rounded-full bg-white transition-transform ${server.enabled ? 'translate-x-3' : ''}`}
                      />
                    </span>
                  </button>
                  <button
                    disabled={saving || pending}
                    className={actionClass}
                    onClick={() =>
                      openEditor(editing ? null : { server, isNew: false })
                    }
                  >
                    <Pencil size={14} />
                    {editing ? 'Close' : 'Edit'}
                  </button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        aria-label={`More actions for ${server.name}`}
                        disabled={locked}
                        className={actionClass}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        sideOffset={6}
                        className="z-[100] min-w-44 rounded-lg border border-white/15 bg-gray-900 p-1 text-gray-200 shadow-xl"
                      >
                        {server.type === 'http' && (
                          <DropdownMenu.Item
                            disabled={!server.enabled}
                            className={menuClass}
                            onSelect={() => void runAction(server, 'test')}
                          >
                            <RefreshCw size={14} />
                            Test connection
                          </DropdownMenu.Item>
                        )}
                        {supportsConnect(server) && !active && (
                          <DropdownMenu.Item
                            disabled={!server.enabled}
                            className={menuClass}
                            onSelect={() => void runAction(server, 'connect')}
                          >
                            <Plug2 size={14} />
                            Connect
                          </DropdownMenu.Item>
                        )}
                        {active && (
                          <DropdownMenu.Item
                            className={menuClass}
                            onSelect={() =>
                              void runAction(server, 'disconnect')
                            }
                          >
                            <Unplug size={14} />
                            Disconnect
                          </DropdownMenu.Item>
                        )}
                        {!server.builtin && (
                          <DropdownMenu.Item
                            className={`${menuClass} text-red-300`}
                            onSelect={() => void runAction(server, 'delete')}
                          >
                            <Trash2 size={14} />
                            Delete integration
                          </DropdownMenu.Item>
                        )}
                        {server.builtin &&
                          server.type === 'stdio' &&
                          !supportsConnect(server) &&
                          !active && (
                            <DropdownMenu.Item disabled className={menuClass}>
                              Connects when a chat starts
                            </DropdownMenu.Item>
                          )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
              {error && (
                <div
                  role="alert"
                  className="text-sm text-red-300 flex flex-wrap gap-2 items-center"
                >
                  <span className="break-words min-w-0">{error}</span>
                  {(message?.retryAction ||
                    supportsConnect(server) ||
                    server.type === 'http') && (
                    <button
                      disabled={
                        locked ||
                        (!server.enabled &&
                          message?.retryAction !== 'toggle' &&
                          message?.retryAction !== 'delete')
                      }
                      className="underline"
                      onClick={() =>
                        void runAction(
                          server,
                          message?.retryAction ||
                            (supportsConnect(server) ? 'connect' : 'test')
                        )
                      }
                    >
                      Retry{' '}
                      {message?.retryAction ||
                        (supportsConnect(server) ? 'connection' : 'test')}
                    </button>
                  )}
                </div>
              )}
              {message?.note && (
                <p className="text-xs text-gray-400">{message.note}</p>
              )}
              {server.enabled &&
                server.type === 'stdio' &&
                !supportsConnect(server) &&
                !active && (
                  <p className="text-xs text-gray-500">
                    Connects when a new chat starts.
                  </p>
                )}
              {server.enabled &&
                supportsConnect(server) &&
                !active &&
                !error && (
                  <button
                    disabled={locked}
                    className={actionClass}
                    onClick={() => void runAction(server, 'connect')}
                  >
                    <Plug2 size={14} />
                    Connect
                  </button>
                )}
              {active && tools.length > 0 && (
                <div className="border-t border-white/10 pt-3 space-y-2">
                  <span className="text-xs text-gray-400">
                    {tools.length} tools available
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {(expanded[server.id] ? tools : tools.slice(0, 6)).map(
                      (tool) => (
                        <span
                          key={tool.name}
                          title={tool.description}
                          className="text-xs rounded bg-white/5 px-2 py-1 text-gray-300"
                        >
                          {tool.name}
                        </span>
                      )
                    )}
                  </div>
                  {tools.length > 6 && (
                    <button
                      aria-expanded={!!expanded[server.id]}
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [server.id]: !prev[server.id],
                        }))
                      }
                      className="text-xs text-blue-300 hover:underline"
                    >
                      {expanded[server.id]
                        ? 'Show fewer tools'
                        : `Show all ${tools.length} tools (+${tools.length - 6} more)`}
                    </button>
                  )}
                </div>
              )}
              {editing && (
                <MCPServerForm
                  key={editorKey}
                  server={editor.server}
                  onSave={save}
                  onCancel={() => openEditor(null)}
                  onDirtyChange={setDirty}
                />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
