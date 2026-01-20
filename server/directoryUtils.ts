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

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Detect if running in WSL (Windows Subsystem for Linux)
 */
function isWSL(): boolean {
  try {
    // Check if /proc/version contains "microsoft" or "WSL"
    if (fs.existsSync('/proc/version')) {
      const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      return version.includes('microsoft') || version.includes('wsl');
    }
  } catch {
    // Ignore errors
  }
  return false;
}

/**
 * Get Windows username from WSL environment
 */
function getWindowsUsername(): string | null {
  try {
    // Try to get Windows username from environment or /mnt/c path
    const wslEnvUser = process.env.WSL_DISTRO_NAME ? process.env.USER : null;

    // Try to read from /mnt/c/Users directory
    if (fs.existsSync('/mnt/c/Users')) {
      const users = fs.readdirSync('/mnt/c/Users');
      // Filter out system folders
      const realUsers = users.filter(u =>
        !['Public', 'Default', 'Default User', 'All Users'].includes(u) &&
        !u.startsWith('.')
      );

      // If there's only one user, use that
      if (realUsers.length === 1) {
        return realUsers[0];
      }

      // Try to match WSL username
      if (wslEnvUser && realUsers.includes(wslEnvUser)) {
        return wslEnvUser;
      }

      // Check current path for username hint
      const cwd = process.cwd();
      if (cwd.startsWith('/mnt/c/Users/')) {
        const username = cwd.split('/')[4];
        if (realUsers.includes(username)) {
          return username;
        }
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Get the default working directory for agent operations
 * Cross-platform: ~/projects/agentic (Linux/Mac/WSL) or C:\Users\{user}\projects\agentic (Windows)
 *
 * WSL: Uses Linux filesystem (~/projects/agentic) for 10-20x faster I/O
 *      instead of Windows path (/mnt/c/...) which has significant overhead
 *
 * NOTE: Includes automatic migration from legacy directories:
 * - ~/Documents/agent-smith (original name)
 * - ~/Documents/agentic (previous default)
 * - /mnt/c/Users/.../Documents/agentic (WSL on Windows filesystem)
 */
export function getDefaultWorkingDirectory(): string {
  // Check for environment variable override first
  const envPath = process.env.AGENTIC_WORKSPACE_DIR;
  if (envPath) {
    const expanded = expandPath(envPath);
    console.log('📁 Using workspace from AGENTIC_WORKSPACE_DIR:', expanded);
    return expanded;
  }

  // Use Linux home directory (even in WSL - for performance)
  const homeDir = os.homedir();

  // New default: ~/projects/agentic (Linux-native path for performance)
  const newDir = path.join(homeDir, 'projects', 'agentic');

  // Legacy directories to migrate from
  const legacyDirs = [
    path.join(homeDir, 'Documents', 'agent-smith'),  // Original name
    path.join(homeDir, 'Documents', 'agentic'),      // Previous default
  ];

  // WSL-specific: Also check Windows filesystem for migration
  if (isWSL()) {
    const windowsUser = getWindowsUsername();
    if (windowsUser) {
      legacyDirs.push(`/mnt/c/Users/${windowsUser}/Documents/agentic`);
      legacyDirs.push(`/mnt/c/Users/${windowsUser}/Documents/agent-smith`);
    }
    console.log('🪟 WSL detected, using Linux filesystem for better performance');
  }

  // Auto-migrate from legacy directories if new one doesn't exist
  if (!fs.existsSync(newDir)) {
    for (const legacyDir of legacyDirs) {
      if (fs.existsSync(legacyDir)) {
        try {
          // Ensure parent directory exists
          fs.mkdirSync(path.dirname(newDir), { recursive: true });
          fs.cpSync(legacyDir, newDir, { recursive: true });
          console.log(`✅ Migrated workspaces from ${legacyDir} to ${newDir}`);
          break;  // Stop after first successful migration
        } catch (err) {
          console.warn(`⚠️  Could not auto-migrate from ${legacyDir}:`, err);
        }
      }
    }
  }

  return newDir;
}

/**
 * Get the app data directory for storing database and app files
 * Cross-platform: ~/Documents/agentic-app
 *
 * NOTE: Includes automatic migration from legacy 'agent-smith-app' directory
 */
export function getAppDataDirectory(): string {
  const homeDir = os.homedir();
  const newDir = path.join(homeDir, 'Documents', 'agentic-app');
  const legacyDir = path.join(homeDir, 'Documents', 'agent-smith-app');

  // Auto-migrate from legacy directory if it exists and new one doesn't
  if (fs.existsSync(legacyDir) && !fs.existsSync(newDir)) {
    try {
      fs.cpSync(legacyDir, newDir, { recursive: true });
      console.log('✅ Migrated app data from ~/Documents/agent-smith-app to ~/Documents/agentic-app');
    } catch {
      console.warn('⚠️  Could not auto-migrate legacy app data directory');
    }
  }

  return newDir;
}

/**
 * Expand tilde (~) in path to actual home directory
 * Works cross-platform
 */
export function expandPath(dirPath: string): string {
  if (!dirPath) return dirPath;

  // If path starts with ~, replace with home directory
  if (dirPath.startsWith('~/') || dirPath === '~') {
    const homeDir = os.homedir();
    const expanded = dirPath === '~'
      ? homeDir
      : path.join(homeDir, dirPath.slice(2));

    console.log('🔄 Path expansion:', {
      original: dirPath,
      expanded: expanded
    });

    return expanded;
  }

  // Return absolute path as-is
  return path.resolve(dirPath);
}

/**
 * Validate that a directory exists and is accessible
 */
export function validateDirectory(dirPath: string): { valid: boolean; error?: string; expanded?: string } {
  try {
    // Expand path first
    const expanded = expandPath(dirPath);

    // Check if path exists
    if (!fs.existsSync(expanded)) {
      console.warn('⚠️  Directory does not exist:', expanded);
      return {
        valid: false,
        error: 'Directory does not exist',
        expanded
      };
    }

    // Check if it's actually a directory (follows symlinks)
    const stats = fs.statSync(expanded);
    if (!stats.isDirectory()) {
      console.warn('⚠️  Path is not a directory:', expanded);
      return {
        valid: false,
        error: 'Path is not a directory',
        expanded
      };
    }

    // Check if it's a symbolic link (log warning but allow)
    const lstat = fs.lstatSync(expanded);
    if (lstat.isSymbolicLink()) {
      console.warn('⚠️  Path is a symbolic link:', expanded);
      console.log('🔗 Symlink target:', fs.realpathSync(expanded));
    }

    // Check read/write permissions by attempting to access
    try {
      fs.accessSync(expanded, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      console.warn('⚠️  No read/write permissions:', expanded);
      return {
        valid: false,
        error: 'No read/write permissions',
        expanded
      };
    }

    // Additional safety check: ensure directory is accessible
    try {
      fs.readdirSync(expanded);
    } catch {
      console.warn('⚠️  Directory not accessible:', expanded);
      return {
        valid: false,
        error: 'Directory not accessible (may be deleted or moved)',
        expanded
      };
    }

    // Silent success - only log errors
    return {
      valid: true,
      expanded
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Directory validation error:', errorMessage);
    return {
      valid: false,
      error: errorMessage
    };
  }
}

/**
 * Create directory if it doesn't exist (including parent directories)
 */
export function ensureDirectory(dirPath: string): boolean {
  try {
    const expanded = expandPath(dirPath);

    if (fs.existsSync(expanded)) {
      console.log('📁 Directory already exists:', expanded);
      return true;
    }

    // Create directory recursively
    fs.mkdirSync(expanded, { recursive: true });
    console.log('✅ Directory created:', expanded);
    return true;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Failed to create directory:', errorMessage);
    return false;
  }
}

/**
 * Get platform-specific information for diagnostic logging
 */
export function getPlatformInfo(): {
  os: string;
  platform: string;
  home: string;
  arch: string;
  version: string;
} {
  const info = {
    os: os.type(),
    platform: os.platform(),
    home: os.homedir(),
    arch: os.arch(),
    version: os.release()
  };

  // Startup logs are now consolidated in server.ts
  // console.log('💻 Platform info:', info);
  return info;
}

/**
 * Session directory structure paths
 * Phase 0.1: Separates metadata from workspace to fix CLAUDE.md deletion bug
 */
export interface SessionPaths {
  root: string;           // ~/Documents/agentic/chat-{id}
  claudeDir: string;      // root/.claude (SDK metadata)
  metadata: string;       // root/metadata (chat-specific files)
  claudeMd: string;       // root/metadata/CLAUDE.md
  attachments: string;    // root/metadata/attachments (future: user uploads)
  workspace: string;      // root/workspace (ACTUAL WORKING DIRECTORY)
}

/**
 * Get all session directory paths for a given session ID
 * @param sessionId - Full session ID (will be truncated to 8 chars for directory name)
 * @returns SessionPaths object with all relevant paths
 */
export function getSessionPaths(sessionId: string): SessionPaths {
  const root = path.join(getDefaultWorkingDirectory(), `chat-${sessionId.substring(0, 8)}`);

  return {
    root,
    claudeDir: path.join(root, '.claude'),
    metadata: path.join(root, 'metadata'),
    claudeMd: path.join(root, 'metadata', 'CLAUDE.md'),
    attachments: path.join(root, 'metadata', 'attachments'),
    workspace: path.join(root, 'workspace'),
  };
}

/**
 * Get session directory paths from an existing working directory path
 * Use this when the session may have been renamed (working_directory != session ID-based path)
 * @param workingDirectory - The stored working directory from the database
 * @returns SessionPaths object with all relevant paths
 */
export function getSessionPathsFromWorkingDir(workingDirectory: string): SessionPaths {
  const root = workingDirectory;

  return {
    root,
    claudeDir: path.join(root, '.claude'),
    metadata: path.join(root, 'metadata'),
    claudeMd: path.join(root, 'metadata', 'CLAUDE.md'),
    attachments: path.join(root, 'metadata', 'attachments'),
    workspace: path.join(root, 'workspace'),
  };
}
