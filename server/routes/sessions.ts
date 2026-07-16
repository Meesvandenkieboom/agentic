/**
 * Session API Routes
 * Handles all session-related REST endpoints
 */

import { sessionDb } from "../database";
import { backgroundProcessManager } from "../backgroundProcessManager";
import { sessionStreamManager } from "../sessionStreamManager";
import { setupSessionCommands } from "../commandSetup";
import { normalizeModelId } from "../../client/config/models";

/**
 * Handle session-related API routes
 * Returns Response if route was handled, undefined otherwise
 */
export async function handleSessionRoutes(
  req: Request,
  url: URL,
  activeQueries: Map<string, unknown>
): Promise<Response | undefined> {

  // GET /api/sessions - List all sessions
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const { sessions, recreatedDirectories } = sessionDb.getSessions();

    return new Response(JSON.stringify({
      sessions,
      warning: recreatedDirectories.length > 0
        ? `Recreated ${recreatedDirectories.length} missing director${recreatedDirectories.length === 1 ? 'y' : 'ies'}`
        : undefined
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/sessions - Create new session
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await req.json() as { title?: string; workingDirectory?: string; mode?: 'general' | 'coder' | 'intense-research' | 'spark'; githubRepo?: string; model?: string };
    const session = sessionDb.createSession(body.title || 'New Chat', body.workingDirectory, body.mode || 'general', body.githubRepo, normalizeModelId(body.model));
    return new Response(JSON.stringify(session), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/sessions/active-streams - Get all sessions with active SDK streams
  if (url.pathname === '/api/sessions/active-streams' && req.method === 'GET') {
    const sessionIds = sessionStreamManager.getActiveSessionIds();
    return new Response(JSON.stringify({ sessionIds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/sessions/:id - Get session by ID
  if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/').pop()!;
    const session = sessionDb.getSession(sessionId);

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(session), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // DELETE /api/sessions/:id - Delete session
  if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && req.method === 'DELETE') {
    const sessionId = url.pathname.split('/').pop()!;

    // Clean up background processes for this session before deleting
    await backgroundProcessManager.cleanupSession(sessionId);

    // Clean up SDK stream (aborts subprocess, completes message queue)
    sessionStreamManager.cleanupSession(sessionId, 'session_deleted');

    // Also delete the query
    activeQueries.delete(sessionId);

    const success = sessionDb.deleteSession(sessionId);

    return new Response(JSON.stringify({ success }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/sessions/:id/messages - Get session messages
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/messages$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[3];
    const messages = sessionDb.getSessionMessages(sessionId);

    return new Response(JSON.stringify(messages), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // PATCH /api/sessions/:id/directory - Update working directory
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/directory$/) && req.method === 'PATCH') {
    const sessionId = url.pathname.split('/')[3];
    const body = await req.json() as { workingDirectory: string };

    console.log('📁 API: Update working directory request:', {
      sessionId,
      directory: body.workingDirectory
    });

    const success = sessionDb.updateWorkingDirectory(sessionId, body.workingDirectory);

    if (success) {
      // Get updated session to retrieve mode
      const session = sessionDb.getSession(sessionId);

      if (session) {
        const paths = sessionDb.getRuntimePaths(sessionId);
        if (paths) setupSessionCommands(paths.metadata, session.mode);
      }

      // Clear SDK session ID to prevent resume with old directory's transcript files
      sessionDb.updateSdkSessionId(sessionId, null);

      // Cleanup SDK stream to force respawn with new cwd on next message
      sessionStreamManager.cleanupSession(sessionId, 'directory_changed');
      activeQueries.delete(sessionId);

      console.log(`🔄 SDK subprocess will restart with new cwd on next message (no resume)`);

      return new Response(JSON.stringify({ success: true, session }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Invalid directory or session not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // PATCH /api/sessions/:id/mode - Update permission mode
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/mode$/) && req.method === 'PATCH') {
    const sessionId = url.pathname.split('/')[3];
    const body = await req.json() as { mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' };

    const success = sessionDb.updatePermissionMode(sessionId, body.mode);

    if (success) {
      const session = sessionDb.getSession(sessionId);
      return new Response(JSON.stringify({ success: true, session }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Session not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // PATCH /api/sessions/:id/github - Update GitHub repo
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/github$/) && req.method === 'PATCH') {
    const sessionId = url.pathname.split('/')[3];
    const body = await req.json() as { githubRepo: string | null };

    console.log('🐙 API: Update GitHub repo request:', {
      sessionId,
      githubRepo: body.githubRepo
    });

    const success = sessionDb.updateGithubRepo(sessionId, body.githubRepo);

    if (success) {
      const session = sessionDb.getSession(sessionId);

      // Clear SDK session ID to force respawn with new system prompt
      sessionDb.updateSdkSessionId(sessionId, null);

      // Cleanup SDK stream to force respawn with updated GitHub context
      sessionStreamManager.cleanupSession(sessionId, 'github_repo_changed');
      activeQueries.delete(sessionId);

      console.log(`🔄 SDK subprocess will restart with GitHub context on next message`);

      return new Response(JSON.stringify({ success: true, session }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Session not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // PATCH /api/sessions/:id/title - Rename session title only (no folder change)
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/title$/) && req.method === 'PATCH') {
    const sessionId = url.pathname.split('/')[3];
    const body = await req.json() as { title: string };
    const newTitle = body.title?.trim();

    if (!newTitle || newTitle.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Title cannot be empty' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (newTitle.length > 60) {
      return new Response(JSON.stringify({ success: false, error: 'Title must be 60 characters or less' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const success = sessionDb.renameSession(sessionId, newTitle);

    if (success) {
      const session = sessionDb.getSession(sessionId);
      return new Response(JSON.stringify({ success: true, session }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Session not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ========== EXPORT / IMPORT ROUTES ==========

  // GET /api/sessions/:id/export - Download session as portable JSON
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/export$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[3];
    const session = sessionDb.getSession(sessionId);

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const messages = sessionDb.getSessionMessages(sessionId);
    const exportData = {
      format: 'agentic-chat',
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        title: session.title,
        mode: session.mode,
        permission_mode: session.permission_mode,
        model: session.model || null,
        github_repo: session.github_repo || null,
        created_at: session.created_at,
      },
      messages: messages.map(m => ({ type: m.type, content: m.content, timestamp: m.timestamp })),
    };

    const safeName = session.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'chat';
    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${safeName}.agentic.json"`,
      },
    });
  }

  // POST /api/sessions/import - Create a new session from an exported chat file
  if (url.pathname === '/api/sessions/import' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Invalid JSON file' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = body as { format?: string; session?: Record<string, unknown>; messages?: unknown };
    if (data?.format !== 'agentic-chat' || !data.session || !Array.isArray(data.messages)) {
      return new Response(JSON.stringify({ success: false, error: 'Not a valid Agentic chat export' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = sessionDb.importSession(data as Parameters<typeof sessionDb.importSession>[0]);

    if (session) {
      return new Response(JSON.stringify({ success: true, session }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: false, error: 'Failed to import chat' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ========== BRANCHING ROUTES ==========

  // POST /api/sessions/:id/branch - Create branch from message
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/branch$/) && req.method === 'POST') {
    const sessionId = url.pathname.split('/')[3];
    const body = await req.json() as {
      messageId?: string;
      model?: string;
      title?: string;
    };

    console.log('🌿 API: Create branch request:', {
      sessionId,
      messageId: body.messageId,
      model: body.model,
      title: body.title
    });

    const branchedSession = sessionDb.createBranchedSession(
      sessionId,
      body.messageId,
      body.model,
      body.title
    );

    if (branchedSession) {
      return new Response(JSON.stringify({ success: true, session: branchedSession }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create branch. Ensure parent session and message exist.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/sessions/:id/branches - Get child branches
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/branches$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[3];
    const branches = sessionDb.getSessionBranches(sessionId);

    return new Response(JSON.stringify({ branches }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/sessions/:id/tree - Get full branch tree
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/tree$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[3];
    const tree = sessionDb.getBranchTree(sessionId);

    return new Response(JSON.stringify(tree), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // PATCH /api/sessions/:id/model - Update session model
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/model$/) && req.method === 'PATCH') {
    const sessionId = url.pathname.split('/')[3];
    const body = await req.json() as { model: string };

    const nextModel = normalizeModelId(body.model);

    console.log('🔄 API: Update session model:', {
      sessionId,
      model: nextModel
    });

    const success = sessionDb.updateSessionModel(sessionId, nextModel);

    if (success) {
      // Clear SDK session ID to force respawn with new model
      sessionDb.updateSdkSessionId(sessionId, null);

      // Cleanup SDK stream
      sessionStreamManager.cleanupSession(sessionId, 'model_changed');
      activeQueries.delete(sessionId);

      const session = sessionDb.getSession(sessionId);
      return new Response(JSON.stringify({ success: true, session }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Session not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/sessions/:id/parent - Get parent session
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/parent$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[3];
    const parent = sessionDb.getParentSession(sessionId);

    return new Response(JSON.stringify({ parent }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Route not handled by this module
  return undefined;
}
