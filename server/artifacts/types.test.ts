/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { isArtifactType, ARTIFACT_TYPES } from './types';

describe('ARTIFACT_TYPES', () => {
  it('lists all supported artifact MIME types', () => {
    expect(ARTIFACT_TYPES).toContain('text/html');
    expect(ARTIFACT_TYPES).toContain('image/svg+xml');
    expect(ARTIFACT_TYPES).toContain('text/markdown');
    expect(ARTIFACT_TYPES).toContain('application/vnd.ant.code');
    expect(ARTIFACT_TYPES).toContain('application/vnd.ant.mermaid');
    expect(ARTIFACT_TYPES).toContain('application/vnd.ant.react');
    expect(ARTIFACT_TYPES).toContain('application/vnd.ant.chart');
    expect(ARTIFACT_TYPES).toContain('application/json');
  });

  it('has exactly 8 types', () => {
    expect(ARTIFACT_TYPES.length).toBe(8);
  });
});

describe('isArtifactType', () => {
  it('accepts every value in ARTIFACT_TYPES', () => {
    for (const t of ARTIFACT_TYPES) {
      expect(isArtifactType(t)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isArtifactType('text/plain')).toBe(false);
    expect(isArtifactType('application/pdf')).toBe(false);
    expect(isArtifactType('')).toBe(false);
    expect(isArtifactType('TEXT/HTML')).toBe(false); // case-sensitive
  });
});
