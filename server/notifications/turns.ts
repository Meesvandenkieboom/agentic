import { randomUUID } from 'crypto';
import { formatNotification, type NotificationKind, type NotificationQuestion } from './format';

interface Sink {
  enqueue(id: string, sessionId: string, turnId: string, kind: NotificationKind, body: string): void;
  resolveQuestion(id: string): void;
  endTurn(turnId: string): void;
}
interface Turn { id: string; title: string }

/** Provider lifecycle events only; websocket replays never enter this boundary. */
export class TurnNotifications {
  private turns = new Map<string, Turn[]>();
  constructor(private sink: () => Sink) {}

  begin(sessionId: string, title: string): void {
    const turns = this.turns.get(sessionId) || [];
    turns.push({ id: randomUUID(), title });
    this.turns.set(sessionId, turns);
  }
  rename(sessionId: string, title: string): void {
    for (const turn of this.turns.get(sessionId) || []) turn.title = title;
  }
  finish(sessionId: string, outcome: 'finished' | 'error'): void {
    const queue = this.turns.get(sessionId);
    const turn = queue?.shift();
    if (!turn) return;
    if (!queue?.length) this.turns.delete(sessionId);
    this.safe(sink => {
      sink.endTurn(turn.id);
      sink.enqueue(`${turn.id}:terminal`, sessionId, turn.id, outcome, formatNotification(outcome, turn.title));
    });
    // A terminal provider error also cancels any queued inputs on its stream.
    if (outcome === 'error') this.cancel(sessionId);
  }
  question(sessionId: string, toolId: string, questions: NotificationQuestion[], blocking: boolean): void {
    const turn = this.turns.get(sessionId)?.[0];
    if (!turn) return;
    this.safe(sink => sink.enqueue(`${turn.id}:question:${toolId}`, sessionId, turn.id, 'question',
      formatNotification('question', turn.title, questions, blocking)));
  }
  resolveQuestion(sessionId: string, toolId: string): void {
    const turn = this.turns.get(sessionId)?.[0];
    if (turn) this.safe(sink => sink.resolveQuestion(`${turn.id}:question:${toolId}`));
  }
  cancel(sessionId: string): void {
    const turns = this.turns.get(sessionId) || [];
    this.turns.delete(sessionId);
    for (const turn of turns) this.safe(sink => sink.endTurn(turn.id));
  }
  cancelAll(): void {
    for (const sessionId of this.turns.keys()) this.cancel(sessionId);
  }
  private safe(action: (sink: Sink) => void): void {
    try { action(this.sink()); }
    catch { console.warn('Could not queue a Telegram notification.'); }
  }
}
