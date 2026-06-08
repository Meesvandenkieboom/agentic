/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  expandPath,
  validateDirectory,
  ensureDirectory,
  getPlatformInfo,
  getSessionPaths,
  getSessionPathsFromWorkingDir,
  getDefaultWorkingDirectory,
} from './directoryUtils';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-dir-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('expandPath', () => {
  it('returns falsy input unchanged', () => {
    expect(expandPath('')).toBe('');
  });

  it('expands a bare tilde to the home directory', () => {
    expect(expandPath('~')).toBe(os.homedir());
  });

  it('expands ~/subdir to an absolute home path', () => {
    expect(expandPath('~/projects')).toBe(path.join(os.homedir(), 'projects'));
  });

  it('resolves relative paths to absolute paths', () => {
    expect(path.isAbsolute(expandPath('some/relative'))).toBe(true);
  });

  it('keeps absolute paths absolute', () => {
    expect(expandPath(tmpDir)).toBe(path.resolve(tmpDir));
  });
});

describe('validateDirectory', () => {
  it('validates an existing, accessible directory', () => {
    const result = validateDirectory(tmpDir);
    expect(result.valid).toBe(true);
    expect(result.expanded).toBe(path.resolve(tmpDir));
  });

  it('rejects a non-existent directory', () => {
    const result = validateDirectory(path.join(tmpDir, 'nope'));
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Directory does not exist');
  });

  it('rejects a path that is a file, not a directory', () => {
    const filePath = path.join(tmpDir, 'a-file.txt');
    fs.writeFileSync(filePath, 'hello');
    const result = validateDirectory(filePath);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Path is not a directory');
  });

  it('allows a symlink that points at a real directory', () => {
    const realDir = path.join(tmpDir, 'real');
    const linkDir = path.join(tmpDir, 'link');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir, 'dir');
    const result = validateDirectory(linkDir);
    expect(result.valid).toBe(true);
  });
});

describe('ensureDirectory', () => {
  it('returns true for an already-existing directory', () => {
    expect(ensureDirectory(tmpDir)).toBe(true);
  });

  it('creates nested directories that do not exist', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    expect(ensureDirectory(nested)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('getPlatformInfo', () => {
  it('reports platform diagnostics', () => {
    const info = getPlatformInfo();
    expect(info.platform).toBe(os.platform());
    expect(info.home).toBe(os.homedir());
    expect(typeof info.arch).toBe('string');
    expect(typeof info.version).toBe('string');
  });
});

describe('getSessionPaths', () => {
  it('derives a chat-{id8} layout from the session id', () => {
    const paths = getSessionPaths('abcdef1234567890');
    expect(paths.root.endsWith(path.join('chat-abcdef12'))).toBe(true);
    expect(paths.claudeDir).toBe(path.join(paths.root, '.claude'));
    expect(paths.metadata).toBe(path.join(paths.root, 'metadata'));
    expect(paths.claudeMd).toBe(path.join(paths.root, 'metadata', 'CLAUDE.md'));
    expect(paths.attachments).toBe(path.join(paths.root, 'metadata', 'attachments'));
    expect(paths.workspace).toBe(path.join(paths.root, 'workspace'));
  });

  it('truncates the session id to 8 characters', () => {
    const paths = getSessionPaths('1234567890abcdef');
    expect(path.basename(paths.root)).toBe('chat-12345678');
  });
});

describe('getSessionPathsFromWorkingDir', () => {
  it('treats a directory with a workspace/ subdir as a session directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
    const paths = getSessionPathsFromWorkingDir(tmpDir);
    expect(paths.root).toBe(tmpDir);
    expect(paths.workspace).toBe(path.join(tmpDir, 'workspace'));
  });

  it('treats an external directory (no workspace/) as the workspace itself', () => {
    const paths = getSessionPathsFromWorkingDir(tmpDir);
    expect(paths.workspace).toBe(tmpDir);
  });
});

describe('getDefaultWorkingDirectory', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.AGENTIC_WORKSPACE_DIR;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGENTIC_WORKSPACE_DIR;
    else process.env.AGENTIC_WORKSPACE_DIR = savedEnv;
  });

  it('honours the AGENTIC_WORKSPACE_DIR override and expands it', () => {
    process.env.AGENTIC_WORKSPACE_DIR = '~/custom-workspace';
    expect(getDefaultWorkingDirectory()).toBe(path.join(os.homedir(), 'custom-workspace'));
  });
});
