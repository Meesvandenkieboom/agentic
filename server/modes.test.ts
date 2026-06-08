/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { getModeConfig, getAvailableModes, loadModePrompt } from './modes';

describe('getModeConfig', () => {
  it('returns config for a known mode', () => {
    const config = getModeConfig('general');
    expect(config).not.toBeNull();
    expect(config?.id).toBe('general');
    expect(config?.name).toBe('General');
    expect(typeof config?.description).toBe('string');
  });

  it('returns config for each documented mode', () => {
    for (const id of ['general', 'coder', 'intense-research', 'spark', 'hive']) {
      expect(getModeConfig(id)?.id).toBe(id);
    }
  });

  it('returns null for an unknown mode', () => {
    expect(getModeConfig('does-not-exist')).toBeNull();
  });
});

describe('getAvailableModes', () => {
  it('returns the modes that have a prompt file and a config', () => {
    const modes = getAvailableModes();
    expect(Array.isArray(modes)).toBe(true);
    expect(modes.length).toBeGreaterThan(0);

    const ids = modes.map((m) => m.id);
    expect(ids).toContain('general');
    expect(ids).toContain('coder');

    // Every returned mode must carry full config metadata.
    for (const mode of modes) {
      expect(typeof mode.id).toBe('string');
      expect(typeof mode.name).toBe('string');
      expect(typeof mode.description).toBe('string');
    }
  });
});

describe('loadModePrompt', () => {
  it('loads a non-empty prompt for a real mode', () => {
    const prompt = loadModePrompt('general');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('returns the same cached content on repeated calls', () => {
    const first = loadModePrompt('coder');
    const second = loadModePrompt('coder');
    expect(first).toBe(second);
  });

  it('returns an empty string for a missing mode file', () => {
    expect(loadModePrompt('totally-not-a-mode')).toBe('');
  });
});
