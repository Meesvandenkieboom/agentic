import { sessionDb } from '../database';
import { sessionStreamManager } from '../sessionStreamManager';
import { processAttachments } from '../attachments';
import { getRuntimeSessionPaths } from '../sessionWorkspace';
import { decodeStoredMessage } from '../../shared/storedMessage';
import { codexSessions } from '../providers/codex';

/** Follow-ups and question replies have an acknowledgement; the composer keeps unaccepted drafts. */
export async function handleCodexRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(steer|question)$/);
  if (!match) return;
  const [, sessionId, action] = match;
  const session = sessionDb.getSession(sessionId);
  if (!session) return Response.json({ error: 'Chat not found.' }, { status: 404 });
  if (action === 'question' && req.method === 'GET') {
    return Response.json({ question: codexSessions.pendingQuestion(sessionId) });
  }
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  if (!codexSessions.isActive(sessionId)) return Response.json({ error: 'This turn has ended. Your draft has been kept.' }, { status: 409 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid input.' }, { status: 400 });
  const persistInput = (content: string) => {
    const message = sessionDb.addMessage(sessionId, 'user', content);
    sessionStreamManager.safeSend(sessionId, JSON.stringify({ type: 'session_message', sessionId, message }));
  };
  try {
    if (action === 'steer') {
      const { content } = body;
      if (typeof body.turnId !== 'string' || body.turnId !== codexSessions.activeTurnId(sessionId)) return Response.json({ error: 'The active turn changed. Your draft has been kept.' }, { status: 409 });
      if (typeof content !== 'string' && !Array.isArray(content)) return Response.json({ error: 'Missing message content.' }, { status: 400 });
      const stored = typeof content === 'string' ? content : JSON.stringify(content);
      const decoded = decodeStoredMessage(stored);
      if (!decoded.text.trim() && !decoded.attachments.length) return Response.json({ error: 'Message is empty.' }, { status: 400 });
      const { imagePaths, filePaths } = processAttachments(content, sessionId, getRuntimeSessionPaths(session).metadata);
      const prompt = [filePaths.map(p => `[File attached: ${p}]`).join('\n'), decoded.text].filter(Boolean).join('\n\n');
      await codexSessions.steer(sessionId, prompt, imagePaths, () => persistInput(stored));
    } else {
      const { toolId, answers } = body;
      if (typeof toolId !== 'string' || !answers || typeof answers !== 'object' || Array.isArray(answers) || Object.values(answers).some(a => typeof a !== 'string')) {
        return Response.json({ error: 'Invalid question reply.' }, { status: 400 });
      }
      const pending = codexSessions.pendingQuestion(sessionId);
      if (!pending || pending.toolId !== toolId) return Response.json({ error: 'This question is no longer active.' }, { status: 409 });
      const strings = answers as Record<string, string>;
      const text = pending.questions.map(q => `${q.question}\n${q.isSecret ? '[Hidden answer]' : strings[q.id] || strings[q.header] || 'Skipped'}`).join('\n\n');
      await codexSessions.answer(sessionId, toolId, strings, () => persistInput(text));
    }
    return Response.json({ accepted: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not send input to Codex.' }, { status: 409 });
  }
}
