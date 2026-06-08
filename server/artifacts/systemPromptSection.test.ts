/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { buildArtifactSection } from './systemPromptSection';
import { ARTIFACT_TYPES } from './types';

describe('buildArtifactSection', () => {
  const section = buildArtifactSection();

  it('returns a non-empty instructions block', () => {
    expect(typeof section).toBe('string');
    expect(section.length).toBeGreaterThan(100);
  });

  it('documents the antArtifact tag the parser looks for', () => {
    expect(section).toContain('<antArtifact');
    expect(section).toContain('</antArtifact>');
    expect(section).toContain('identifier=');
    expect(section).toContain('type=');
  });

  it('mentions every supported artifact type', () => {
    for (const t of ARTIFACT_TYPES) {
      expect(section).toContain(t);
    }
  });

  it('includes the "When to use" and "When NOT to use" guidance', () => {
    expect(section).toContain('When to use an artifact');
    expect(section).toContain('When NOT to use an artifact');
  });
});
