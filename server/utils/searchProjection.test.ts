import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SearchProjection } from './searchProjection';
import { searchSessions } from './sessionSearch';

function fixture() {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  db.run('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)');
  db.run('CREATE TABLE sessions (id TEXT, updated_at TEXT, deleted_at TEXT)');
  return { db, projection: new SearchProjection(db) };
}

describe('persistent search projection', () => {
  it('keeps only searchable prose and file metadata and survives reopening the search service', async () => {
    const { db, projection } = fixture();
    try {
      db.run('INSERT INTO messages VALUES (?, ?)', ['one', JSON.stringify([
        { type: 'thinking', thinking: 'private-reasoning' },
        { type: 'tool_use', input: { output: 'tool-bytes'.repeat(100_000) } },
        { type: 'text', text: 'Café   launch 100% complete' },
        { type: 'image', name: 'Launch.png', source: { data: 'SECRET_BYTES'.repeat(100_000) } },
      ])]);
      const messages = await projection.messages(['one'], 'café launch');
      expect(messages[0].text).toBe('Café launch 100% complete');
      expect(messages[0].attachments[0].name).toBe('Launch.png');
      const cached = JSON.stringify(db.query('SELECT * FROM message_search').all());
      expect(cached.length).toBeLessThan(600);
      expect(cached).not.toContain('SECRET_BYTES');
      expect(cached).not.toContain('private-reasoning');
      expect(cached).not.toContain('tool-bytes');
      const reopened = new SearchProjection(db);
      const files = await reopened.messages(['one'], 'launch.png');
      expect(searchSessions([{ id: 's', title: 'Chat', updated_at: '' }], () => files, 'launch.png', 0, 50, 'images').results).toHaveLength(1);
    } finally { db.close(); }
  });

  it('invalidates edited content and removes deleted messages', async () => {
    const { db, projection } = fixture();
    try {
      db.run("INSERT INTO messages VALUES ('one', 'old needle')");
      await projection.messages(['one'], 'needle');
      db.run("UPDATE messages SET content = 'new answer' WHERE id = 'one'");
      expect(db.query('SELECT * FROM message_search').all()).toHaveLength(0);
      expect((await projection.messages(['one'], 'answer'))[0].text).toBe('new answer');
      db.run("DELETE FROM messages WHERE id = 'one'");
      expect(await projection.messages(['one'], 'answer')).toEqual([]);
      expect(db.query('SELECT * FROM message_search').all()).toHaveLength(0);
    } finally { db.close(); }
  });

  it('returns only matches, files and latest visible preview, respecting effective history order', async () => {
    const { db, projection } = fixture();
    try {
      for (const [id, content] of [['a', 'older needle'], ['b', 'unrelated'], ['c', 'latest']]) {
        db.run('INSERT INTO messages VALUES (?, ?)', [id, content]);
      }
      expect((await projection.messages(['a', 'b', 'c'], '')).map(m => m.id)).toEqual(['c']);
      expect((await projection.messages(['a', 'b', 'c'], 'needle')).map(m => m.id)).toEqual(['a', 'c']);
      expect((await projection.messages(['a', 'b'], 'needle')).map(m => m.id)).toEqual(['a', 'b']);
    } finally { db.close(); }
  });

  it('stops preparing history when a search is cancelled, then resumes cleanly', async () => {
    const { db, projection } = fixture();
    try {
      const ids = Array.from({ length: 100 }, (_, i) => String(i));
      for (const id of ids) db.run('INSERT INTO messages VALUES (?, ?)', [id, 'text '.repeat(20_000)]);
      const controller = new AbortController();
      const pending = projection.messages(ids, 'text', controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(db.query('SELECT * FROM message_search').all().length).toBeLessThan(100);
      expect(await projection.messages(ids, 'missing')).toHaveLength(1);
    } finally { db.close(); }
  });
});
