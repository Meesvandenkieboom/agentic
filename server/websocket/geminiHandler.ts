import { turnNotifications } from '../notifications';
import { sessionDb } from '../database';
import { sessionStreamManager } from '../sessionStreamManager';
import { buildGithubContext } from '../systemPrompt';
import { CodexMessageStore } from '../codex/messageStore';
import { geminiSessions, toAcpMcpServers } from '../providers/gemini';

/** Same persistence and event flow as the Codex path; Gemini events use the Codex shapes. */
export async function handleGeminiProvider(
  session: NonNullable<ReturnType<typeof sessionDb.getSession>>,
  sessionId: string,
  promptText: string,
  workingDir: string,
  effort: string | undefined,
  model: string,
  mcpServers: Record<string, unknown>,
  imagePaths: string[],
): Promise<void> {
  const signal = sessionStreamManager.getAbortController(sessionId)?.signal;
  const send = (payload: Record<string, unknown>) => sessionStreamManager.safeSend(sessionId, JSON.stringify({ ...payload, sessionId }));
  const store = new CodexMessageStore(sessionId, sessionDb, message => send({ type: 'session_message', message }), error => {
    console.error('Could not save Gemini output:', error);
    turnNotifications.finish(sessionId, 'error');
    send({ type: 'error', message: 'Could not save Gemini output. Generation was stopped.' });
    sessionStreamManager.abortSession(sessionId);
  });

  try {
    await geminiSessions.run(promptText, workingDir, event => {
      if (event.type === 'block') store.update(event.block);
      else if (event.type === 'input_boundary') store.inputBoundary();
      else {
        if (event.type === 'result') {
          store.flush();
          if (event.success && !signal?.aborted) turnNotifications.finish(sessionId, 'finished');
          else turnNotifications.cancel(sessionId);
        }
        send({ ...event });
      }
    }, {
      sessionId,
      resumeSessionId: session.sdk_session_id ?? null,
      signal,
      model,
      effort,
      mcpServers: toAcpMcpServers(mcpServers),
      developerInstructions: session.github_repo ? buildGithubContext(session.github_repo, workingDir) : undefined,
      imagePaths,
      onSessionId: id => sessionDb.updateSdkSessionId(sessionId, id),
    });
    store.flush();
  } catch (error) {
    turnNotifications.finish(sessionId, 'error');
    console.error('❌ Gemini provider error:', error);
    const message = error instanceof Error ? error.message : 'Gemini provider error';
    let persisted = false;
    try {
      store.inputBoundary();
      store.update({ type: 'text', id: `error-${Date.now()}`, text: `Gemini stopped: ${message}` });
      store.flush();
      persisted = true;
    } catch (saveError) { console.error('Could not save partial Gemini output:', saveError); }
    send({ type: 'error', message, persisted });
  }
}
