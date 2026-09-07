export type NotificationKind = 'finished' | 'error' | 'question';
export interface NotificationQuestion { question: string; isSecret?: boolean }

function compact(text: string, limit: number): string {
  const characters = Array.from(Array.from(text, char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').replace(/\s+/g, ' ').trim());
  return characters.length > limit ? characters.slice(0, limit - 1).join('').trimEnd() + '…' : characters.join('');
}
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function formatNotification(kind: NotificationKind, title: string, questions: NotificationQuestion[] = [], blocking = false): string {
  const heading = { finished: '✅ Turn finished', error: '⚠️ Chat error', question: '💬 Question for you' }[kind];
  const body = kind === 'finished' ? 'Your response is ready.' : kind === 'error'
    ? 'This turn stopped because of an error. Check Agentic for details.'
    : compact(questions.map(q => q.isSecret ? '[Private question — open Agentic]' : q.question).join(' • '), 180) || 'Open Agentic to view the question.';
  return `<b>${heading}</b>\n<b>${escape(compact(title || 'New Chat', 100))}</b>\n${escape(body)}${kind === 'question' && blocking ? '\nWaiting for your answer.' : ''}`;
}
