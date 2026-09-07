import { expect, it } from 'bun:test';
import { restoreMessage, upsertSavedMessage } from './storedMessages';
it('replaces optimistic input and streaming snapshots by identity, preserving attachment cards', () => {
  const content = JSON.stringify([{ type: 'image', name: 'Design.png', source: { type: 'base64', data: 'YWJj', media_type: 'image/png' } }]);
  const saved = { id: 'db-user', type: 'user', content, timestamp: '2026-01-01' };
  const optimistic = restoreMessage({ ...saved, id: 'client-id' });
  let messages = upsertSavedMessage([optimistic], saved, 'client-id');
  messages = upsertSavedMessage(messages, { id: 'db-assistant', type: 'assistant', content: '[{"type":"text","text":"partial"}]', timestamp: '2026-01-02' });
  messages = upsertSavedMessage(messages, { id: 'db-assistant', type: 'assistant', content: '[{"type":"text","text":"complete"}]', timestamp: '2026-01-02' });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ id: 'db-user', content: '', attachments: [{ name: 'Design.png' }] });
  expect(messages[1].content).toEqual([{ type: 'text', text: 'complete' }]);
});
