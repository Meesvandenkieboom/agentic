/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import {
  withRetry,
  withRetryGenerator,
  shouldRetry,
  getRetryDelay,
} from './retry';
import type { ParsedApiError } from './apiErrors';

// A retryable error (network errors are classified retryable by parseApiError).
const retryableError = () => new Error('network fetch failed');
// A non-retryable error.
const fatalError = () => new Error('Invalid API key');

describe('shouldRetry', () => {
  it('returns true for retryable errors', () => {
    expect(shouldRetry(retryableError())).toBe(true);
  });

  it('returns false for non-retryable errors', () => {
    expect(shouldRetry(fatalError())).toBe(false);
  });
});

describe('getRetryDelay', () => {
  it('uses exponential backoff based on attempt number', () => {
    const err = retryableError();
    expect(getRetryDelay(err, 1)).toBe(2000);
    expect(getRetryDelay(err, 2)).toBe(4000);
    expect(getRetryDelay(err, 3)).toBe(8000);
  });

  it('caps the delay at maxDelayMs', () => {
    const err = retryableError();
    expect(getRetryDelay(err, 10)).toBe(16000);
    expect(getRetryDelay(err, 10, { maxDelayMs: 5000 })).toBe(5000);
  });

  it('respects rate-limit retry_after over backoff', () => {
    const rateLimited = {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down', retry_after: 7 },
    };
    expect(getRetryDelay(rateLimited, 1)).toBe(7000);
  });

  it('honours custom backoff options', () => {
    const err = retryableError();
    expect(getRetryDelay(err, 1, { initialDelayMs: 100, backoffMultiplier: 3 })).toBe(100);
    expect(getRetryDelay(err, 2, { initialDelayMs: 100, backoffMultiplier: 3 })).toBe(300);
  });
});

describe('withRetry', () => {
  it('returns the result without retrying on success', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    let calls = 0;
    const onRetry = (attempt: number) => {
      expect(attempt).toBeGreaterThan(0);
    };

    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw retryableError();
        return 'recovered';
      },
      { initialDelayMs: 1, maxDelayMs: 5, onRetry }
    );

    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry on non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw fatalError();
        },
        { initialDelayMs: 1 }
      )
    ).rejects.toThrow('Invalid API key');
    expect(calls).toBe(1);
  });

  it('calls onMaxAttemptsReached and throws after exhausting attempts', async () => {
    let calls = 0;
    let maxReached: ParsedApiError | null = null;

    await expect(
      withRetry(
        async () => {
          calls++;
          throw retryableError();
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1,
          maxDelayMs: 2,
          onMaxAttemptsReached: (e) => { maxReached = e; },
        }
      )
    ).rejects.toThrow();

    expect(calls).toBe(3);
    expect(maxReached).not.toBeNull();
    expect(maxReached!.type).toBe('network_error');
  });
});

describe('withRetryGenerator', () => {
  async function* makeGen(values: number[]): AsyncGenerator<number> {
    for (const v of values) yield v;
  }

  it('yields all values from a successful generator', async () => {
    const out: number[] = [];
    for await (const v of withRetryGenerator(() => makeGen([1, 2, 3]))) {
      out.push(v);
    }
    expect(out).toEqual([1, 2, 3]);
  });

  it('restarts the generator on retryable failures', async () => {
    let attempts = 0;
    const factory = (): AsyncGenerator<number> => {
      attempts++;
      const failFirst = attempts < 2;
      return (async function* () {
        yield 1;
        if (failFirst) throw retryableError();
        yield 2;
      })();
    };

    const out: number[] = [];
    for await (const v of withRetryGenerator(factory, { initialDelayMs: 1, maxDelayMs: 2 })) {
      out.push(v);
    }

    // First attempt yields 1 then fails; second attempt yields 1, 2.
    expect(attempts).toBe(2);
    expect(out).toEqual([1, 1, 2]);
  });

  it('propagates non-retryable failures immediately', async () => {
    let attempts = 0;
    const factory = (): AsyncGenerator<number> => {
      attempts++;
      return (async function* () {
        yield 1;
        throw fatalError();
      })();
    };

    const consume = async () => {
      const out: number[] = [];
      for await (const v of withRetryGenerator(factory, { initialDelayMs: 1 })) {
        out.push(v);
      }
      return out;
    };

    await expect(consume()).rejects.toThrow('Invalid API key');
    expect(attempts).toBe(1);
  });
});
