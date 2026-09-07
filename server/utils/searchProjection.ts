import type { Database } from 'bun:sqlite';
import { decodeStoredMessage, type StoredAttachment } from '../../shared/storedMessage';

export interface SearchMessage {
  id: string;
  text: string;
  attachments: StoredAttachment[];
}

/** Disposable search data: original messages remain the source of truth. */
export class SearchProjection {
  constructor(private db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS message_search (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      folded_text TEXT NOT NULL,
      attachments TEXT NOT NULL,
      folded_names TEXT NOT NULL
    )`);
    // Covers all writers, including imports and streaming updates. Rebuild only
    // when searched, rather than parsing large payloads on every streaming save.
    db.run(`CREATE TRIGGER IF NOT EXISTS invalidate_message_search
      AFTER UPDATE OF content ON messages WHEN OLD.content IS NOT NEW.content
      BEGIN DELETE FROM message_search WHERE message_id = NEW.id; END`);
    db.run(`CREATE INDEX IF NOT EXISTS sessions_search_recent
      ON sessions(updated_at DESC, id ASC) WHERE deleted_at IS NULL`);
  }

  async messages(ids: string[], query: string, signal?: AbortSignal): Promise<SearchMessage[]> {
    const encodedIds = JSON.stringify(ids);
    const missing = this.db.query<{ id: string }, [string]>(`
      SELECT m.id FROM json_each(?) ids JOIN messages m ON m.id = ids.value
      LEFT JOIN message_search s ON s.message_id = m.id
      WHERE s.message_id IS NULL ORDER BY ids.key DESC
    `).all(encodedIds);
    const read = this.db.query<{ content: string }, [string]>('SELECT content FROM messages WHERE id = ?');
    const save = this.db.query(`INSERT OR IGNORE INTO message_search
      (message_id, text, folded_text, attachments, folded_names) VALUES (?, ?, ?, ?, ?)`);
    let index = 0;
    const prepareBatch = this.db.transaction(() => {
      const deadline = performance.now() + 8;
      do {
        signal?.throwIfAborted();
        const { id } = missing[index++];
        const row = read.get(id);
        if (!row) continue;
        const decoded = decodeStoredMessage(row.content, false);
        const text = decoded.text.replace(/\s+/g, ' ').trim();
        save.run(id, text, text.toLowerCase(), JSON.stringify(decoded.attachments),
          decoded.attachments.map(file => file.name.toLowerCase()).join('\n'));
      } while (index < missing.length && performance.now() < deadline);
    });
    while (index < missing.length) {
      prepareBatch();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    // Only transfer actual matches (plus the latest visible preview) out of
    // SQLite. Tool output and encoded attachment bytes never enter this query.
    const rows = this.db.query<{ id: string; text: string; attachments: string }, [string, string]>(`
      WITH history AS (
        SELECT s.*, ids.key AS position FROM json_each(?1) ids
        JOIN message_search s ON s.message_id = ids.value
      )
      SELECT message_id AS id, text, attachments FROM history
      WHERE (?2 <> '' AND (instr(folded_text, ?2) > 0 OR instr(folded_names, ?2) > 0))
        OR (?2 = '' AND attachments <> '[]')
        OR position = (SELECT MAX(position) FROM history WHERE text <> '')
      ORDER BY position ASC
    `).all(encodedIds, query);
    return rows.map(row => ({ ...row, attachments: JSON.parse(row.attachments) }));
  }
}
