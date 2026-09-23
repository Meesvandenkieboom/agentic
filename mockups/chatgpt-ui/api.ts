import { sessions, messages } from './fixtures';
import type { Session } from '../../client/hooks/useSessionAPI';

const json = (value: unknown, status = 200) => Response.json(value, { status });
const unsupported = () => json({ error: 'This action is not connected in the UI preview.' }, 501);

export async function mockApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/sessions/active-streams') return json({ sessionIds: [] });
  if (path === '/api/user-config') return json({ displayName: 'Developer' });
  if (path === '/api/github/status') return json({ connected: false });
  if (path === '/api/agents') return json({ success: true, agents: [] });
  if (path === '/api/skills') return json({ success: true, skills: [], mode: 'inherit' });
  if (path === '/api/mcp-servers') return json({ success: true, servers: [] });
  if (path === '/api/mcp-servers/connections') return json({ success: true, connections: [] });
  if (path === '/api/notifications/telegram' && method === 'GET') return json({ enabled: false, userId: '', finished: true, errors: true, questions: true, hasToken: false, lastError: null });
  if (path === '/api/sessions/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const filter = url.searchParams.get('filter');
    const results = ['files', 'images'].includes(filter || '') ? [] : sessions.flatMap(session => {
      const history = messages.get(session.id) || [];
      const match = history.find(message => message.content.toLowerCase().includes(query));
      if (query && !session.title.toLowerCase().includes(query) && !match) return [];
      return [{ id: session.id, kind: 'chat', sessionId: session.id, title: session.title, updatedAt: session.updated_at,
        preview: history[0]?.content || 'No messages yet' }];
    });
    return json({ results, hasMore: false, hasOlder: false });
  }
  if (path === '/api/sessions') {
    if (method === 'GET') return json({ sessions });
    if (method === 'POST') {
      const body = await request.json();
      const now = new Date().toISOString();
      const session: Session = {
        id: crypto.randomUUID(), title: body.title || 'New Chat', created_at: now, updated_at: now,
        message_count: 0, mode: body.mode || 'general', model: body.model || 'codex-6-sol',
        permission_mode: 'bypassPermissions', working_directory: body.workingDirectory || '/projects/agentic',
        workspace_status: 'ready', workspace_origin: 'managed',
      };
      sessions.unshift(session);
      messages.set(session.id, []);
      return json(session);
    }
  }
  const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const [, id, action] = match;
    const session = sessions.find(item => item.id === id);
    if (!session) return json({ error: 'Preview session not found' }, 404);
    if (!action && method === 'DELETE') {
      sessions.splice(sessions.indexOf(session), 1);
      messages.delete(id);
      return json({ success: true });
    }
    if (action === 'messages') return json(messages.get(id) || []);
    if (action === 'commands') return json({ commands: [{ name: 'review', description: 'Review the current changes', argumentHint: '' }, { name: 'compact', description: 'Compact the conversation', argumentHint: '' }] });
    if (action === 'question') return json({ question: null });
    if (action === 'branches') return json({ branches: sessions.filter(item => item.parent_session_id === id) });
    if (action === 'parent') return json({ parent: sessions.find(item => item.id === session.parent_session_id) || null });
    if (action === 'tree') return json({ parent: null, current: session, siblings: [], children: [] });
    if (action === 'export') return json({ session, messages: messages.get(id) || [] });
    if (action === 'branch' && method === 'POST') {
      const body = await request.json();
      const branch = { ...session, id: crypto.randomUUID(), title: body.title || `${session.title} (branch)`, parent_session_id: id, model: body.model || session.model };
      sessions.unshift(branch);
      const history = messages.get(id) || [];
      const index = history.findIndex(message => message.id === body.messageId);
      messages.set(branch.id, history.slice(0, index < 0 ? undefined : index + 1).map(message => ({ ...message, session_id: branch.id })));
      return json({ success: true, session: branch });
    }
    if (method === 'PATCH') {
      const body = await request.json();
      if (action === 'pin') { session.pinned_at = body.pinned ? new Date().toISOString() : null; return json({ pinnedAt: session.pinned_at }); }
      if (action === 'title') session.title = body.title;
      else if (action === 'mode') session.permission_mode = body.mode;
      else if (action === 'model') session.model = body.model;
      else if (action === 'directory') session.working_directory = body.workingDirectory;
      else if (action === 'github') session.github_repo = body.githubRepo;
      else return unsupported();
      return json({ success: true, session });
    }
  }
  return unsupported();
}
