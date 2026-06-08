/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Covers the promise/generator wrappers in timeout.ts. The TimeoutController
 * class is covered separately in timeout.test.ts.
 */

import { describe, it, expect } from 'bun:test';
import { withTimeout, withTimeoutGenerator, TimeoutError } from './timeout';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withTimeout', () => {
  it('resolves with the value when the promise is fast', async () => {
    const result = await withTimeout(Promise.resolve('done'), { timeoutMs: 100, warningMs: 50 });
    expect(result).toBe('done');
  });

  it('rejects with TimeoutError when the promise is too slow', async () => {
    let timedOut = false;
    const slow = wait(200).then(() => 'late');

    await expect(
      withTimeout(slow, {
        timeoutMs: 40,
        warningMs: 20,
        onTimeout: () => { timedOut = true; },
      })
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(timedOut).toBe(true);
  });

  it('fires the warning callback before resolving', async () => {
    let warned = false;
    const result = await withTimeout(wait(80).then(() => 'value'), {
      timeoutMs: 1000,
      warningMs: 30,
      onWarning: () => { warned = true; },
    });
    expect(result).toBe('value');
    expect(warned).toBe(true);
  });
});

describe('withTimeoutGenerator', () => {
  async function* fastGen(): AsyncGenerator<number> {
    yield 1;
    yield 2;
    yield 3;
  }

  it('yields all values from a fast generator', async () => {
    const out: number[] = [];
    for await (const v of withTimeoutGenerator(fastGen(), { timeoutMs: 1000, warningMs: 500 })) {
      out.push(v);
    }
    expect(out).toEqual([1, 2, 3]);
  });

  it('throws TimeoutError when the generator stalls past the timeout', async () => {
    async function* stalling(): AsyncGenerator<number> {
      yield 1;
      await wait(80); // exceeds the timeout below
      yield 2;
    }

    let timedOut = false;
    const consume = async () => {
      const out: number[] = [];
      for await (const v of withTimeoutGenerator(stalling(), {
        timeoutMs: 30,
        warningMs: 15,
        onTimeout: () => { timedOut = true; },
      })) {
        out.push(v);
      }
      return out;
    };

    await expect(consume()).rejects.toBeInstanceOf(TimeoutError);
    expect(timedOut).toBe(true);
  });
});
