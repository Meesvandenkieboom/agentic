import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  copyManagedWorkspace,
  createManagedWorkspace,
  createSessionMetadata,
  deleteManagedWorkspace,
  deleteSessionMetadata,
  getRuntimeSessionPaths,
  type WorkspaceRecord,
} from './sessionWorkspace';

describe('session workspace ownership', () => {
  let tempRoot: string;
  let appData: string;
  let managedBase: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-workspace-'));
    appData = path.join(tempRoot, 'app-data');
    managedBase = path.join(tempRoot, 'managed');
    fs.mkdirSync(managedBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps an explicit external repo root even when it contains workspace/', () => {
    const repo = path.join(tempRoot, 'repo');
    fs.mkdirSync(path.join(repo, 'workspace'), { recursive: true });
    const metadata = createSessionMetadata('external-session', appData);

    const paths = getRuntimeSessionPaths({
      id: 'external-session',
      working_directory: repo,
      workspace_path: repo,
      metadata_directory: metadata,
    });

    expect(paths.workspace).toBe(repo);
    expect(paths.metadata.startsWith(appData)).toBe(true);
  });

  it('never deletes an external workspace record', () => {
    const repo = path.join(tempRoot, 'selected-repo');
    fs.mkdirSync(path.join(repo, 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pictures', 'sentinel.txt'), 'keep');
    const record: WorkspaceRecord = {
      id: 'external',
      path: repo,
      origin: 'external',
      deletion_policy: 'never',
      status: 'ready',
    };

    expect(deleteManagedWorkspace(record, managedBase)).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'pictures', 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('deletes a verified managed workspace', () => {
    const created = createManagedWorkspace('12345678-session', 'workspace-1', managedBase);
    fs.writeFileSync(path.join(created.workspacePath, 'file.txt'), 'owned');
    const record: WorkspaceRecord = {
      id: 'workspace-1',
      path: created.workspacePath,
      origin: 'managed',
      deletion_policy: 'delete_when_unreferenced',
      managed_root: created.root,
      ownership_token: created.ownershipToken,
      status: 'ready',
    };

    expect(deleteManagedWorkspace(record, managedBase)).toBe(true);
    expect(fs.existsSync(created.root)).toBe(false);
  });

  it('refuses managed deletion when the ownership marker is altered', () => {
    const created = createManagedWorkspace('abcdef12-session', 'workspace-2', managedBase);
    fs.writeFileSync(path.join(created.root, '.agentic-owned.json'), JSON.stringify({
      workspaceId: 'someone-else',
      ownershipToken: created.ownershipToken,
    }));
    const record: WorkspaceRecord = {
      id: 'workspace-2',
      path: created.workspacePath,
      origin: 'managed',
      deletion_policy: 'delete_when_unreferenced',
      managed_root: created.root,
      ownership_token: created.ownershipToken,
      status: 'ready',
    };

    expect(deleteManagedWorkspace(record, managedBase)).toBe(false);
    expect(fs.existsSync(created.root)).toBe(true);
  });

  it('copies managed contents without changing the source', async () => {
    const source = createManagedWorkspace('11111111-session', 'source', managedBase);
    const target = createManagedWorkspace('22222222-session', 'target', managedBase);
    fs.writeFileSync(path.join(source.workspacePath, 'source.txt'), 'content');

    await copyManagedWorkspace(source.workspacePath, target.workspacePath);

    expect(fs.readFileSync(path.join(target.workspacePath, 'source.txt'), 'utf8')).toBe('content');
    expect(fs.readFileSync(path.join(source.workspacePath, 'source.txt'), 'utf8')).toBe('content');
  });

  it('deletes only verified session metadata under app data', () => {
    const metadata = createSessionMetadata('session-1', appData);
    fs.writeFileSync(path.join(metadata, 'note.txt'), 'owned');

    expect(deleteSessionMetadata('session-1', appData)).toBe(true);
    expect(fs.existsSync(metadata)).toBe(false);
  });
});
