/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { getMaskedApiKey, configureProvider } from './providers';

describe('getMaskedApiKey', () => {
  it('masks empty or very short keys entirely', () => {
    expect(getMaskedApiKey('')).toBe('***');
    expect(getMaskedApiKey('abc')).toBe('***');
    expect(getMaskedApiKey('12345')).toBe('***');
  });

  it('shows the first 3 and last 3 chars of a longer key', () => {
    expect(getMaskedApiKey('sk-ant-abcdef')).toBe('sk-...def');
  });

  it('never reveals the middle of the key', () => {
    const masked = getMaskedApiKey('sk-ant-1234567890');
    expect(masked).toBe('sk-...890');
    expect(masked).not.toContain('1234567');
  });
});

describe('configureProvider (codex)', () => {
  const authEnvKeys = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of authEnvKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('leaves concurrent Claude authentication intact for the codex provider', async () => {
    for (const key of authEnvKeys) {
      saved[key] = process.env[key];
    }
    // Seed values that a concurrent Claude chat is using.
    process.env.ANTHROPIC_API_KEY = 'concurrent-claude-key';
    process.env.ANTHROPIC_BASE_URL = 'https://example.com';

    await configureProvider('codex');

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(saved.CLAUDE_CODE_OAUTH_TOKEN);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(saved.ANTHROPIC_AUTH_TOKEN);
    expect(process.env.ANTHROPIC_API_KEY).toBe('concurrent-claude-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://example.com');
  });
});
