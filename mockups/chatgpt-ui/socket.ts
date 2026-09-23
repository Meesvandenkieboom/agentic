import type { ServerWebSocket } from 'bun';
import { messages, sessions } from './fixtures';

export interface SocketState { timers: Set<ReturnType<typeof setTimeout>> }
export const websocket = {
  message(ws: ServerWebSocket<SocketState>, raw: string | Buffer) {
    const data = JSON.parse(String(raw));
    const sessionId = data.sessionId as string;
    const send = (event: object) => ws.send(JSON.stringify({ sessionId, ...event }));
    if (data.type === 'ping') { send({ type: 'pong' }); return; }
    if (data.type === 'reconnect') { send({ type: 'reconnect_ack', isGenerating: false }); return; }
    if (data.type === 'stop_generation') {
      for (const timer of ws.data.timers) clearTimeout(timer);
      ws.data.timers.clear();
      send({ type: 'generation_stopped' });
      return;
    }
    if (data.type === 'set_permission_mode') { send({ type: 'permission_mode_changed', mode: data.mode }); return; }
    if (data.type !== 'chat') return;
    const history = messages.get(sessionId);
    if (!history) { send({ type: 'error', message: 'Preview session not found' }); return; }
    history.push({ id: data.clientMessageId || crypto.randomUUID(), session_id: sessionId, type: 'user', content: String(data.content), timestamp: new Date().toISOString() });
    const reply = '**Preview response.** This is Agentic’s real message renderer, connected to an in-memory mock server.\n\n### You can try\n\n- Switching chats and opening the input menu.\n- Editing a chat title, pinning it, or starting a new chat.\n- Copying code and expanding the tool and reasoning blocks.\n\nYour message stays in this preview. No model request is sent.';
    const assistant = { id: crypto.randomUUID(), session_id: sessionId, type: 'assistant' as const, content: '[]', timestamp: new Date().toISOString() };
    history.push(assistant);
    send({ type: 'generation_started' });
    let accumulated = '';
    const chunks = reply.match(/[\s\S]{1,28}/g) || [];
    chunks.forEach((chunk, index) => {
      const timer = setTimeout(() => {
        ws.data.timers.delete(timer);
        accumulated += chunk;
        assistant.content = JSON.stringify([{ type: 'text', text: accumulated }]);
        send({ type: 'assistant_message', content: chunk });
        if (index === chunks.length - 1) {
          const session = sessions.find(item => item.id === sessionId);
          if (session) { session.message_count = history.length; session.updated_at = assistant.timestamp; }
          send({ type: 'result' });
        }
      }, 70 * (index + 1));
      ws.data.timers.add(timer);
    });
  },
  close(ws: ServerWebSocket<SocketState>) {
    for (const timer of ws.data.timers) clearTimeout(timer);
  },
};
