/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import { getDefaultWorkingDirectory, expandPath, validateDirectory, getAppDataDirectory } from "./directoryUtils";
import { setupSessionCommands } from "./commandSetup";
// Title generation moved to messageHandlers.ts (needs SDK auth configured first)
import { configureGitCredentials, isGitHubConnected } from "./routes/github";
import {
  copyManagedWorkspace,
  createManagedWorkspace,
  createSessionMetadata,
  deleteManagedWorkspace,
  deleteSessionMetadata,
  getRuntimeSessionPaths,
  type WorkspaceOrigin,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from './sessionWorkspace';

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  working_directory: string;
  workspace_id?: string;
  workspace_path?: string;
  workspace_origin?: WorkspaceOrigin;
  workspace_status?: WorkspaceStatus;
  workspace_error?: string;
  managed_root?: string;
  metadata_directory?: string;
  deleted_at?: string;
  permission_mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  mode: 'general' | 'coder' | 'intense-research' | 'spark';
  sdk_session_id?: string; // SDK's internal session ID for resume functionality
  context_input_tokens?: number;
  context_window?: number;
  context_percentage?: number;
  output_tokens?: number;
  github_repo?: string; // GitHub repo full_name (e.g., "owner/repo") when connected
  // Branching support
  parent_session_id?: string; // Parent session ID (null for root sessions)
  branch_point_message_id?: string; // Message ID where branch occurred
  branch_history_mode?: 'copied' | 'shared';
  inherited_message_count?: number;
  handoff_pending?: number;
  context_fidelity?: 'native' | 'portable' | 'display';
  model?: string; // Model selection per chat (allows switching models on branch)
}

export interface BranchInfo {
  sessionId: string;
  title: string;
  created_at: string;
  message_count: number;
  branch_point_message_id: string;
  model?: string;
}

export interface SessionMessage {
  id: string;
  session_id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: string;
  ordinal?: number;
}

export class SessionDatabase {
  private db: Database;
  private readonly activeCopyWorkspaceIds = new Set<string>();
  private readonly appDataDirectory: string;
  private readonly managedBaseDirectory: string;

  constructor(
    dbPath?: string,
    storage: { appDataDirectory?: string; managedBaseDirectory?: string } = {},
  ) {
    this.appDataDirectory = storage.appDataDirectory || getAppDataDirectory();
    this.managedBaseDirectory = storage.managedBaseDirectory || getDefaultWorkingDirectory();
    // Use app data directory if no path provided
    if (!dbPath) {
      const appDataDir = this.appDataDirectory;
      // Create directory if it doesn't exist
      if (!fs.existsSync(appDataDir)) {
        fs.mkdirSync(appDataDir, { recursive: true });
        console.log('📁 Created app data directory:', appDataDir);
      }
      dbPath = path.join(appDataDir, 'sessions.db');
    }

    try {
      this.db = new Database(dbPath, { create: true });
      this.db.run('PRAGMA foreign_keys = ON');
      this.initialize();
    } catch (error) {
      // Handle SQLITE_AUTH error (usually from corruption)
      if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_AUTH') {
        console.error('❌ Database authorization failed (likely corruption)');
        console.log('🔄 Attempting recovery by backing up and recreating database...');

        // Backup corrupted database
        const backupPath = `${dbPath}.corrupted.${Date.now()}`;
        try {
          fs.renameSync(dbPath, backupPath);
          console.log(`✅ Backed up corrupted database to: ${backupPath}`);
        } catch (backupError) {
          console.error('⚠️  Could not backup corrupted database:', backupError);
          // Try deleting instead
          try {
            fs.unlinkSync(dbPath);
            console.log('✅ Deleted corrupted database file');
          } catch (deleteError) {
            console.error('❌ Could not delete corrupted database:', deleteError);
            throw new Error('Database is corrupted and cannot be recovered. Please manually delete: ' + dbPath);
          }
        }

        // Retry with fresh database
        try {
          this.db = new Database(dbPath, { create: true });
          this.db.run('PRAGMA foreign_keys = ON');
          this.initialize();
          console.log('✅ Successfully created fresh database');
        } catch (retryError) {
          console.error('❌ Failed to create fresh database:', retryError);
          throw retryError;
        }
      } else {
        // Other errors - rethrow
        throw error;
      }
    }
  }

  private initialize() {
    // Create sessions table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create messages table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Create index for faster queries
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_id
      ON messages(session_id)
    `);

    // Migration: Add working_directory column if it doesn't exist
    this.migrateWorkingDirectory();

    // Migration: Add permission_mode column if it doesn't exist
    this.migratePermissionMode();

    // Migration: Add mode column if it doesn't exist
    this.migrateMode();

    // Migration: Add sdk_session_id column if it doesn't exist
    this.migrateSdkSessionId();

    // Migration: Add context usage columns if they don't exist
    this.migrateContextUsage();

    // Migration: Add github_repo column if it doesn't exist
    this.migrateGithubRepo();

    // Migration: Add output_tokens column if it doesn't exist
    this.migrateOutputTokens();

    // Migration: Add branching columns if they don't exist
    this.migrateBranching();

    // Explicit workspace provenance, structural history, and stable ordering.
    this.migrateWorkspaceOwnership();
    this.migrateStructuralHistory();
  }

  private migrateWorkingDirectory() {
    try {
      // Check if working_directory column exists
      const columns = this.db.query<{ name: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const hasWorkingDirectory = columns.some(col => col.name === 'working_directory');

      if (!hasWorkingDirectory) {
        console.log('📦 Migrating database: Adding working_directory column');

        // Add the column
        this.db.run(`
          ALTER TABLE sessions
          ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''
        `);

        // Update existing sessions with default directory
        const defaultDir = getDefaultWorkingDirectory();
        console.log('📦 Setting default working directory for existing sessions:', defaultDir);

        this.db.run(
          "UPDATE sessions SET working_directory = ? WHERE working_directory = ''",
          [defaultDir]
        );

        console.log('✅ Database migration completed successfully');
      } else {
        console.log('✅ working_directory column already exists');
      }
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      throw error;
    }
  }

  private migratePermissionMode() {
    try {
      // Check if permission_mode column exists
      const columns = this.db.query<{ name: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const hasPermissionMode = columns.some(col => col.name === 'permission_mode');

      if (!hasPermissionMode) {
        console.log('📦 Migrating database: Adding permission_mode column');

        // Add the column with default value
        this.db.run(`
          ALTER TABLE sessions
          ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'
        `);

        console.log('✅ permission_mode column added successfully');
      } else {
        console.log('✅ permission_mode column already exists');
      }
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      throw error;
    }
  }

  private migrateMode() {
    try {
      // Check if mode column exists
      const columns = this.db.query<{ name: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const hasMode = columns.some(col => col.name === 'mode');

      if (!hasMode) {
        console.log('📦 Migrating database: Adding mode column');

        // Add the column with default value
        this.db.run(`
          ALTER TABLE sessions
          ADD COLUMN mode TEXT NOT NULL DEFAULT 'general'
        `);

        console.log('✅ mode column added successfully');
      } else {
        console.log('✅ mode column already exists');
      }
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      throw error;
    }
  }

  private migrateSdkSessionId() {
    try {
      // Check if sdk_session_id column exists
      const columns = this.db.query<{ name: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const hasSdkSessionId = columns.some(col => col.name === 'sdk_session_id');

      if (!hasSdkSessionId) {
        console.log('📦 Migrating database: Adding sdk_session_id column');

        // Add the column (nullable, as it's only set after first message)
        this.db.run(`
          ALTER TABLE sessions
          ADD COLUMN sdk_session_id TEXT
        `);

        console.log('✅ sdk_session_id column added successfully');
      } else {
        console.log('✅ sdk_session_id column already exists');
      }
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      throw error;
    }
  }

  private migrateContextUsage() {
    try {
      // Check if context usage columns exist
      const columns = this.db.query<{ name: string; type: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const contextPercentageCol = columns.find(col => col.name === 'context_percentage');
      const hasContextInputTokens = columns.some(col => col.name === 'context_input_tokens');
      const hasContextWindow = columns.some(col => col.name === 'context_window');

      // Fix context_percentage if it's INTEGER instead of REAL
      if (contextPercentageCol && contextPercentageCol.type === 'INTEGER') {
        console.log('📦 Migrating database: Fixing context_percentage column type (INTEGER → REAL)');

        // SQLite doesn't support ALTER COLUMN, so we need to recreate
        // For now, just update the values to be compatible (this is a new feature so data loss is minimal)
        // The column will work with decimals even as INTEGER in SQLite
        console.log('⚠️  context_percentage is INTEGER but will work with decimals in SQLite');
      }

      if (!hasContextInputTokens || !hasContextWindow || !contextPercentageCol) {
        console.log('📦 Migrating database: Adding context usage columns');

        // Add the columns (nullable, as they're only set after first message)
        if (!hasContextInputTokens) {
          this.db.run(`
            ALTER TABLE sessions
            ADD COLUMN context_input_tokens INTEGER
          `);
        }

        if (!hasContextWindow) {
          this.db.run(`
            ALTER TABLE sessions
            ADD COLUMN context_window INTEGER
          `);
        }

        if (!contextPercentageCol) {
          this.db.run(`
            ALTER TABLE sessions
            ADD COLUMN context_percentage REAL
          `);
        }

        console.log('✅ Context usage columns added successfully');
      } else {
        console.log('✅ Context usage columns already exist');
      }
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      throw error;
    }
  }

  private migrateGithubRepo() {
    try {
      // Check if github_repo column exists
      const columns = this.db.query<{ name: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const hasGithubRepo = columns.some(col => col.name === 'github_repo');

      if (!hasGithubRepo) {
        console.log('📦 Migrating database: Adding github_repo column');

        // Add the column (nullable, as it's only set for GitHub-connected sessions)
        this.db.run(`
          ALTER TABLE sessions
          ADD COLUMN github_repo TEXT
        `);

        console.log('✅ github_repo column added successfully');
      } else {
        console.log('✅ github_repo column already exists');
      }
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      throw error;
    }
  }

  private migrateOutputTokens() {
    try {
      const columns = this.db.query<{ name: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const hasOutputTokens = columns.some(col => col.name === 'output_tokens');

      if (!hasOutputTokens) {
        console.log('📦 Migrating database: Adding output_tokens column');

        this.db.run(`
          ALTER TABLE sessions
          ADD COLUMN output_tokens INTEGER DEFAULT 0
        `);

        console.log('✅ output_tokens column added successfully');
      } else {
        console.log('✅ output_tokens column already exists');
      }
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      throw error;
    }
  }

  private migrateBranching() {
    try {
      const columns = this.db.query<{ name: string }, []>(
        "PRAGMA table_info(sessions)"
      ).all();

      const hasParentSessionId = columns.some(col => col.name === 'parent_session_id');
      const hasBranchPointMessageId = columns.some(col => col.name === 'branch_point_message_id');
      const hasModel = columns.some(col => col.name === 'model');

      if (!hasParentSessionId || !hasBranchPointMessageId || !hasModel) {
        console.log('📦 Migrating database: Adding branching support');

        if (!hasParentSessionId) {
          this.db.run(`
            ALTER TABLE sessions
            ADD COLUMN parent_session_id TEXT
          `);
        }

        if (!hasBranchPointMessageId) {
          this.db.run(`
            ALTER TABLE sessions
            ADD COLUMN branch_point_message_id TEXT
          `);
        }

        if (!hasModel) {
          this.db.run(`
            ALTER TABLE sessions
            ADD COLUMN model TEXT
          `);
        }

        // Create indexes for efficient branch queries
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_sessions_parent_id
          ON sessions(parent_session_id)
        `);

        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_sessions_branch_point
          ON sessions(branch_point_message_id)
        `);

        console.log('✅ Branching support added successfully');
      } else {
        console.log('✅ Branching support already exists');
      }
    } catch (error) {
      console.error('❌ Database branching migration failed:', error);
      throw error;
    }
  }

  private migrateWorkspaceOwnership() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        origin TEXT NOT NULL,
        deletion_policy TEXT NOT NULL,
        managed_root TEXT,
        ownership_token TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        error TEXT,
        created_at TEXT NOT NULL
      )
    `);

    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all();
    const names = new Set(columns.map(column => column.name));
    if (!names.has('workspace_id')) this.db.run('ALTER TABLE sessions ADD COLUMN workspace_id TEXT');
    if (!names.has('metadata_directory')) this.db.run('ALTER TABLE sessions ADD COLUMN metadata_directory TEXT');
    if (!names.has('deleted_at')) this.db.run('ALTER TABLE sessions ADD COLUMN deleted_at TEXT');

    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at)');
    this.db.run(`UPDATE workspaces SET status = 'failed', error = 'Application restarted during workspace copy'
      WHERE status = 'preparing'`);

    const legacySessions = this.db.query<{
      id: string;
      working_directory: string;
    }, []>('SELECT id, working_directory FROM sessions WHERE workspace_id IS NULL').all();

    const insertWorkspace = this.db.query(`INSERT INTO workspaces (
      id, path, origin, deletion_policy, managed_root, ownership_token, status, created_at
    ) VALUES (?, ?, 'legacy', 'never', NULL, NULL, 'ready', ?)`);
    const attachWorkspace = this.db.query(
      'UPDATE sessions SET workspace_id = ?, metadata_directory = ? WHERE id = ?'
    );
    const now = new Date().toISOString();

    this.db.transaction(() => {
      for (const session of legacySessions) {
        const expectedRoot = path.join(
          this.managedBaseDirectory, `chat-${session.id.substring(0, 8)}`,
        );
        const expectedWorkspace = path.join(expectedRoot, 'workspace');
        const storedPath = session.working_directory || this.managedBaseDirectory;
        const isKnownManagedLayout = path.resolve(storedPath) === path.resolve(expectedRoot)
          && fs.existsSync(expectedWorkspace);
        const workspacePath = isKnownManagedLayout ? expectedWorkspace : storedPath;
        const workspaceId = randomUUID();
        const metadataDirectory = createSessionMetadata(session.id, this.appDataDirectory);
        insertWorkspace.run(workspaceId, workspacePath, now);
        attachWorkspace.run(workspaceId, metadataDirectory, session.id);
      }
    })();
  }

  private migrateStructuralHistory() {
    const sessionColumns = this.db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all();
    const sessionNames = new Set(sessionColumns.map(column => column.name));
    if (!sessionNames.has('branch_history_mode')) {
      this.db.run("ALTER TABLE sessions ADD COLUMN branch_history_mode TEXT NOT NULL DEFAULT 'copied'");
    }
    if (!sessionNames.has('inherited_message_count')) {
      this.db.run('ALTER TABLE sessions ADD COLUMN inherited_message_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!sessionNames.has('handoff_pending')) {
      this.db.run('ALTER TABLE sessions ADD COLUMN handoff_pending INTEGER NOT NULL DEFAULT 0');
      this.db.run(`UPDATE sessions SET handoff_pending = 1
        WHERE parent_session_id IS NOT NULL AND sdk_session_id IS NULL`);
    }
    if (!sessionNames.has('context_fidelity')) {
      this.db.run("ALTER TABLE sessions ADD COLUMN context_fidelity TEXT NOT NULL DEFAULT 'native'");
      this.db.run(`UPDATE sessions SET context_fidelity = 'portable'
        WHERE parent_session_id IS NOT NULL`);
    }

    const messageColumns = this.db.query<{ name: string }, []>('PRAGMA table_info(messages)').all();
    if (!messageColumns.some(column => column.name === 'ordinal')) {
      this.db.run('ALTER TABLE messages ADD COLUMN ordinal INTEGER');
    }

    const unordered = this.db.query<{
      id: string;
      session_id: string;
    }, []>(`SELECT id, session_id FROM messages WHERE ordinal IS NULL
      ORDER BY session_id, timestamp, rowid`).all();
    let currentSession = '';
    let ordinal = 0;
    const updateOrdinal = this.db.query('UPDATE messages SET ordinal = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const message of unordered) {
        if (message.session_id !== currentSession) {
          currentSession = message.session_id;
          ordinal = 0;
        }
        updateOrdinal.run(ordinal++, message.id);
      }
    })();
    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal ON messages(session_id, ordinal)');
  }

  // Session operations
  createSession(title: string = "New Chat", workingDirectory?: string, mode: 'general' | 'coder' | 'intense-research' | 'spark' = 'general', githubRepo?: string, model?: string): Session {
    const id = randomUUID();
    const now = new Date().toISOString();
    const workspaceId = randomUUID();
    const metadataDirectory = createSessionMetadata(id, this.appDataDirectory);
    const makeManagedWorkspace = () => {
      try {
        return createManagedWorkspace(id, workspaceId, this.managedBaseDirectory);
      } catch (error) {
        deleteSessionMetadata(id, this.appDataDirectory);
        throw error;
      }
    };
    let finalWorkingDir: string;
    let workspace: WorkspaceRecord;

    if (workingDirectory) {
      const expandedPath = expandPath(workingDirectory);
      const validation = validateDirectory(expandedPath);

      if (!validation.valid) {
        console.warn('⚠️  Invalid working directory provided:', validation.error);
        const managed = makeManagedWorkspace();
        finalWorkingDir = managed.root;
        workspace = {
          id: workspaceId,
          path: managed.workspacePath,
          origin: 'managed',
          deletion_policy: 'delete_when_unreferenced',
          managed_root: managed.root,
          ownership_token: managed.ownershipToken,
          status: 'ready',
        };
      } else {
        finalWorkingDir = expandedPath;
        workspace = {
          id: workspaceId,
          path: expandedPath,
          origin: 'external',
          deletion_policy: 'never',
          status: 'ready',
        };
      }
    } else {
      const managed = makeManagedWorkspace();
      finalWorkingDir = managed.root;
      workspace = {
        id: workspaceId,
        path: managed.workspacePath,
        origin: 'managed',
        deletion_policy: 'delete_when_unreferenced',
        managed_root: managed.root,
        ownership_token: managed.ownershipToken,
        status: 'ready',
      };
    }

    try {
      setupSessionCommands(metadataDirectory, mode);
      this.db.transaction(() => {
        this.insertWorkspace(workspace, now);
        this.db.run(
          `INSERT INTO sessions (
            id, title, created_at, updated_at, working_directory, permission_mode,
            mode, github_repo, model, workspace_id, metadata_directory
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, title, now, now, finalWorkingDir, 'default', mode, githubRepo || null,
            model || null, workspaceId, metadataDirectory]
        );
      })();
    } catch (error) {
      this.db.run('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
      if (workspace.origin === 'managed') {
        deleteManagedWorkspace(workspace, this.managedBaseDirectory);
      }
      deleteSessionMetadata(id, this.appDataDirectory);
      throw error;
    }

    return this.getSession(id)!;
  }

  private insertWorkspace(workspace: WorkspaceRecord, createdAt: string): void {
    this.db.run(
      `INSERT INTO workspaces (
        id, path, origin, deletion_policy, managed_root, ownership_token,
        status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workspace.id, workspace.path, workspace.origin, workspace.deletion_policy,
        workspace.managed_root || null, workspace.ownership_token || null,
        workspace.status, workspace.error || null, createdAt]
    );
  }

  private getWorkspace(workspaceId: string | undefined): WorkspaceRecord | null {
    if (!workspaceId) return null;
    return this.db.query<WorkspaceRecord, [string]>(
      'SELECT * FROM workspaces WHERE id = ?'
    ).get(workspaceId) || null;
  }

  getSessions(): { sessions: Session[]; recreatedDirectories: string[] } {
    const sessions = this.db
      .query<Session, []>(
        `SELECT
          s.id,
          s.title,
          s.created_at,
          s.updated_at,
          s.working_directory,
          s.permission_mode,
          s.mode,
          s.sdk_session_id,
          s.context_input_tokens,
          s.context_window,
          s.context_percentage,
          s.output_tokens,
          s.github_repo,
          s.parent_session_id,
          s.branch_point_message_id,
          s.branch_history_mode,
          s.inherited_message_count,
          s.handoff_pending,
          s.context_fidelity,
          s.model,
          s.workspace_id,
          s.metadata_directory,
          w.path as workspace_path,
          w.origin as workspace_origin,
          w.status as workspace_status,
          w.error as workspace_error,
          w.managed_root,
          COALESCE(s.inherited_message_count, 0) + COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        LEFT JOIN workspaces w ON s.workspace_id = w.id
        WHERE s.deleted_at IS NULL
        GROUP BY s.id
        ORDER BY s.updated_at DESC`
      )
      .all();

    // Missing external paths must never be recreated by Agentic. Managed paths
    // also require a valid ownership marker, so report them without mutation.
    const recreatedDirectories: string[] = [];

    for (const session of sessions) {
      if (session.workspace_path && !fs.existsSync(session.workspace_path)) {
        console.warn(`⚠️  Missing workspace for session ${session.id}: ${session.workspace_path}`);
      }
    }

    return { sessions, recreatedDirectories };
  }

  getSession(sessionId: string): Session | null {
    const session = this.db
      .query<Session, [string]>(
        `SELECT
          s.id,
          s.title,
          s.created_at,
          s.updated_at,
          s.working_directory,
          s.permission_mode,
          s.mode,
          s.sdk_session_id,
          s.context_input_tokens,
          s.context_window,
          s.context_percentage,
          s.output_tokens,
          s.github_repo,
          s.parent_session_id,
          s.branch_point_message_id,
          s.branch_history_mode,
          s.inherited_message_count,
          s.handoff_pending,
          s.context_fidelity,
          s.model,
          s.workspace_id,
          s.metadata_directory,
          w.path as workspace_path,
          w.origin as workspace_origin,
          w.status as workspace_status,
          w.error as workspace_error,
          w.managed_root,
          COALESCE(s.inherited_message_count, 0) + COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        LEFT JOIN workspaces w ON s.workspace_id = w.id
        WHERE s.id = ? AND s.deleted_at IS NULL
        GROUP BY s.id`
      )
      .get(sessionId);

    return session || null;
  }

  private getSessionRecord(sessionId: string): Session | null {
    return this.db.query<Session, [string]>(`SELECT
      s.*,
      w.path as workspace_path,
      w.origin as workspace_origin,
      w.status as workspace_status,
      w.error as workspace_error,
      w.managed_root,
      COALESCE(s.inherited_message_count, 0)
        + (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
      FROM sessions s
      LEFT JOIN workspaces w ON s.workspace_id = w.id
      WHERE s.id = ?`).get(sessionId) || null;
  }

  getRuntimePaths(sessionId: string) {
    const session = this.getSession(sessionId);
    return session ? getRuntimeSessionPaths(session) : null;
  }

  updateWorkingDirectory(sessionId: string, directory: string): boolean {
    try {
      // Expand and validate path
      const expandedPath = expandPath(directory);
      const validation = validateDirectory(expandedPath);

      if (!validation.valid) {
        console.error('❌ Invalid working directory:', validation.error);
        return false;
      }

      console.log('📁 Updating working directory:', {
        session: sessionId,
        directory: expandedPath
      });

      const workspaceId = randomUUID();
      const now = new Date().toISOString();
      this.insertWorkspace({
        id: workspaceId,
        path: expandedPath,
        origin: 'external',
        deletion_policy: 'never',
        status: 'ready',
      }, now);

      const result = this.db.run(
        `UPDATE sessions SET working_directory = ?, workspace_id = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
        [expandedPath, workspaceId, now, sessionId]
      );

      if (result.changes === 0) {
        this.db.run('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
      }

      const success = result.changes > 0;
      if (success) {
        console.log('✅ Working directory updated successfully');
      } else {
        console.warn('⚠️  No session found to update');
      }

      return success;
    } catch (error) {
      console.error('❌ Failed to update working directory:', error);
      return false;
    }
  }

  updatePermissionMode(sessionId: string, mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'): boolean {
    try {
      const result = this.db.run(
        "UPDATE sessions SET permission_mode = ?, updated_at = ? WHERE id = ?",
        [mode, new Date().toISOString(), sessionId]
      );

      const success = result.changes > 0;
      if (!success) {
        console.warn('⚠️  No session found to update');
      }

      return success;
    } catch (error) {
      console.error('❌ Failed to update permission mode:', error);
      return false;
    }
  }

  updateSdkSessionId(sessionId: string, sdkSessionId: string | null): boolean {
    try {
      const result = this.db.run(
        `UPDATE sessions SET sdk_session_id = ?,
          handoff_pending = CASE WHEN ? IS NOT NULL THEN 0 ELSE handoff_pending END,
          updated_at = ? WHERE id = ?`,
        [sdkSessionId, sdkSessionId, new Date().toISOString(), sessionId]
      );

      const success = result.changes > 0;
      if (!success) {
        console.warn('⚠️  No session found to update');
      }

      return success;
    } catch (error) {
      console.error('❌ Failed to update SDK session ID:', error);
      return false;
    }
  }

  updateContextUsage(sessionId: string, inputTokens: number, contextWindow: number, contextPercentage: number, outputTokens?: number): boolean {
    try {
      // Use SDK's reported inputTokens directly (it includes full context)
      const result = this.db.run(
        "UPDATE sessions SET context_input_tokens = ?, context_window = ?, context_percentage = ?, output_tokens = COALESCE(?, output_tokens, 0), updated_at = ? WHERE id = ?",
        [inputTokens, contextWindow, contextPercentage, outputTokens ?? null, new Date().toISOString(), sessionId]
      );

      const success = result.changes > 0;
      if (!success) {
        console.warn('⚠️  No session found to update context usage');
      }

      return success;
    } catch (error) {
      console.error('❌ Failed to update context usage:', error);
      return false;
    }
  }

  updateGithubRepo(sessionId: string, githubRepo: string | null): boolean {
    try {
      const result = this.db.run(
        "UPDATE sessions SET github_repo = ?, updated_at = ? WHERE id = ?",
        [githubRepo, new Date().toISOString(), sessionId]
      );

      const success = result.changes > 0;
      if (success) {
        console.log(`✅ GitHub repo ${githubRepo ? 'set to ' + githubRepo : 'cleared'} for session ${sessionId.substring(0, 8)}`);
      } else {
        console.warn('⚠️  No session found to update GitHub repo');
      }

      return success;
    } catch (error) {
      console.error('❌ Failed to update GitHub repo:', error);
      return false;
    }
  }

  deleteSession(sessionId: string): boolean {
    const session = this.getSessionRecord(sessionId);
    if (!session || session.deleted_at) return false;

    const workspaceId = session.workspace_id;
    const parentId = session.parent_session_id;
    const childCount = this.db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) as count FROM sessions WHERE parent_session_id = ?'
    ).get(sessionId)?.count || 0;

    deleteSessionMetadata(sessionId, this.appDataDirectory);
    this.db.transaction(() => {
      if (childCount > 0) {
        this.db.run(
          'UPDATE sessions SET deleted_at = ?, workspace_id = NULL WHERE id = ?',
          [new Date().toISOString(), sessionId]
        );
      } else {
        this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
      }
    })();

    this.cleanupWorkspaceIfUnreferenced(workspaceId);
    this.pruneDeletedAncestors(parentId);
    return true;
  }

  private cleanupWorkspaceIfUnreferenced(workspaceId: string | undefined): void {
    if (!workspaceId) return;
    const references = this.db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ?'
    ).get(workspaceId)?.count || 0;
    if (references > 0 || this.activeCopyWorkspaceIds.has(workspaceId)) return;

    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) return;
    if (workspace.origin === 'managed'
      && !deleteManagedWorkspace(workspace, this.managedBaseDirectory)) return;
    this.db.run('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
  }

  private pruneDeletedAncestors(startId: string | undefined): void {
    let sessionId = startId;
    while (sessionId) {
      const session = this.getSessionRecord(sessionId);
      if (!session || !session.deleted_at) return;
      const childCount = this.db.query<{ count: number }, [string]>(
        'SELECT COUNT(*) as count FROM sessions WHERE parent_session_id = ?'
      ).get(sessionId)?.count || 0;
      if (childCount > 0) return;

      const parentId = session.parent_session_id;
      this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
      this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
      sessionId = parentId;
    }
  }

  renameSession(sessionId: string, newTitle: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.run(
      "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
      [newTitle, now, sessionId]
    );
    return result.changes > 0;
  }

  // Message operations
  addMessage(
    sessionId: string,
    type: 'user' | 'assistant',
    content: string,
  ): SessionMessage {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const ordinal = (this.db.query<{ next: number }, [string]>(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 as next FROM messages WHERE session_id = ?'
    ).get(sessionId)?.next) ?? 0;

    this.db.run(
      "INSERT INTO messages (id, session_id, type, content, timestamp, ordinal) VALUES (?, ?, ?, ?, ?, ?)",
      [id, sessionId, type, content, timestamp, ordinal]
    );

    // Update session's updated_at
    this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [
      timestamp,
      sessionId,
    ]);

    return {
      id,
      session_id: sessionId,
      type,
      content,
      timestamp,
      ordinal,
    };
  }

  updateMessage(messageId: string, content: string): void {
    const timestamp = new Date().toISOString();
    this.db.run(
      "UPDATE messages SET content = ?, timestamp = ? WHERE id = ?",
      [content, timestamp, messageId]
    );
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    return this.resolveSessionMessages(sessionId, new Set());
  }

  private resolveSessionMessages(sessionId: string, visited: Set<string>): SessionMessage[] {
    if (visited.has(sessionId)) {
      console.error(`Branch history cycle detected at session ${sessionId}`);
      return [];
    }
    visited.add(sessionId);

    const session = this.getSessionRecord(sessionId);
    if (!session) return [];
    const ownMessages = this.db.query<SessionMessage, [string]>(
      `SELECT id, session_id, type, content, timestamp, ordinal
        FROM messages WHERE session_id = ? ORDER BY ordinal ASC, rowid ASC`
    ).all(sessionId);

    if (session.branch_history_mode !== 'shared' || !session.parent_session_id
      || !session.branch_point_message_id) {
      return ownMessages;
    }

    const parentMessages = this.resolveSessionMessages(session.parent_session_id, visited);
    const branchIndex = parentMessages.findIndex(message => message.id === session.branch_point_message_id);
    if (branchIndex < 0) {
      console.error(`Missing branch point ${session.branch_point_message_id} for ${sessionId}`);
      return ownMessages;
    }
    return [...parentMessages.slice(0, branchIndex + 1), ...ownMessages];
  }

  private resolveSessionMessageIds(sessionId: string, visited = new Set<string>()): string[] {
    if (visited.has(sessionId)) return [];
    visited.add(sessionId);
    const session = this.getSessionRecord(sessionId);
    if (!session) return [];
    const ownIds = this.db.query<{ id: string }, [string]>(
      'SELECT id FROM messages WHERE session_id = ? ORDER BY ordinal ASC, rowid ASC'
    ).all(sessionId).map(message => message.id);

    if (session.branch_history_mode !== 'shared' || !session.parent_session_id
      || !session.branch_point_message_id) {
      return ownIds;
    }
    const parentIds = this.resolveSessionMessageIds(session.parent_session_id, visited);
    const branchIndex = parentIds.indexOf(session.branch_point_message_id);
    return branchIndex < 0 ? ownIds : [...parentIds.slice(0, branchIndex + 1), ...ownIds];
  }

  private getLastEffectiveMessageId(session: Session): string | undefined {
    const ownLast = this.db.query<{ id: string }, [string]>(
      'SELECT id FROM messages WHERE session_id = ? ORDER BY ordinal DESC, rowid DESC LIMIT 1'
    ).get(session.id)?.id;
    if (ownLast) return ownLast;
    return session.branch_history_mode === 'shared'
      ? session.branch_point_message_id
      : undefined;
  }

  clearSessionMessages(sessionId: string): boolean {
    try {
      console.log('🧹 Clearing all messages for session:', sessionId.substring(0, 8));

      const result = this.db.run(
        "DELETE FROM messages WHERE session_id = ?",
        [sessionId]
      );

      const success = result.changes > 0;
      if (success) {
        console.log(`✅ Cleared ${result.changes} messages from session`);
      } else {
        console.log('⚠️  No messages found to clear');
      }

      return success;
    } catch (error) {
      console.error('❌ Failed to clear session messages:', error);
      return false;
    }
  }

  /**
   * Import a session from an exported chat file.
   * Creates a fresh session directory; messages keep their original timestamps.
   * The SDK session ID is intentionally left empty so the first message on the
   * new machine triggers history injection (same path as branch starts).
   */
  importSession(data: {
    session: { title?: string; mode?: string; permission_mode?: string; model?: string; github_repo?: string | null };
    messages: Array<{ type: 'user' | 'assistant'; content: string; timestamp: string }>;
  }): Session | null {
    const now = new Date().toISOString();

    const validModes = ['general', 'coder', 'intense-research', 'spark'];
    const mode = (validModes.includes(data.session.mode ?? '') ? data.session.mode : 'general') as Session['mode'];
    const validPermissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
    const permissionMode = validPermissionModes.includes(data.session.permission_mode ?? '')
      ? data.session.permission_mode!
      : 'default';

    const session = this.createSession(
      data.session.title || 'Imported Chat',
      undefined,
      mode,
      data.session.github_repo || undefined,
      data.session.model,
    );
    const id = session.id;
    this.db.run(
      "UPDATE sessions SET permission_mode = ?, handoff_pending = 1, context_fidelity = 'portable' WHERE id = ?",
      [permissionMode, id]
    );

    let ordinal = 0;
    const insertMessage = this.db.query(
      `INSERT INTO messages (id, session_id, type, content, timestamp, ordinal)
        VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const msg of data.messages) {
        if (msg.type !== 'user' && msg.type !== 'assistant') continue;
        insertMessage.run(
          randomUUID(), id, msg.type, String(msg.content ?? ''), msg.timestamp || now, ordinal++
        );
      }
    })();

    console.log(`📥 Imported session ${id.substring(0, 8)} with ${data.messages.length} messages`);

    return this.getSession(id);
  }

  // ========== BRANCHING METHODS ==========

  /**
   * Create a branched session from a specific message
   */
  createBranchedSession(
    parentSessionId: string,
    requestedBranchPointMessageId?: string,
    model?: string,
    title?: string
  ): Session | null {
    const parentSession = this.getSession(parentSessionId);
    if (!parentSession) {
      console.error('Parent session not found:', parentSessionId);
      return null;
    }

    // A whole-chat branch resolves its tip in O(1). Per-message branching only
    // loads stable IDs, never large message bodies.
    const messageIds = requestedBranchPointMessageId
      ? this.resolveSessionMessageIds(parentSessionId)
      : null;
    const branchPointMessageId = requestedBranchPointMessageId
      || this.getLastEffectiveMessageId(parentSession);
    if (!branchPointMessageId) {
      console.error('Cannot branch an empty session:', parentSessionId);
      return null;
    }
    const branchPointIndex = messageIds
      ? messageIds.indexOf(branchPointMessageId)
      : parentSession.message_count - 1;

    if (branchPointIndex === -1) {
      console.error('Branch point message not found:', branchPointMessageId);
      return null;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const parentWorkspace = this.getWorkspace(parentSession.workspace_id);
    if (!parentWorkspace || parentWorkspace.status !== 'ready') {
      console.error('Parent workspace is not ready:', parentSession.workspace_id);
      return null;
    }
    const metadataDirectory = createSessionMetadata(id, this.appDataDirectory);
    let branchWorkingDir = parentSession.working_directory;
    let branchWorkspaceId = parentWorkspace.id;
    let managedBranchWorkspace: WorkspaceRecord | null = null;

    // User-selected and conservatively migrated workspaces are shared by
    // reference. Only explicitly Agentic-owned workspaces are isolated.
    if (parentWorkspace.origin === 'managed') {
      branchWorkspaceId = randomUUID();
      let managed: ReturnType<typeof createManagedWorkspace>;
      try {
        managed = createManagedWorkspace(id, branchWorkspaceId, this.managedBaseDirectory);
      } catch (error) {
        deleteSessionMetadata(id, this.appDataDirectory);
        console.error('Failed to create managed branch workspace:', error);
        return null;
      }
      branchWorkingDir = managed.root;
      managedBranchWorkspace = {
        id: branchWorkspaceId,
        path: managed.workspacePath,
        origin: 'managed',
        deletion_policy: 'delete_when_unreferenced',
        managed_root: managed.root,
        ownership_token: managed.ownershipToken,
        status: 'preparing',
      };
    }

    // Use provided title or generate from parent with incrementing branch number
    let branchTitle = title;
    if (!branchTitle) {
      const existingBranches = this.getSessionBranches(parentSessionId);
      const branchNumber = existingBranches.length + 1;
      branchTitle = `${parentSession.title} - Branch ${branchNumber}`;
    }

    // Use provided model or inherit from parent
    const branchModel = model || parentSession.model || undefined;

    try {
      setupSessionCommands(metadataDirectory, parentSession.mode);
      this.db.transaction(() => {
        if (managedBranchWorkspace) this.insertWorkspace(managedBranchWorkspace, now);
        this.db.run(
          `INSERT INTO sessions (
            id, title, created_at, updated_at, working_directory,
            permission_mode, mode, github_repo, model,
            parent_session_id, branch_point_message_id, workspace_id,
            metadata_directory, branch_history_mode, inherited_message_count,
            handoff_pending, context_fidelity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shared', ?, 1, 'portable')`,
          [
            id, branchTitle, now, now, branchWorkingDir,
            parentSession.permission_mode,
            parentSession.mode,
            parentSession.github_repo || null,
            branchModel || null,
            parentSessionId,
            branchPointMessageId,
            branchWorkspaceId,
            metadataDirectory,
            branchPointIndex + 1,
          ]
        );
      })();
    } catch (error) {
      if (managedBranchWorkspace) {
        deleteManagedWorkspace(managedBranchWorkspace, this.managedBaseDirectory);
      }
      deleteSessionMetadata(id, this.appDataDirectory);
      console.error('Failed to persist branch:', error);
      return null;
    }

    if (managedBranchWorkspace) {
      this.prepareManagedBranchWorkspace(parentWorkspace, managedBranchWorkspace);
    }

    console.log(`✅ Created branch session ${id.substring(0, 8)} from ${parentSessionId.substring(0, 8)} at message ${branchPointIndex + 1}`);

    return this.getSession(id);
  }

  private prepareManagedBranchWorkspace(
    parent: WorkspaceRecord,
    branch: WorkspaceRecord,
  ): void {
    this.activeCopyWorkspaceIds.add(parent.id);
    this.activeCopyWorkspaceIds.add(branch.id);
    void copyManagedWorkspace(parent.path, branch.path)
      .then(async () => {
        if (fs.existsSync(path.join(branch.path, '.git')) && isGitHubConnected()) {
          try {
            await configureGitCredentials(branch.path);
          } catch (error) {
            console.warn('⚠️ Could not configure git credentials for branch:', error);
          }
        }
        this.db.run("UPDATE workspaces SET status = 'ready', error = NULL WHERE id = ?", [branch.id]);
        console.log(`📁 Managed branch workspace ready: ${branch.path}`);
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.db.run("UPDATE workspaces SET status = 'failed', error = ? WHERE id = ?", [message, branch.id]);
        console.warn(`⚠️  Managed branch workspace copy failed:`, error);
      })
      .finally(() => {
        this.activeCopyWorkspaceIds.delete(parent.id);
        this.activeCopyWorkspaceIds.delete(branch.id);
        this.cleanupWorkspaceIfUnreferenced(parent.id);
        this.cleanupWorkspaceIfUnreferenced(branch.id);
      });
  }

  /**
   * Get all child branches of a session
   */
  getSessionBranches(sessionId: string): BranchInfo[] {
    return this.db
      .query<BranchInfo, [string]>(
        `SELECT
          s.id as sessionId,
          s.title,
          s.created_at,
          s.branch_point_message_id,
          s.model,
          COALESCE(s.inherited_message_count, 0) + COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        WHERE s.parent_session_id = ? AND s.deleted_at IS NULL
        GROUP BY s.id
        ORDER BY s.created_at DESC`
      )
      .all(sessionId);
  }

  /**
   * Get parent session info
   */
  getParentSession(sessionId: string): Session | null {
    const session = this.getSession(sessionId);
    if (!session || !session.parent_session_id) {
      return null;
    }
    return this.getSession(session.parent_session_id);
  }

  /**
   * Get all sessions in branch tree (parent, siblings, children)
   */
  getBranchTree(sessionId: string): {
    parent: Session | null;
    current: Session | null;
    siblings: BranchInfo[];
    children: BranchInfo[];
  } {
    const current = this.getSession(sessionId);
    if (!current) {
      return { parent: null, current: null, siblings: [], children: [] };
    }

    const parent = current.parent_session_id
      ? this.getSession(current.parent_session_id)
      : null;

    const siblings = parent
      ? this.getSessionBranches(parent.id).filter(b => b.sessionId !== sessionId)
      : [];

    const children = this.getSessionBranches(sessionId);

    return { parent, current, siblings, children };
  }

  /**
   * Update model for a session
   */
  updateSessionModel(sessionId: string, model: string): boolean {
    try {
      const result = this.db.run(
        "UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?",
        [model, new Date().toISOString(), sessionId]
      );

      return result.changes > 0;
    } catch (error) {
      console.error('Failed to update session model:', error);
      return false;
    }
  }

  /**
   * Check if message is a branch point
   */
  isMessageBranchPoint(messageId: string): boolean {
    const result = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM sessions WHERE branch_point_message_id = ? AND deleted_at IS NULL"
      )
      .get(messageId);

    return (result?.count || 0) > 0;
  }

  /**
   * Get branches from a specific message
   */
  getBranchesFromMessage(sessionId: string, messageId: string): BranchInfo[] {
    return this.db
      .query<BranchInfo, [string, string]>(
        `SELECT
          s.id as sessionId,
          s.title,
          s.created_at,
          s.branch_point_message_id,
          s.model,
          COALESCE(s.inherited_message_count, 0) + COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        WHERE s.parent_session_id = ?
        AND s.branch_point_message_id = ?
        AND s.deleted_at IS NULL
        GROUP BY s.id
        ORDER BY s.created_at DESC`
      )
      .all(sessionId, messageId);
  }

  close() {
    this.db.close();
  }
}

// Singleton instance
export const sessionDb = new SessionDatabase();
