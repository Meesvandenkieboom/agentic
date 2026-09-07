import { describe, expect, it } from 'bun:test';
import { searchableMessageText, searchSessions } from './sessionSearch';

const sessions = [
  { id: 'new', title: 'Release notes', updated_at: '2026-09-07T12:00:00Z' },
  { id: 'old', title: 'Weekend plans', updated_at: '2025-01-01T12:00:00Z' },
  { id: 'empty', title: 'Untitled', updated_at: '2024-01-01T12:00:00Z' },
];
const messages: Record<string, { content: string }[]> = {
  new: [{ content: JSON.stringify([
    { type: 'thinking', thinking: 'hidden-thought' },
    { type: 'tool_use', input: { command: 'hidden-command' } },
    { type: 'text', text: 'Deploy the release at 10:00.' },
  ]) }],
  old: [{ content: JSON.stringify([
    { type: 'text', text: 'Meet in Café Noord. Bring 100% of the PR #42 notes.' },
    { type: 'image', source: { data: 'hidden-image-data' } },
  ]) }, { content: 'See you there!' }],
  empty: [],
};
const getMessages = (id: string) => messages[id];

describe('chat history search', () => {
  it('finds attached filenames in chats, files and images without searching encoded bytes', () => {
    const getFiles = () => [{ id: 'message-42', content: JSON.stringify([
      { type: 'text', text: 'Please review these files.' },
      { type: 'image', name: 'Launch screenshot.png', source: { media_type: 'image/png', data: 'ENCODED_IMAGE_PAYLOAD' } },
      { type: 'document', name: 'Launch budget.pdf', data: 'data:application/pdf;base64,ENCODED_PDF_PAYLOAD' },
    ]) }];
    const onlySession = sessions.slice(0, 1);
    expect(searchSessions(onlySession, getFiles, 'budget', 0, 50, 'chats').results[0].id).toBe('new');
    const files = searchSessions(onlySession, getFiles, 'BUDGET', 0, 50, 'files').results;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: 'file', title: 'Launch budget.pdf', sessionId: 'new', messageId: 'message-42' });
    const images = searchSessions(onlySession, getFiles, 'screenshot', 0, 50, 'images').results;
    expect(images[0]).toMatchObject({ kind: 'image', title: 'Launch screenshot.png' });
    expect(searchSessions(onlySession, getFiles, 'screenshot', 0, 50, 'files').results).toEqual([]);
    expect(searchSessions(onlySession, getFiles, 'ENCODED', 0, 50, 'all').results).toEqual([]);
    const all = searchSessions(onlySession, getFiles, 'Launch', 0, 2, 'all');
    expect(all.results).toHaveLength(2);
    expect(all.hasMore).toBe(true);
    expect(searchSessions(onlySession, getFiles, 'Launch', 2, 2, 'all').results).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain('base64');
  });

  it('finds titles and older message text, case insensitively and literally', () => {
    expect(searchSessions(sessions, getMessages, 'release').results.map(r => r.id)).toEqual(['new']);
    for (const query of ['CAFÉ', '100%', 'PR #42', '  PR   #42  ']) {
      const result = searchSessions(sessions, getMessages, query).results;
      expect(result.map(r => r.id)).toEqual(['old']);
      expect(result[0].preview).toContain('Café Noord');
    }
    expect(searchSessions(sessions, getMessages, 'missing').results).toEqual([]);
  });

  it('searches only visible text blocks and accepts legacy plain text', () => {
    for (const query of ['hidden-thought', 'hidden-command', 'hidden-image-data', 'tool_use']) {
      expect(searchSessions(sessions, getMessages, query).results).toEqual([]);
    }
    expect(searchableMessageText('legacy text')).toBe('legacy text');
    expect(searchableMessageText('[null, {"type":"text","text":"hello"}]')).toBe('hello');
  });

  it('shows recent chats, latest visible previews, and empty conversations', () => {
    const result = searchSessions(sessions, getMessages, '  ');
    expect(result.results.map(r => r.id)).toEqual(['new', 'old', 'empty']);
    expect(result.results[1].preview).toBe('See you there!');
    expect(result.results[2].preview).toBe('');
    expect(result.hasMore).toBe(false);
  });

  it('paginates matching chats without losing older results', () => {
    const first = searchSessions(sessions, getMessages, '', 0, 2);
    expect(first.results.map(r => r.id)).toEqual(['new', 'old']);
    expect(first.hasMore).toBe(true);
    expect(searchSessions(sessions, getMessages, '', 2, 2).results.map(r => r.id)).toEqual(['empty']);
    expect(searchSessions(sessions, getMessages, 'notes', 1, 1).results.map(r => r.id)).toEqual(['old']);
  });

  it('centers a compact preview around a match deep inside a message', () => {
    const result = searchSessions(sessions.slice(0, 1), () => [
      { content: 'Earlier text. '.repeat(100) + 'needle phrase' + ' Later text.'.repeat(100) },
    ], 'needle phrase').results[0];
    expect(result.preview).toContain('needle phrase');
    expect(result.preview.startsWith('…')).toBe(true);
    expect(result.preview.endsWith('…')).toBe(true);
    expect(result.preview.length).toBeLessThan(230);
  });
});
