import { randomUUID } from 'crypto';
import { sessionDb } from '../database';
import { sessionStreamManager, type MessageContent } from '../sessionStreamManager';
import { processAttachments } from '../attachments';
import { getRuntimeSessionPaths } from '../sessionWorkspace';
import { decodeStoredMessage } from '../../shared/storedMessage';
import { MODEL_MAP } from '../websocket/types';
import { normalizeModelId } from '../../client/config/models';

/**
 * POST /api/sessions/:id/steer for Claude chats: queue a follow-up into the running
 * turn without interrupting tools or subagents. Codex chats fall through to the Codex route.
 */
export async function handleClaudeSteerRoute(req: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (!match || req.method !== 'POST') return;
  const sessionId = match[1];
  const session = sessionDb.getSession(sessionId);
  if (!session || MODEL_MAP[normalizeModelId(session.model)]?.provider === 'codex') return;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid input.' }, { status: 400 });
  const { content, clientMessageId } = body;
  if (typeof content !== 'string' && !Array.isArray(content)) return Response.json({ error: 'Missing message content.' }, { status: 400 });

  const stored = typeof content === 'string' ? content : JSON.stringify(content);
  const decoded = decodeStoredMessage(stored);
  if (!decoded.text.trim() && !decoded.attachments.length) return Response.json({ error: 'Message is empty.' }, { status: 400 });
  // A command name, not a path like "/var/log/app.log".
  if (/^\/[\w:-]+(\s|$)/.test(decoded.text.trimStart())) {
    return Response.json({ error: 'Slash commands can only be sent once Claude finishes. Your draft has been kept.' }, { status: 409 });
  }
  // No awaits from here on, so Stop can't land between this check and queueing.
  const signal = sessionStreamManager.getAbortController(sessionId)?.signal;
  if (!signal || signal.aborted || !sessionStreamManager.isGenerating(sessionId)) {
    return Response.json({ error: 'Claude is not working on this chat right now. Your draft has been kept.' }, { status: 409 });
  }

  const { imageBlocks, filePaths } = processAttachments(content, sessionId, getRuntimeSessionPaths(session).metadata);
  const text = [filePaths.map(p => `[File attached: ${p}]`).join('\n'), decoded.text].filter(Boolean).join('\n\n');
  const messageContent: MessageContent = imageBlocks.length > 0
    ? [...imageBlocks, ...(text.trim() ? [{ type: 'text' as const, text }] : [])]
    : text;

  sessionStreamManager.queueInput(sessionId, messageContent, randomUUID(), {
    stored,
    clientMessageId: typeof clientMessageId === 'string' ? clientMessageId : undefined,
  });
  return Response.json({ accepted: true });
}
