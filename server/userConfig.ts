/**
 * Agentic - User Configuration Management
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getBinaryDir } from './startup';
import type { SkillPolicy } from './skills';

export interface UserConfig {
  name?: string;
  firstName?: string;
  lastName?: string;
  skills?: SkillPolicy;
}

/**
 * Get config directory (lazy evaluation to ensure correct path)
 */
function getConfigDir(): string {
  return join(getBinaryDir(), 'data');
}

/**
 * Get config file path (lazy evaluation to ensure correct path)
 */
function getConfigPath(): string {
  return join(getConfigDir(), 'user-config.json');
}

/**
 * Ensure the data directory exists
 */
function ensureDataDir() {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

/**
 * Load user configuration from disk
 */
export function loadUserConfig(): UserConfig {
  ensureDataDir();

  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const trimmed = content.trim();

    // Handle empty/whitespace files gracefully (common on Windows with BOM/CRLF)
    if (trimmed === '') {
      console.warn(`⚠️  User config file is empty or contains only whitespace: ${configPath}`);
      return {};
    }

    return JSON.parse(trimmed);
  } catch (error) {
    console.error('❌ Failed to load user config:', error);
    console.error(`   Path: ${configPath}`);
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * Save user configuration to disk
 */
export function saveUserConfig(config: UserConfig): void {
  ensureDataDir();

  const configPath = getConfigPath();
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save user config:', error);
    throw error;
  }
}

/**
 * Update user configuration
 */
export function updateUserConfig(updates: Partial<UserConfig>): UserConfig {
  const current = loadUserConfig();
  const updated = { ...current, ...updates };
  saveUserConfig(updated);
  return updated;
}

/**
 * Get user's display name (with fallback)
 */
export function getUserDisplayName(config?: UserConfig): string | null {
  const userConfig = config || loadUserConfig();

  // Full name if both parts exist
  if (userConfig.firstName && userConfig.lastName) {
    return `${userConfig.firstName} ${userConfig.lastName}`;
  }

  // First name only
  if (userConfig.firstName) {
    return userConfig.firstName;
  }

  // Legacy name field
  if (userConfig.name) {
    return userConfig.name;
  }

  return null;
}
