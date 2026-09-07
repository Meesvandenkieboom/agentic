import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('database branching integration', () => {
  it('shares external repos, structurally shares history, and safely cleans managed roots', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-branch-'));
    const appData = path.join(tempRoot, 'app-data');
    const managedBase = path.join(tempRoot, 'managed');
    const externalRepo = path.join(tempRoot, 'chat-deadbeef');
    fs.mkdirSync(path.join(externalRepo, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(externalRepo, 'pictures'), { recursive: true });
    fs.mkdirSync(path.join(externalRepo, 'files'), { recursive: true });
    fs.writeFileSync(path.join(externalRepo, 'pictures', 'keep.txt'), 'pictures');
    fs.writeFileSync(path.join(externalRepo, 'files', 'keep.txt'), 'files');

    const databaseModule = new URL('./database.ts', import.meta.url).href;
    const script = `
      import fs from 'fs';
      import path from 'path';
      import { Database } from 'bun:sqlite';
      const { sessionDb, SessionDatabase } = await import(${JSON.stringify(databaseModule)});
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const repo = ${JSON.stringify(externalRepo)};
      const managed = ${JSON.stringify(managedBase)};
      const appData = ${JSON.stringify(appData)};

      const external = sessionDb.createSession('External', repo);
      assert(external.workspace_origin === 'external', 'selected repo was not external');
      assert(external.workspace_path === repo, 'repo with workspace/ was misrouted');
      assert(!fs.existsSync(path.join(repo, '.claude')), 'chat infrastructure polluted selected repo');
      const first = sessionDb.addMessage(external.id, 'user', JSON.stringify([
        { type: 'text', text: 'one' },
        { type: 'document', name: 'branch-notes.txt', data: 'data:text/plain;base64,YWJj' },
      ]));
      const second = sessionDb.addMessage(external.id, 'assistant', '[{"type":"text","text":"two"}]');
      sessionDb.addMessage(external.id, 'user', 'three');

      const activityBeforePin = sessionDb.getSession(external.id).updated_at;
      assert(sessionDb.setSessionPinned(external.id, true), 'pin failed');
      const pinnedAt = sessionDb.getSession(external.id).pinned_at;
      assert(pinnedAt, 'pin timestamp missing');
      assert(sessionDb.setSessionPinned(external.id, true), 'repeated pin failed');
      assert(sessionDb.getSession(external.id).pinned_at === pinnedAt, 'repeated pin changed ordering');
      assert(sessionDb.getSession(external.id).updated_at === activityBeforePin, 'pin changed chat activity');
      assert(sessionDb.getSessions().sessions.find(s => s.id === external.id)?.pinned_at === pinnedAt, 'list omitted pin');
      const reopened = new SessionDatabase(path.join(appData, 'sessions.db'), { appDataDirectory: appData, managedBaseDirectory: managed });
      assert(reopened.getSession(external.id).pinned_at === pinnedAt, 'pin did not survive reopening database');
      reopened.close();
      assert(!sessionDb.setSessionPinned('missing-chat', true), 'missing chat accepted pin');

      const branch = sessionDb.createBranchedSession(external.id, second.id, undefined, 'External branch');
      assert(branch, 'external branch failed');
      assert(!branch.pinned_at, 'branch inherited parent pin');
      assert(sessionDb.setSessionPinned(branch.id, true), 'branch pin failed');
      assert(sessionDb.setSessionPinned(branch.id, false), 'unpin failed');
      assert(sessionDb.getSession(branch.id).pinned_at === null, 'unpin did not clear timestamp');
      assert(branch.workspace_status === 'ready', 'external branch should be immediately ready');
      assert(branch.workspace_id === external.workspace_id, 'external workspace record was not shared');
      assert(branch.workspace_path === repo, 'external branch changed cwd');
      const inherited = sessionDb.getSessionMessages(branch.id);
      assert(inherited.length === 2, 'branch inherited wrong prefix');
      assert(inherited[0].id === first.id && inherited[1].id === second.id, 'message identity was copied');

      const raw = new Database(path.join(appData, 'sessions.db'));
      const directBefore = raw.query('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(branch.id);
      assert(directBefore.count === 0, 'branch duplicated message rows');
      sessionDb.addMessage(branch.id, 'user', 'branch-only');
      assert(sessionDb.getSessionMessages(branch.id).length === 3, 'branch suffix was not appended');
      assert((await sessionDb.searchSessions('two')).results.length === 2, 'inherited text was not searchable');
      assert((await sessionDb.searchSessions('three')).results.every(r => r.id === external.id), 'search included history after branch point');
      assert((await sessionDb.searchSessions('branch-only')).results[0]?.id === branch.id, 'branch suffix was not searchable');

      assert(sessionDb.deleteSession(external.id), 'parent delete failed');
      assert(sessionDb.getSession(external.id) === null, 'deleted parent remained visible');
      assert(!sessionDb.setSessionPinned(external.id, true), 'soft-deleted parent accepted pin');
      assert(sessionDb.getSessionMessages(branch.id).length === 3, 'soft-deleted lineage was lost');
      const inheritedSearch = (await sessionDb.searchSessions('two')).results;
      assert(inheritedSearch.length === 1 && inheritedSearch[0].id === branch.id, 'search lost inherited text or exposed deleted parent');
      const inheritedFiles = (await sessionDb.searchSessions('branch-notes', 0, 'files')).results;
      assert(inheritedFiles.length === 1 && inheritedFiles[0].sessionId === branch.id && inheritedFiles[0].messageId === first.id,
        'attachment search lost inherited file or navigated to deleted parent');
      assert(fs.readFileSync(path.join(repo, 'pictures', 'keep.txt'), 'utf8') === 'pictures', 'pictures deleted');
      assert(fs.readFileSync(path.join(repo, 'files', 'keep.txt'), 'utf8') === 'files', 'files deleted');
      assert(sessionDb.deleteSession(branch.id), 'branch delete failed');
      const parentRows = raw.query('SELECT COUNT(*) as count FROM sessions WHERE id = ?').get(external.id);
      assert(parentRows.count === 0, 'deleted lineage tombstone was not pruned');

      const managedSession = sessionDb.createSession('Managed');
      fs.writeFileSync(path.join(managedSession.workspace_path, 'source.txt'), 'managed-content');
      const managedMessage = sessionDb.addMessage(managedSession.id, 'user', 'managed message');
      const managedBranch = sessionDb.createBranchedSession(managedSession.id, managedMessage.id);
      assert(managedBranch?.workspace_status === 'preparing', 'managed branch was not backgrounded');
      let ready = managedBranch;
      for (let attempt = 0; attempt < 100 && ready?.workspace_status === 'preparing'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        ready = sessionDb.getSession(managedBranch.id);
      }
      assert(ready?.workspace_status === 'ready', 'managed branch copy did not finish');
      assert(fs.readFileSync(path.join(ready.workspace_path, 'source.txt'), 'utf8') === 'managed-content', 'managed copy missing');
      const parentRoot = managedSession.managed_root;
      const branchRoot = ready.managed_root;
      assert(sessionDb.deleteSession(managedSession.id), 'managed parent delete failed');
      assert(!fs.existsSync(parentRoot), 'managed parent root was not deleted');
      assert(sessionDb.deleteSession(ready.id), 'managed branch delete failed');
      assert(!fs.existsSync(branchRoot), 'managed branch root was not deleted');

      assert(fs.existsSync(repo), 'external repo root was deleted');
      const now = new Date().toISOString();
      const oldDate = new Date(Date.now() - 300 * 86400000).toISOString();
      raw.run('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', ['old-search', 'Archived needle', oldDate, oldDate]);
      raw.run('INSERT INTO messages (id, session_id, type, content, timestamp, ordinal) VALUES (?, ?, ?, ?, ?, ?)',
        ['old-message', 'old-search', 'user', 'archive-only', oldDate, 0]);
      const recentSearch = await sessionDb.searchSessions('archive-only');
      assert(recentSearch.results.length === 0 && recentSearch.hasOlder, 'recent search did not exclude old chats');
      assert(!raw.query('SELECT 1 FROM message_search WHERE message_id = ?').get('old-message'), 'recent search prepared excluded history');
      assert((await sessionDb.searchSessions('archive-only', 0, 'chats', 'all')).results[0]?.id === 'old-search', 'all dates lost archived chat');
      raw.run('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', ['many-files', 'Many files', now, now]);
      const attachments = Array.from({ length: 60 }, (_, i) => ({ type: 'document', name: 'report-' + i + '.txt', data: 'data:text/plain;base64,YQ==' }));
      sessionDb.addMessage('many-files', 'user', JSON.stringify(attachments));
      const filePage = await sessionDb.searchSessions('report-', 0, 'all');
      const fileNext = await sessionDb.searchSessions('report-', 50, 'all');
      assert(filePage.results.length === 50 && filePage.hasMore, 'first mixed page was not bounded');
      assert(fileNext.results.length === 11 && !fileNext.hasMore, 'next mixed page lost files');
      assert(new Set([...filePage.results, ...fileNext.results].map(r => r.id)).size === 61, 'mixed pagination duplicated results');
      raw.close();
      sessionDb.close();
      console.log(JSON.stringify({ ok: true }));
    `;

    try {
      const child = Bun.spawn([process.execPath, '-e', script], {
        cwd: path.resolve(import.meta.dir, '..'),
        env: {
          ...process.env,
          AGENTIC_APP_DATA_DIR: appData,
          AGENTIC_WORKSPACE_DIR: managedBase,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr || stdout).toBe(0);
      expect(stdout).toContain('{"ok":true}');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
