/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL_ID,
  getModelConfig,
  getDefaultModel,
  normalizeModelId,
  migrateModelPreference,
} from './models';

describe('getModelConfig', () => {
  it('returns the matching model by id', () => {
    const model = getModelConfig('sonnet');
    expect(model?.id).toBe('sonnet');
    expect(model?.provider).toBe('anthropic');
  });

  it('returns undefined for an unknown id', () => {
    expect(getModelConfig('nope')).toBeUndefined();
  });

  it('has a config for every advertised id', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(getModelConfig(m.id)?.id).toBe(m.id);
    }
  });
});


describe('Claude model versions', () => {
  it('selects Opus 5.5 by default and exposes both new API IDs', () => {
    expect(DEFAULT_MODEL_ID).toBe('opus-5-5');
    expect(AVAILABLE_MODELS.filter(model => model.provider === 'anthropic').slice(0, 2).map(model => model.id)).toEqual([
      'opus-5-5', 'fable-5-1',
    ]);
    expect(getModelConfig('opus-5-5')?.apiModelId).toBe('claude-opus-5-5');
    expect(getModelConfig('fable-5-1')?.apiModelId).toBe('claude-fable-5-1');
    expect(getModelConfig('hive')?.apiModelId).toBe('claude-opus-5-5');
  });

  it('upgrades saved new-chat preferences only once', () => {
    expect(migrateModelPreference('opus-5')).toBe('opus-5-5');
    expect(migrateModelPreference('fable-5')).toBe('fable-5-1');
    expect(migrateModelPreference('opus-5', true)).toBe('opus-5');
    expect(migrateModelPreference('fable-5', true)).toBe('fable-5');
  });

  it('retains old model IDs for existing conversations', () => {
    expect(getModelConfig('opus-5')?.apiModelId).toBe('claude-opus-5');
    expect(getModelConfig('fable-5')?.apiModelId).toBe('claude-fable-5');
    expect(normalizeModelId('opus-4-7')).toBe('opus-5');
    expect(normalizeModelId('opus-4-8')).toBe('opus-5');
  });
});

describe('GPT-6 Astra', () => {
  it('uses the official Codex model slug', () => {
    expect(getModelConfig('codex-6-astra')).toMatchObject({
      name: 'Codex (GPT-6 Astra)',
      description: 'OpenAI Codex via ChatGPT — GPT-6 Astra for complex reasoning, coding, and computer use',
      apiModelId: 'gpt-6-astra',
      provider: 'codex',
    });
  });

  it('offers the released GPT-6 family before the retained GPT-5.6 Sol option', () => {
    const codexIds = AVAILABLE_MODELS.filter(model => model.provider === 'codex').map(model => model.id);

    expect(codexIds.slice(0, 4)).toEqual([
      'codex-6-astra',
      'codex-6-sol',
      'codex-6-luna',
      'codex-5-6-sol',
    ]);
    expect(codexIds).not.toContain('codex-5-6-terra');
    expect(codexIds).not.toContain('codex-5-6-luna');
  });

  it('uses the official GPT-6 Sol and Luna model slugs', () => {
    expect(getModelConfig('codex-6-sol')).toMatchObject({
      name: 'Codex (GPT-6 Sol)',
      apiModelId: 'gpt-6-sol',
      provider: 'codex',
    });
    expect(getModelConfig('codex-6-luna')).toMatchObject({
      name: 'Codex (GPT-6 Luna)',
      apiModelId: 'gpt-6-luna',
      provider: 'codex',
    });
  });
});

describe('getDefaultModel', () => {
  it('returns the model matching DEFAULT_MODEL_ID', () => {
    expect(getDefaultModel().id).toBe(DEFAULT_MODEL_ID);
  });
});

describe('normalizeModelId', () => {
  it('returns the default for null/undefined/empty input', () => {
    expect(normalizeModelId()).toBe(DEFAULT_MODEL_ID);
    expect(normalizeModelId(null)).toBe(DEFAULT_MODEL_ID);
    expect(normalizeModelId('')).toBe(DEFAULT_MODEL_ID);
  });

  it('maps a legacy alias to its current id', () => {
    expect(normalizeModelId('opus-4-7')).toBe('opus-5');
    expect(normalizeModelId('opus-4-8')).toBe('opus-5');
    expect(normalizeModelId('codex-5-6-terra')).toBe('codex-6-sol');
    expect(normalizeModelId('codex-5-6-luna')).toBe('codex-6-luna');
  });

  it('passes through a known id unchanged', () => {
    expect(normalizeModelId('haiku')).toBe('haiku');
    expect(normalizeModelId('codex')).toBe('codex');
  });

  it('falls back to the default for an unknown id', () => {
    expect(normalizeModelId('mystery-model')).toBe(DEFAULT_MODEL_ID);
  });
});
