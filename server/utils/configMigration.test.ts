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
  getConfigDir,
  getConfigFilePaths,
  migrateMCPServersConfig,
  exportAllConfigs,
  importConfigs,
} from './configMigration';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-cfg-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getConfigDir / getConfigFilePaths', () => {
  it('points the config dir at a .claude folder in the cwd', () => {
    expect(getConfigDir().endsWith(path.join('.claude'))).toBe(true);
  });

  it('exposes the expected config file path keys', () => {
    const paths = getConfigFilePaths();
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        'mcpServers',
        'mcpConnections',
        'agents',
        'settingsLocal',
        'githubToken',
      ])
    );
    expect(paths.mcpServers.endsWith('mcp-servers.json')).toBe(true);
  });
});

describe('migrateMCPServersConfig', () => {
  it('is a no-op when the file does not exist', async () => {
    const result = await migrateMCPServersConfig(path.join(tmpDir, 'missing.json'));
    expect(result.success).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(1);
  });

  it('migrates a v0 config to v1 and fills missing fields', async () => {
    const file = path.join(tmpDir, 'mcp-servers.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: { foo: true }, custom: {} }));

    const result = await migrateMCPServersConfig(file);
    expect(result.success).toBe(true);
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(0);

    const migrated = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(migrated.version).toBe(1);
    expect(migrated.enabled).toEqual({ foo: true });
    expect(migrated.headerOverrides).toEqual({});
    expect(migrated.nameOverrides).toEqual({});
    expect(migrated.auth).toEqual({});
  });

  it('creates a backup file when migrating', async () => {
    const file = path.join(tmpDir, 'mcp-servers.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: {} }));

    const result = await migrateMCPServersConfig(file);
    expect(result.backupPath).toBeDefined();

    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.backup.'));
    expect(backups.length).toBe(1);
  });

  it('does not re-migrate a config already at the latest version', async () => {
    const file = path.join(tmpDir, 'mcp-servers.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: {}, custom: {}, auth: {}, headerOverrides: {}, nameOverrides: {} }));

    const result = await migrateMCPServersConfig(file);
    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(1);
  });

  it('reports failure for malformed JSON', async () => {
    const file = path.join(tmpDir, 'mcp-servers.json');
    fs.writeFileSync(file, '{ not valid json');

    const result = await migrateMCPServersConfig(file);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('exportAllConfigs / importConfigs (round trip)', () => {
  let originalCwd: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalDataDir = process.env.AGENT_SMITH_DATA_DIR;
    // Isolate cwd-derived (.claude) and app-data-derived (github token) paths
    // inside the temp dir so the real filesystem is never touched.
    process.chdir(tmpDir);
    process.env.AGENT_SMITH_DATA_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalDataDir === undefined) delete process.env.AGENT_SMITH_DATA_DIR;
    else process.env.AGENT_SMITH_DATA_DIR = originalDataDir;
  });

  it('exports existing configs and re-imports them', async () => {
    const mcpPath = path.join(tmpDir, '.claude', 'mcp-servers.json');
    const payload = { version: 1, enabled: { demo: true }, custom: {}, auth: {}, headerOverrides: {}, nameOverrides: {} };
    fs.writeFileSync(mcpPath, JSON.stringify(payload));

    const exported = await exportAllConfigs();
    expect(exported.version).toBe(1);
    const configs = exported.configs as Record<string, unknown>;
    expect(configs.mcpServers).toMatchObject({ enabled: { demo: true } });

    // Delete then re-import.
    fs.rmSync(mcpPath);
    const importResult = await importConfigs(exported);
    expect(importResult.mcpServers).toBe(true);
    expect(fs.existsSync(mcpPath)).toBe(true);

    const reread = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(reread).toMatchObject({ enabled: { demo: true } });
  });
});
