import { sessionDb } from '../database';
import { sessionStreamManager } from '../sessionStreamManager';
import { processAttachments } from '../attachments';
import { getRuntimeSessionPaths } from '../sessionWorkspace';
import { decodeStoredMessage } from '../../shared/storedMessage';
import { MODEL_MAP } from '../websocket/types';
import { normalizeModelId } from '../../client/config/models';
import { geminiSessions } from '../providers/gemini';

/**
 * POST /api/sessions/:id/steer for Gemini chats: queue a follow-up into the running
 * `agy acp` session without interrupting in-flight tools or subagents.
 */
export async function handleGeminiSteerRoute(req: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (!match || req.method !== 'POST') return;
  const sessionId = match[1];
  const session = sessionDb.getSession(sessionId);
  const provider = session && MODEL_MAP[normalizeModelId(session.model)]?.provider;
  if (!session || provider !== 'gemini') return;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid input.' }, { status: 400 });
  const { content, turnId, clientMessageId } = body;
  if (typeof content !== 'string' && !Array.isArray(content)) return Response.json({ error: 'Missing message content.' }, { status: 400 });

  const stored = typeof content === 'string' ? content : JSON.stringify(content);
  const decoded = decodeStoredMessage(stored);
  if (!decoded.text.trim() && !decoded.attachments.length) return Response.json({ error: 'Message is empty.' }, { status: 400 });
  // A command name, not a path like "/var/log/app.log".
  if (/^\/[\w:-]+(\s|$)/.test(decoded.text.trimStart())) {
    return Response.json({ error: 'Slash commands can only be sent once Gemini finishes. Your draft has been kept.' }, { status: 409 });
  }

  const signal = sessionStreamManager.getAbortController(sessionId)?.signal;
  if (signal?.aborted || !geminiSessions.isActive(sessionId)) {
    return Response.json({ error: 'This turn has ended. Your draft has been kept.' }, { status: 409 });
  }
  if (typeof turnId !== 'string' || turnId !== geminiSessions.activeTurnId(sessionId)) {
    return Response.json({ error: 'The active turn changed. Your draft has been kept.' }, { status: 409 });
  }

  const { imagePaths, filePaths } = processAttachments(content, sessionId, getRuntimeSessionPaths(session).metadata);
  const prompt = [filePaths.map(p => `[File attached: ${p}]`).join('\n'), decoded.text].filter(Boolean).join('\n\n');
  const clientId = typeof clientMessageId === 'string' ? clientMessageId : undefined;

  try {
    geminiSessions.steer(sessionId, prompt, imagePaths, {
      turnId,
      clientMessageId: clientId,
      onDelivered: () => {
        const message = sessionDb.addMessage(sessionId, 'user', stored);
        sessionStreamManager.safeSend(sessionId, JSON.stringify({
          type: 'session_message', sessionId, message, ...(clientId ? { clientMessageId: clientId } : {}),
        }));
      },
      onDropped: () => {
        if (!clientId) return;
        sessionStreamManager.safeSend(sessionId, JSON.stringify({
          type: 'queued_inputs_dropped', sessionId, clientMessageIds: [clientId],
        }));
      },
    });
    return Response.json({ accepted: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not send input to Gemini.' }, { status: 409 });
  }
}
