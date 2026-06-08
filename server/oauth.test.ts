/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { generatePKCE, getAuthorizationURL, isTokenExpired } from './oauth';

describe('generatePKCE', () => {
  it('produces a verifier and a challenge', () => {
    const pkce = generatePKCE();
    expect(typeof pkce.codeVerifier).toBe('string');
    expect(typeof pkce.codeChallenge).toBe('string');
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('uses url-safe base64 (no +, /, or = padding)', () => {
    const { codeVerifier, codeChallenge } = generatePKCE();
    expect(codeVerifier).not.toMatch(/[+/=]/);
    expect(codeChallenge).not.toMatch(/[+/=]/);
  });

  it('returns unique values on each call', () => {
    expect(generatePKCE().codeVerifier).not.toBe(generatePKCE().codeVerifier);
  });
});

describe('getAuthorizationURL', () => {
  it('builds a claude.ai authorize URL with the expected params', () => {
    const url = new URL(getAuthorizationURL('my-challenge', 'my-verifier'));
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('my-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The verifier doubles as CSRF state.
    expect(url.searchParams.get('state')).toBe('my-verifier');
    expect(url.searchParams.get('client_id')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('user:inference');
  });
});

describe('isTokenExpired', () => {
  it('treats a token expiring far in the future as valid', () => {
    expect(isTokenExpired(Date.now() + 60 * 60 * 1000)).toBe(false);
  });

  it('treats an already-past expiry as expired', () => {
    expect(isTokenExpired(Date.now() - 1000)).toBe(true);
  });

  it('treats a token inside the 5-minute buffer as expired', () => {
    // 2 minutes left -> within buffer -> considered expired.
    expect(isTokenExpired(Date.now() + 2 * 60 * 1000)).toBe(true);
  });

  it('treats a token just outside the buffer as valid', () => {
    // ~6 minutes left -> outside the 5-minute buffer.
    expect(isTokenExpired(Date.now() + 6 * 60 * 1000)).toBe(false);
  });
});
