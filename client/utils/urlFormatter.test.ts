/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { formatUrlForBadge } from './urlFormatter';

const MAX_LENGTH = 20;

describe('formatUrlForBadge', () => {
  it('returns the bare domain when there is no meaningful path', () => {
    expect(formatUrlForBadge('https://github.com')).toBe('github.com');
    expect(formatUrlForBadge('https://github.com/')).toBe('github.com');
  });

  it('keeps domain + path when it fits within the limit', () => {
    expect(formatUrlForBadge('https://api.openai.com/docs')).toBe('api.openai.com/docs');
  });

  it('truncates the path with an ellipsis when too long', () => {
    const out = formatUrlForBadge('https://github.com/anthropics/claude-code');
    expect(out.startsWith('github.com')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_LENGTH);
  });

  it('truncates the domain itself when the domain alone is too long', () => {
    const out = formatUrlForBadge('https://this-is-a-really-long-subdomain.example.com/path');
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBe(MAX_LENGTH);
  });

  it('truncates a raw non-URL string that exceeds the limit', () => {
    const out = formatUrlForBadge('not a url but very very long indeed');
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBe(MAX_LENGTH);
  });

  it('returns a short non-URL string unchanged', () => {
    expect(formatUrlForBadge('localhost')).toBe('localhost');
  });

  it('includes query strings and hashes in the path budget', () => {
    const out = formatUrlForBadge('https://x.io/a?b=c#d');
    expect(out.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(out.startsWith('x.io')).toBe(true);
  });
});
