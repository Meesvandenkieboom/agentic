/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import {
  parseApiError,
  isRetryableError,
  getUserFriendlyMessage,
  type ApiErrorType,
  type ParsedApiError,
} from './apiErrors';

describe('isRetryableError', () => {
  const retryable: ApiErrorType[] = [
    'api_error',
    'overloaded_error',
    'timeout_error',
    'network_error',
    'rate_limit_error',
  ];

  const nonRetryable: ApiErrorType[] = [
    'invalid_request_error',
    'authentication_error',
    'permission_error',
    'not_found_error',
    'request_too_large',
    'insufficient_credits',
    'sdk_process_error',
    'unknown_error',
  ];

  it.each(retryable)('marks %s as retryable', (type) => {
    expect(isRetryableError(type)).toBe(true);
  });

  it.each(nonRetryable)('marks %s as non-retryable', (type) => {
    expect(isRetryableError(type)).toBe(false);
  });
});

describe('parseApiError - Error instances', () => {
  it('detects authentication errors from the message', () => {
    const parsed = parseApiError(new Error('Invalid API key provided'));
    expect(parsed.type).toBe('authentication_error');
    expect(parsed.isRetryable).toBe(false);
  });

  it('detects authentication errors from stderr context', () => {
    const parsed = parseApiError(new Error('boom'), 'fatal: 401 unauthorized');
    expect(parsed.type).toBe('authentication_error');
    expect(parsed.stderrContext).toBe('fatal: 401 unauthorized');
  });

  it('detects permission errors', () => {
    const parsed = parseApiError(new Error('403 Forbidden: permission denied'));
    expect(parsed.type).toBe('permission_error');
    expect(parsed.isRetryable).toBe(false);
  });

  it('detects rate limit errors and marks them retryable', () => {
    const parsed = parseApiError(new Error('Rate limit exceeded (429)'));
    expect(parsed.type).toBe('rate_limit_error');
    expect(parsed.isRetryable).toBe(true);
  });

  it('detects insufficient credit errors', () => {
    const parsed = parseApiError(new Error('Your credit balance is too low'));
    expect(parsed.type).toBe('insufficient_credits');
    expect(parsed.isRetryable).toBe(false);
  });

  it('detects SDK subprocess errors and extracts the exit code', () => {
    const parsed = parseApiError(new Error('process exited with code 137'));
    expect(parsed.type).toBe('sdk_process_error');
    expect(parsed.message).toContain('137');
  });

  it('falls back to "unknown" exit code when not present', () => {
    const parsed = parseApiError(new Error('subprocess spawn failure'));
    expect(parsed.type).toBe('sdk_process_error');
    expect(parsed.message).toContain('unknown');
  });

  it('detects network errors', () => {
    const parsed = parseApiError(new Error('fetch failed: ECONNREFUSED'));
    expect(parsed.type).toBe('network_error');
    expect(parsed.isRetryable).toBe(true);
  });

  it('detects timeout errors', () => {
    const parsed = parseApiError(new Error('Request timed out'));
    expect(parsed.type).toBe('timeout_error');
    expect(parsed.isRetryable).toBe(true);
  });

  it('parses embedded JSON structured errors', () => {
    const err = new Error(
      'API error: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}'
    );
    const parsed = parseApiError(err);
    expect(parsed.type).toBe('overloaded_error');
    expect(parsed.isRetryable).toBe(true);
  });

  it('returns a generic error for unrecognised messages', () => {
    const parsed = parseApiError(new Error('Something weird happened'));
    expect(parsed.type).toBe('unknown_error');
    expect(parsed.message).toBe('Something weird happened');
    expect(parsed.isRetryable).toBe(false);
  });

  it('prioritises authentication over rate limit when both keywords appear', () => {
    // Authentication is checked first in the cascade.
    const parsed = parseApiError(new Error('unauthorized and rate limit'));
    expect(parsed.type).toBe('authentication_error');
  });
});

describe('parseApiError - structured API objects', () => {
  it('parses the Anthropic { type: "error", error } shape', () => {
    const parsed = parseApiError({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down', retry_after: 12 },
      request_id: 'req_123',
    });
    expect(parsed.type).toBe('rate_limit_error');
    expect(parsed.retryAfterSeconds).toBe(12);
    expect(parsed.requestId).toBe('req_123');
    expect(parsed.isRetryable).toBe(true);
  });

  it('maps unknown structured error types to unknown_error', () => {
    const parsed = parseApiError({
      type: 'error',
      error: { type: 'totally_made_up', message: 'huh' },
    });
    expect(parsed.type).toBe('unknown_error');
  });

  it('parses HTTP status-code style errors', () => {
    expect(parseApiError({ status: 400, message: 'bad' }).type).toBe('invalid_request_error');
    expect(parseApiError({ status: 401 }).type).toBe('authentication_error');
    expect(parseApiError({ status: 404 }).type).toBe('not_found_error');
    expect(parseApiError({ status: 413 }).type).toBe('request_too_large');
    expect(parseApiError({ statusCode: 503 }).type).toBe('overloaded_error');
    expect(parseApiError({ status: 529 }).type).toBe('overloaded_error');
  });

  it('marks 429/500/502/503/504 HTTP errors as retryable', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(parseApiError({ status }).isRetryable).toBe(true);
    }
  });

  it('keeps the status code on parsed HTTP errors', () => {
    const parsed = parseApiError({ statusCode: 500 });
    expect(parsed.statusCode).toBe(500);
    expect(parsed.type).toBe('api_error');
  });

  it('returns the default unknown error for plain objects', () => {
    const parsed = parseApiError({ foo: 'bar' });
    expect(parsed.type).toBe('unknown_error');
    expect(parsed.isRetryable).toBe(false);
  });

  it('returns the default unknown error for null/undefined/primitives', () => {
    expect(parseApiError(null).type).toBe('unknown_error');
    expect(parseApiError(undefined).type).toBe('unknown_error');
    expect(parseApiError('a string').type).toBe('unknown_error');
  });
});

describe('getUserFriendlyMessage', () => {
  const make = (over: Partial<ParsedApiError>): ParsedApiError => ({
    type: 'unknown_error',
    message: 'fallback',
    isRetryable: false,
    ...over,
  });

  it('includes the retry-after seconds for rate limit errors', () => {
    const msg = getUserFriendlyMessage(make({ type: 'rate_limit_error', retryAfterSeconds: 30 }));
    expect(msg).toContain('30 seconds');
  });

  it('gives a generic rate-limit message when no retry-after', () => {
    const msg = getUserFriendlyMessage(make({ type: 'rate_limit_error' }));
    expect(msg.toLowerCase()).toContain('rate limit');
  });

  it('shows concise stderr context for SDK process errors', () => {
    const msg = getUserFriendlyMessage(
      make({ type: 'sdk_process_error', stderrContext: 'segfault in worker' })
    );
    expect(msg).toContain('segfault in worker');
  });

  it('hides noisy stderr context for SDK process errors', () => {
    const msg = getUserFriendlyMessage(
      make({ type: 'sdk_process_error', stderrContext: 'WORKING DIRECTORY: /home/foo' })
    );
    expect(msg).not.toContain('WORKING DIRECTORY');
  });

  it('echoes short invalid_request messages', () => {
    const msg = getUserFriendlyMessage(make({ type: 'invalid_request_error', message: 'bad field' }));
    expect(msg).toContain('bad field');
  });

  it('uses a fallback for overly long invalid_request messages', () => {
    const msg = getUserFriendlyMessage(
      make({ type: 'invalid_request_error', message: 'x'.repeat(300) })
    );
    expect(msg).toBe('Invalid request. Please check your input and try again.');
  });

  it('falls back to the raw message for unknown errors', () => {
    expect(getUserFriendlyMessage(make({ type: 'unknown_error', message: 'custom' }))).toBe('custom');
  });
});
