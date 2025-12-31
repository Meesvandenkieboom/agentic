/**
 * Agent Smith - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Current schema version - increment when making breaking changes
const CURRENT_CONFIG_VERSION = 1;

interface ConfigBase {
  version?: number;
}

interface MCPServersConfig extends ConfigBase {
  enabled: Record<string, boolean>;
  custom: Record<string, unknown>;
  auth: Record<string, unknown>;
  headerOverrides: Record<string, Record<string, string>>;
  nameOverrides: Record<string, string>;
}

interface AgentsConfig extends ConfigBase {
  agents: Record<string, unknown>;
}

interface MigrationResult {
  success: boolean;
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  backupPath?: string;
  error?: string;
}

/**
 * Get the .claude config directory path
 */
export function getConfigDir(): string {
  return path.join(process.cwd(), '.claude');
}

/**
 * Get all config file paths that need to be preserved
 */
export function getConfigFilePaths(): Record<string, string> {
  const configDir = getConfigDir();
  const appDataDir = process.env.AGENT_SMITH_DATA_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'Documents', 'agent-smith-app');

  return {
    mcpServers: path.join(configDir, 'mcp-servers.json'),
    mcpConnections: path.join(configDir, 'mcp-connections.json'),
    agents: path.join(configDir, 'agents.json'),
    settingsLocal: path.join(configDir, 'settings.local.json'),
    githubToken: path.join(appDataDir, 'github-token.json'),
  };
}

/**
 * Create backup of a config file
 */
async function backupConfig(filePath: string): Promise<string | null> {
  try {
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!exists) return null;

    const backupPath = `${filePath}.backup.${Date.now()}`;
    await fs.copyFile(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Restore config from backup
 */
async function restoreFromBackup(backupPath: string, originalPath: string): Promise<boolean> {
  try {
    await fs.copyFile(backupPath, originalPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up old backups (keep last 5)
 */
async function cleanupOldBackups(filePath: string): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const files = await fs.readdir(dir);

    const backups = files
      .filter(f => f.startsWith(`${baseName}.backup.`))
      .map(f => ({
        name: f,
        path: path.join(dir, f),
        timestamp: parseInt(f.split('.backup.')[1] || '0', 10)
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    // Keep only the 5 most recent backups
    const toDelete = backups.slice(5);
    for (const backup of toDelete) {
      await fs.unlink(backup.path).catch(() => {});
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * MCP Servers Config Migration
 */
function migrateMCPServersV0toV1(config: Record<string, unknown>): MCPServersConfig {
  // V0 -> V1: Add headerOverrides and nameOverrides if missing
  return {
    version: 1,
    enabled: (config.enabled as Record<string, boolean>) || {},
    custom: (config.custom as Record<string, unknown>) || {},
    auth: (config.auth as Record<string, unknown>) || {},
    headerOverrides: (config.headerOverrides as Record<string, Record<string, string>>) || {},
    nameOverrides: (config.nameOverrides as Record<string, string>) || {},
  };
}

/**
 * Migrate MCP servers config to latest version
 */
export async function migrateMCPServersConfig(configPath: string): Promise<MigrationResult> {
  try {
    const exists = await fs.access(configPath).then(() => true).catch(() => false);
    if (!exists) {
      return {
        success: true,
        migrated: false,
        fromVersion: 0,
        toVersion: CURRENT_CONFIG_VERSION,
      };
    }

    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data) as Record<string, unknown>;
    const currentVersion = (config.version as number) || 0;

    if (currentVersion >= CURRENT_CONFIG_VERSION) {
      return {
        success: true,
        migrated: false,
        fromVersion: currentVersion,
        toVersion: CURRENT_CONFIG_VERSION,
      };
    }

    // Create backup before migration
    const backupPath = await backupConfig(configPath);

    try {
      let migrated = config;

      // Apply migrations in sequence
      if (currentVersion < 1) {
        migrated = migrateMCPServersV0toV1(migrated);
      }

      // Write migrated config
      await fs.writeFile(configPath, JSON.stringify(migrated, null, 2));

      // Cleanup old backups
      await cleanupOldBackups(configPath);

      console.log(`✓ Migrated mcp-servers.json from v${currentVersion} to v${CURRENT_CONFIG_VERSION}`);

      return {
        success: true,
        migrated: true,
        fromVersion: currentVersion,
        toVersion: CURRENT_CONFIG_VERSION,
        backupPath: backupPath || undefined,
      };
    } catch (error) {
      // Rollback on failure
      if (backupPath) {
        await restoreFromBackup(backupPath, configPath);
      }
      throw error;
    }
  } catch (error) {
    return {
      success: false,
      migrated: false,
      fromVersion: 0,
      toVersion: CURRENT_CONFIG_VERSION,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Migrate all config files
 */
export async function migrateAllConfigs(): Promise<Record<string, MigrationResult>> {
  const results: Record<string, MigrationResult> = {};
  const paths = getConfigFilePaths();

  // Migrate MCP servers config
  results.mcpServers = await migrateMCPServersConfig(paths.mcpServers);

  // Add other config migrations here as needed
  // results.agents = await migrateAgentsConfig(paths.agents);

  return results;
}

/**
 * Export all configs for backup
 */
export async function exportAllConfigs(): Promise<Record<string, unknown>> {
  const paths = getConfigFilePaths();
  const configs: Record<string, unknown> = {};

  for (const [key, filePath] of Object.entries(paths)) {
    try {
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (exists) {
        const data = await fs.readFile(filePath, 'utf-8');
        configs[key] = JSON.parse(data);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    version: CURRENT_CONFIG_VERSION,
    configs,
  };
}

/**
 * Import configs from backup
 */
export async function importConfigs(backup: Record<string, unknown>): Promise<Record<string, boolean>> {
  const paths = getConfigFilePaths();
  const results: Record<string, boolean> = {};
  const configs = backup.configs as Record<string, unknown> || {};

  // Ensure config directory exists
  const configDir = getConfigDir();
  await fs.mkdir(configDir, { recursive: true });

  for (const [key, config] of Object.entries(configs)) {
    const filePath = paths[key as keyof typeof paths];
    if (filePath && config) {
      try {
        await fs.writeFile(filePath, JSON.stringify(config, null, 2));
        results[key] = true;
      } catch {
        results[key] = false;
      }
    }
  }

  return results;
}

/**
 * Run migrations on startup
 */
export async function runStartupMigrations(): Promise<void> {
  try {
    const results = await migrateAllConfigs();

    const migratedConfigs = Object.entries(results)
      .filter(([, result]) => result.migrated)
      .map(([name]) => name);

    if (migratedConfigs.length > 0) {
      console.log(`📦 Migrated configs: ${migratedConfigs.join(', ')}`);
    }

    const failedConfigs = Object.entries(results)
      .filter(([, result]) => !result.success)
      .map(([name, result]) => `${name}: ${result.error}`);

    if (failedConfigs.length > 0) {
      console.warn(`⚠️ Config migration warnings: ${failedConfigs.join(', ')}`);
    }
  } catch (error) {
    console.error('Config migration error:', error);
  }
}
