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
import { getDefaultWorkingDirectory, expandPath, validateDirectory, getAppDataDirectory, getSessionPaths, getSessionPathsFromWorkingDir } from "./directoryUtils";
import { deleteSessionPictures, deleteSessionFiles } from "./imageUtils";
import { setupSessionCommands } from "./commandSetup";
import { migrateSessionIfNeeded } from "./migrations/migrateSessionStructure";
import { generateChatTitle } from "./utils/chatTitles";

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  working_directory: string;
  permission_mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  mode: 'general' | 'coder' | 'intense-research' | 'spark';
  sdk_session_id?: string; // SDK's internal session ID for resume functionality
  context_input_tokens?: number;
  context_window?: number;
  context_percentage?: number;
  github_repo?: string; // GitHub repo full_name (e.g., "owner/repo") when connected
  // Branching support
  parent_session_id?: string; // Parent session ID (null for root sessions)
  branch_point_message_id?: string; // Message ID where branch occurred
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
}

class SessionDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    // Use app data directory if no path provided
    if (!dbPath) {
      const appDataDir = getAppDataDirectory();
      // Create directory if it doesn't exist
      if (!fs.existsSync(appDataDir)) {
        fs.mkdirSync(appDataDir, { recursive: true });
        console.log('📁 Created app data directory:', appDataDir);
      }
      dbPath = path.join(appDataDir, 'sessions.db');
    }

    try {
      this.db = new Database(dbPath, { create: true });
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

    // Migration: Add branching columns if they don't exist
    this.migrateBranching();
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
          ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions'
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

  // Session operations
  createSession(title: string = "New Chat", workingDirectory?: string, mode: 'general' | 'coder' | 'intense-research' | 'spark' = 'general', githubRepo?: string): Session {
    const id = randomUUID();
    const now = new Date().toISOString();

    let finalWorkingDir: string;

    if (workingDirectory) {
      // User provided a custom directory
      const expandedPath = expandPath(workingDirectory);
      const validation = validateDirectory(expandedPath);

      if (!validation.valid) {
        console.warn('⚠️  Invalid working directory provided:', validation.error);
        // Fall back to auto-generated chat folder
        finalWorkingDir = this.createChatDirectory(id);
      } else {
        finalWorkingDir = expandedPath;
      }
    } else {
      // Auto-generate chat folder: ~/Documents/agentic/chat-{short-id}/
      finalWorkingDir = this.createChatDirectory(id);
    }

    this.db.run(
      "INSERT INTO sessions (id, title, created_at, updated_at, working_directory, permission_mode, mode, github_repo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, title, now, now, finalWorkingDir, 'bypassPermissions', mode, githubRepo || null]
    );

    // Setup slash commands for this session
    setupSessionCommands(finalWorkingDir, mode);

    return {
      id,
      title,
      created_at: now,
      updated_at: now,
      message_count: 0,
      working_directory: finalWorkingDir,
      permission_mode: 'bypassPermissions',
      mode,
      github_repo: githubRepo,
    };
  }

  private createChatDirectory(sessionId: string): string {
    // Phase 0.1: Create new directory structure with metadata/ and workspace/ separation
    const paths = getSessionPaths(sessionId);

    try {
      // Create directory structure
      if (!fs.existsSync(paths.root)) {
        fs.mkdirSync(paths.root, { recursive: true });
        console.log('✅ Created session root:', paths.root);
      }

      if (!fs.existsSync(paths.claudeDir)) {
        fs.mkdirSync(paths.claudeDir, { recursive: true });
        console.log('✅ Created .claude directory');
      }

      if (!fs.existsSync(paths.metadata)) {
        fs.mkdirSync(paths.metadata, { recursive: true });
        console.log('✅ Created metadata directory');
      }

      if (!fs.existsSync(paths.attachments)) {
        fs.mkdirSync(paths.attachments, { recursive: true });
        console.log('✅ Created attachments directory');
      }

      if (!fs.existsSync(paths.workspace)) {
        fs.mkdirSync(paths.workspace, { recursive: true });
        console.log('✅ Created workspace directory');
      }

    } catch (error) {
      console.error('❌ Failed to create session directory structure:', error);
      // Fall back to base directory if creation fails
      return getDefaultWorkingDirectory();
    }

    // Return root (stored in database as working_directory)
    return paths.root;
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
          s.github_repo,
          s.parent_session_id,
          s.branch_point_message_id,
          s.model,
          COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        GROUP BY s.id
        ORDER BY s.updated_at DESC`
      )
      .all();

    // Validate and recreate missing directories
    const recreatedDirectories: string[] = [];

    for (const session of sessions) {
      if (session.working_directory && !fs.existsSync(session.working_directory)) {
        console.warn(`⚠️  Missing directory for session ${session.id}: ${session.working_directory}`);

        try {
          fs.mkdirSync(session.working_directory, { recursive: true });
          console.log(`✅ Recreated directory: ${session.working_directory}`);
          recreatedDirectories.push(session.working_directory);
        } catch (error) {
          console.error(`❌ Failed to recreate directory: ${session.working_directory}`, error);
        }
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
          s.github_repo,
          s.parent_session_id,
          s.branch_point_message_id,
          s.model,
          COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        WHERE s.id = ?
        GROUP BY s.id`
      )
      .get(sessionId);

    // Phase 0.1: Auto-migrate session to new structure if needed
    if (session) {
      try {
        migrateSessionIfNeeded(sessionId);
      } catch (error) {
        // Don't fail session loading if migration fails
        console.error(`⚠️  Failed to auto-migrate session ${sessionId}:`, error);
      }
    }

    return session || null;
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

      const result = this.db.run(
        "UPDATE sessions SET working_directory = ?, updated_at = ? WHERE id = ?",
        [expandedPath, new Date().toISOString(), sessionId]
      );

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
        "UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?",
        [sdkSessionId, new Date().toISOString(), sessionId]
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

  updateContextUsage(sessionId: string, inputTokens: number, contextWindow: number, contextPercentage: number): boolean {
    try {
      // Use SDK's reported inputTokens directly (it includes full context)
      const result = this.db.run(
        "UPDATE sessions SET context_input_tokens = ?, context_window = ?, context_percentage = ?, updated_at = ? WHERE id = ?",
        [inputTokens, contextWindow, contextPercentage, new Date().toISOString(), sessionId]
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
    // Get session to access working directory before deletion
    const session = this.getSession(sessionId);

    // Delete pictures and files folders if session exists
    if (session && session.working_directory) {
      deleteSessionPictures(session.working_directory);
      deleteSessionFiles(session.working_directory);
    }

    const result = this.db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    return result.changes > 0;
  }

  renameSession(sessionId: string, newTitle: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.run(
      "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
      [newTitle, now, sessionId]
    );
    return result.changes > 0;
  }

  renameFolderAndSession(sessionId: string, newFolderName: string): { success: boolean; error?: string; newPath?: string } {
    try {
      // Validate folder name (max 15 chars, lowercase + dashes only)
      if (newFolderName.length > 15) {
        return { success: false, error: 'Folder name must be 15 characters or less' };
      }
      if (!/^[a-z0-9-]+$/.test(newFolderName)) {
        return { success: false, error: 'Only lowercase letters, numbers, and dashes allowed' };
      }

      // Get current session
      const session = this.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      const oldPath = session.working_directory;
      const baseDir = getDefaultWorkingDirectory();
      const newPath = path.join(baseDir, newFolderName);

      // Check if new path already exists
      if (fs.existsSync(newPath) && newPath !== oldPath) {
        return { success: false, error: 'Folder name already exists' };
      }

      // Rename the directory
      if (oldPath !== newPath) {
        fs.renameSync(oldPath, newPath);
        console.log('✅ Renamed folder:', { from: oldPath, to: newPath });
      }

      // Ensure workspace subdirectory exists (in case of legacy structure)
      const paths = getSessionPathsFromWorkingDir(newPath);
      if (!fs.existsSync(paths.workspace)) {
        fs.mkdirSync(paths.workspace, { recursive: true });
        console.log('✅ Created workspace directory in renamed folder');
      }
      if (!fs.existsSync(paths.metadata)) {
        fs.mkdirSync(paths.metadata, { recursive: true });
        console.log('✅ Created metadata directory in renamed folder');
      }

      // Update database
      const now = new Date().toISOString();
      const result = this.db.run(
        "UPDATE sessions SET title = ?, working_directory = ?, updated_at = ? WHERE id = ?",
        [newFolderName, newPath, now, sessionId]
      );

      if (result.changes > 0) {
        console.log('✅ Updated session in database');
        return { success: true, newPath };
      } else {
        // Rollback folder rename if database update failed
        if (oldPath !== newPath && fs.existsSync(newPath)) {
          fs.renameSync(newPath, oldPath);
        }
        return { success: false, error: 'Failed to update database' };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Failed to rename folder:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  // Message operations
  addMessage(
    sessionId: string,
    type: 'user' | 'assistant',
    content: string
  ): SessionMessage {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    this.db.run(
      "INSERT INTO messages (id, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      [id, sessionId, type, content, timestamp]
    );

    // Auto-generate title from first user message using AI
    if (type === 'user') {
      const session = this.getSession(sessionId);
      if (session && session.title === 'New Chat') {
        // Generate title asynchronously (don't block message saving)
        generateChatTitle(content).then(title => {
          this.renameSession(sessionId, title);
        }).catch(err => {
          console.warn('Title generation failed:', err);
          // Fallback to simple truncation
          let title = content.trim().substring(0, 60);
          if (content.length > 60) {
            title += '...';
          }
          this.renameSession(sessionId, title);
        });
      }
    }

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
    const messages = this.db
      .query<SessionMessage, [string]>(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC"
      )
      .all(sessionId);

    return messages;
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

  // ========== BRANCHING METHODS ==========

  /**
   * Create a branched session from a specific message
   */
  createBranchedSession(
    parentSessionId: string,
    branchPointMessageId: string,
    model?: string,
    title?: string
  ): Session | null {
    const parentSession = this.getSession(parentSessionId);
    if (!parentSession) {
      console.error('Parent session not found:', parentSessionId);
      return null;
    }

    // Verify branch point message exists in parent session
    const messages = this.getSessionMessages(parentSessionId);
    const branchPointIndex = messages.findIndex(m => m.id === branchPointMessageId);

    if (branchPointIndex === -1) {
      console.error('Branch point message not found:', branchPointMessageId);
      return null;
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    // Create new directory for branch
    const branchWorkingDir = this.createChatDirectory(id);

    // Copy workspace files from parent session
    const parentPaths = getSessionPathsFromWorkingDir(parentSession.working_directory);
    const branchPaths = getSessionPaths(id);

    if (fs.existsSync(parentPaths.workspace)) {
      try {
        // Copy entire workspace directory from parent to branch
        fs.cpSync(parentPaths.workspace, branchPaths.workspace, { recursive: true });
        console.log(`📁 Copied workspace files from parent session`);
      } catch (error) {
        console.warn(`⚠️  Could not copy workspace files:`, error);
        // Continue without workspace files - not a fatal error
      }
    }

    // Use provided title or generate from parent
    const branchTitle = title || `${parentSession.title}-branch`;

    // Use provided model or inherit from parent
    const branchModel = model || parentSession.model || undefined;

    this.db.run(
      `INSERT INTO sessions (
        id, title, created_at, updated_at, working_directory,
        permission_mode, mode, github_repo, model,
        parent_session_id, branch_point_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, branchTitle, now, now, branchWorkingDir,
        parentSession.permission_mode,
        parentSession.mode,
        parentSession.github_repo || null,
        branchModel || null,
        parentSessionId,
        branchPointMessageId
      ]
    );

    // Copy messages up to and including branch point
    const messagesToCopy = messages.slice(0, branchPointIndex + 1);
    for (const msg of messagesToCopy) {
      const newMsgId = randomUUID();
      this.db.run(
        "INSERT INTO messages (id, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)",
        [newMsgId, id, msg.type, msg.content, msg.timestamp]
      );
    }

    // Setup slash commands for this session
    setupSessionCommands(branchWorkingDir, parentSession.mode);

    console.log(`✅ Created branch session ${id.substring(0, 8)} from ${parentSessionId.substring(0, 8)} at message ${branchPointIndex + 1}`);

    return this.getSession(id);
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
          COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        WHERE s.parent_session_id = ?
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
        "SELECT COUNT(*) as count FROM sessions WHERE branch_point_message_id = ?"
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
          COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        WHERE s.parent_session_id = ?
        AND s.branch_point_message_id = ?
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
