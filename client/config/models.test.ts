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
    expect(normalizeModelId('opus-4-7')).toBe(DEFAULT_MODEL_ID);
    expect(normalizeModelId('opus-4-8')).toBe(DEFAULT_MODEL_ID);
  });

  it('passes through a known id unchanged', () => {
    expect(normalizeModelId('haiku')).toBe('haiku');
    expect(normalizeModelId('codex')).toBe('codex');
  });

  it('falls back to the default for an unknown id', () => {
    expect(normalizeModelId('mystery-model')).toBe(DEFAULT_MODEL_ID);
  });
});
