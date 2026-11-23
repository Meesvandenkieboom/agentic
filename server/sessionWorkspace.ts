import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

import {
  getAppDataDirectory,
  getDefaultWorkingDirectory,
  type SessionPaths,
} from './directoryUtils';

export type WorkspaceOrigin = 'managed' | 'external' | 'legacy';
export type WorkspaceStatus = 'ready' | 'preparing' | 'failed';
export type WorkspaceDeletionPolicy = 'delete_when_unreferenced' | 'never';

export interface WorkspaceRecord {
  id: string;
  path: string;
  origin: WorkspaceOrigin;
  deletion_policy: WorkspaceDeletionPolicy;
  managed_root?: string | null;
  ownership_token?: string | null;
  status: WorkspaceStatus;
  error?: string | null;
}

export interface RuntimeSessionPaths {
  id: string;
  working_directory: string;
  workspace_path?: string | null;
  metadata_directory?: string | null;
  managed_root?: string | null;
}

const WORKSPACE_MARKER = '.agentic-owned.json';
const SESSION_MARKER = '.agentic-session.json';

export function getSessionDataRoot(
  sessionId: string,
  appDataDirectory = getAppDataDirectory(),
): string {
  return path.join(appDataDirectory, 'sessions', sessionId);
}

export function getSessionMetadataDirectory(
  sessionId: string,
  appDataDirectory = getAppDataDirectory(),
): string {
  return path.join(getSessionDataRoot(sessionId, appDataDirectory), 'metadata');
}

export function createSessionMetadata(
  sessionId: string,
  appDataDirectory = getAppDataDirectory(),
): string {
  const root = getSessionDataRoot(sessionId, appDataDirectory);
  const metadata = getSessionMetadataDirectory(sessionId, appDataDirectory);
  fs.mkdirSync(path.join(metadata, 'attachments'), { recursive: true });

  const markerPath = path.join(root, SESSION_MARKER);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, JSON.stringify({ version: 1, sessionId }, null, 2));
  }
  return metadata;
}

export function createManagedWorkspace(
  sessionId: string,
  workspaceId: string,
  managedBaseDirectory = getDefaultWorkingDirectory(),
): { root: string; workspacePath: string; ownershipToken: string } {
  const root = path.join(managedBaseDirectory, `chat-${sessionId.substring(0, 8)}`);
  const workspacePath = path.join(root, 'workspace');
  const ownershipToken = randomUUID();
  if (fs.existsSync(root)) {
    throw new Error(`Refusing to claim existing workspace root: ${root}`);
  }
  fs.mkdirSync(workspacePath, { recursive: true });

  const markerPath = path.join(root, WORKSPACE_MARKER);
  fs.writeFileSync(markerPath, JSON.stringify({
    version: 1,
    workspaceId,
    ownershipToken,
  }, null, 2));

  return { root, workspacePath, ownershipToken };
}

export function getRuntimeSessionPaths(session: RuntimeSessionPaths): SessionPaths {
  const metadata = session.metadata_directory || getSessionMetadataDirectory(session.id);
  const root = session.managed_root || session.working_directory;
  const workspace = session.workspace_path || session.working_directory;

  return {
    root,
    workspace,
    metadata,
    claudeDir: path.join(metadata, '.claude'),
    claudeMd: path.join(metadata, 'CLAUDE.md'),
    attachments: path.join(metadata, 'attachments'),
  };
}

// Leave room so a branch copy can never fill the disk and starve SQLite writes.
const COPY_HEADROOM_BYTES = 1024 ** 3;

async function diskUsage(target: string): Promise<number> {
  let total = 0;
  const pending = [target];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) total += (await fs.promises.lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

async function freeBytes(target: string): Promise<number> {
  const { bavail, bsize } = await fs.promises.statfs(target);
  let free = bavail * bsize;
  // Inside WSL, statfs reports the virtual disk's max size, not real space:
  // the ext4.vhdx grows on the Windows drive (normally C:), which can fill first.
  if (process.platform === 'linux' && fs.existsSync('/mnt/c')
    && fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')) {
    const host = await fs.promises.statfs('/mnt/c').catch(() => null);
    if (host) free = Math.min(free, host.bavail * host.bsize);
  }
  return free;
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export async function copyManagedWorkspace(source: string, destination: string): Promise<void> {
  const needed = await diskUsage(source);
  const free = await freeBytes(destination);
  if (needed + COPY_HEADROOM_BYTES > free) {
    throw new Error(`Not enough disk space to copy workspace: needs ${formatGb(needed)} `
      + `(+${formatGb(COPY_HEADROOM_BYTES)} headroom), ${formatGb(free)} free`);
  }

  const skipped: string[] = [];
  try {
    await fs.promises.cp(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false,
      // Prefer copy-on-write clones where the filesystem supports them and
      // transparently fall back to a regular copy elsewhere.
      mode: fs.constants.COPYFILE_FICLONE,
      // Skip entries we can't read (eg root/container-owned Docker volume data)
      // instead of failing the whole branch.
      filter: async (src) => {
        const stat = await fs.promises.lstat(src);
        if (stat.isSymbolicLink()) return true;
        const access = stat.isDirectory() ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK;
        try {
          await fs.promises.access(src, access);
          return true;
        } catch {
          skipped.push(path.relative(source, src));
          return false;
        }
      },
    });
  } catch (error) {
    // A failed branch is unusable; don't leave a partial copy eating disk.
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (skipped.length > 0) {
    console.warn(`⚠️  Branch copy skipped ${skipped.length} unreadable path(s): ${skipped.slice(0, 10).join(', ')}`);
  }
}

function isDirectChild(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
    && !relative.includes(path.sep);
}

export function deleteSessionMetadata(
  sessionId: string,
  appDataDirectory = getAppDataDirectory(),
): boolean {
  const root = getSessionDataRoot(sessionId, appDataDirectory);
  if (!fs.existsSync(root)) return true;

  const stat = fs.lstatSync(root);
  const markerPath = path.join(root, SESSION_MARKER);
  if (stat.isSymbolicLink() || !fs.existsSync(markerPath) || fs.lstatSync(markerPath).isSymbolicLink()) {
    console.warn(`Refusing to delete unverified session metadata: ${root}`);
    return false;
  }

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { sessionId?: string };
    const sessionsRoot = path.join(appDataDirectory, 'sessions');
    if (marker.sessionId !== sessionId
      || path.resolve(root) !== path.resolve(getSessionDataRoot(sessionId, appDataDirectory))
      || !isDirectChild(path.resolve(root), path.resolve(sessionsRoot))) {
      console.warn(`Refusing to delete mismatched session metadata: ${root}`);
      return false;
    }
  } catch {
    console.warn(`Refusing to delete unreadable session metadata: ${root}`);
    return false;
  }

  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

export function deleteManagedWorkspace(
  workspace: WorkspaceRecord,
  managedBaseDirectory = getDefaultWorkingDirectory(),
): boolean {
  if (workspace.origin !== 'managed' || workspace.deletion_policy !== 'delete_when_unreferenced') {
    return false;
  }

  const root = workspace.managed_root;
  const token = workspace.ownership_token;
  if (!root || !token || !fs.existsSync(root)) return Boolean(root && token);

  const markerPath = path.join(root, WORKSPACE_MARKER);
  if (fs.lstatSync(root).isSymbolicLink() || !fs.existsSync(markerPath)
    || fs.lstatSync(markerPath).isSymbolicLink()) {
    console.warn(`Refusing to delete unverified managed workspace: ${root}`);
    return false;
  }

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      workspaceId?: string;
      ownershipToken?: string;
    };
    const managedBase = path.resolve(managedBaseDirectory);
    if (marker.workspaceId !== workspace.id || marker.ownershipToken !== token
      || !isDirectChild(path.resolve(root), managedBase)) {
      console.warn(`Refusing to delete workspace with mismatched ownership: ${root}`);
      return false;
    }
  } catch {
    console.warn(`Refusing to delete workspace with unreadable ownership marker: ${root}`);
    return false;
  }

  fs.rmSync(root, { recursive: true, force: true });
  return true;
}
