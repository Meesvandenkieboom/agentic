import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { OAuthTokens } from './oauth';

// New config directory
const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.agentic');
const TOKEN_FILE = path.join(CONFIG_DIR, 'oauth-tokens.json');

// Legacy config directory for migration
const LEGACY_CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.agent-smith');
const LEGACY_TOKEN_FILE = path.join(LEGACY_CONFIG_DIR, 'oauth-tokens.json');

export interface StoredAuth {
  anthropic?: OAuthTokens;
  codex?: {
    loggedIn: boolean;
    loginDate: number; // Unix timestamp
  };
}

/**
 * Migrate tokens from legacy .agent-smith directory to .agentic
 */
async function migrateLegacyTokens(): Promise<void> {
  try {
    // Check if legacy tokens exist and new ones don't
    if (fsSync.existsSync(LEGACY_TOKEN_FILE) && !fsSync.existsSync(TOKEN_FILE)) {
      // Ensure new directory exists
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      // Copy tokens to new location
      await fs.copyFile(LEGACY_TOKEN_FILE, TOKEN_FILE);
      console.log('✅ Migrated OAuth tokens from ~/.agent-smith to ~/.agentic');
    }
  } catch {
    // Migration failed, will just use new directory
  }
}

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
  try {
    // First try to migrate legacy tokens
    await migrateLegacyTokens();
    await fs.mkdir(CONFIG_DIR, { recursive: true });
  } catch {
    // Directory might already exist, that's OK
  }
}

/**
 * Load OAuth tokens from storage
 */
export async function loadTokens(): Promise<StoredAuth> {
  try {
    await ensureConfigDir();
    const data = await fs.readFile(TOKEN_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    // File doesn't exist or is invalid, return empty object
    return {};
  }
}

/**
 * Save OAuth tokens to storage
 */
export async function saveTokens(tokens: OAuthTokens): Promise<void> {
  await ensureConfigDir();
  const auth: StoredAuth = await loadTokens();
  auth.anthropic = tokens;
  await fs.writeFile(TOKEN_FILE, JSON.stringify(auth, null, 2), 'utf-8');
  console.log('✅ OAuth tokens saved successfully');
}

/**
 * Get Anthropic OAuth tokens if they exist
 */
export async function getAnthropicTokens(): Promise<OAuthTokens | null> {
  const auth = await loadTokens();
  return auth.anthropic || null;
}

/**
 * Save Codex login marker
 */
export async function saveCodexLoginMarker(): Promise<void> {
  await ensureConfigDir();
  const auth: StoredAuth = await loadTokens();
  auth.codex = { loggedIn: true, loginDate: Date.now() };
  await fs.writeFile(TOKEN_FILE, JSON.stringify(auth, null, 2), 'utf-8');
  console.log('✅ Codex login marker saved');
}

/**
 * Check if user is logged in with Codex
 */
export async function isCodexLoggedIn(): Promise<boolean> {
  const auth = await loadTokens();
  return auth.codex?.loggedIn === true;
}

/**
 * Clear Codex login marker
 */
export async function clearCodexTokens(): Promise<void> {
  const auth = await loadTokens();
  delete auth.codex;
  await fs.writeFile(TOKEN_FILE, JSON.stringify(auth, null, 2), 'utf-8');
  console.log('✅ Codex login marker cleared');
}

/**
 * Clear OAuth tokens (logout)
 */
export async function clearTokens(provider?: 'anthropic' | 'codex' | 'all'): Promise<void> {
  if (provider === 'codex') {
    await clearCodexTokens();
    return;
  }
  if (provider === 'anthropic' || !provider || provider === 'all') {
    try {
      if (provider === 'all') {
        await fs.unlink(TOKEN_FILE);
      } else {
        // Only clear anthropic
        const auth = await loadTokens();
        delete auth.anthropic;
        await fs.writeFile(TOKEN_FILE, JSON.stringify(auth, null, 2), 'utf-8');
      }
      console.log('✅ Logged out successfully');
    } catch {
      console.log('✅ Logged out successfully');
    }
  }
}

/**
 * Check if user is logged in with OAuth
 */
export async function isLoggedIn(provider?: 'anthropic' | 'codex'): Promise<boolean> {
  if (provider === 'codex') {
    return isCodexLoggedIn();
  }
  // Default: check Anthropic (backward compatible)
  const tokens = await getAnthropicTokens();
  return tokens !== null;
}
