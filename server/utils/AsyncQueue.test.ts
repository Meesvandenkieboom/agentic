/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { AsyncQueue } from './AsyncQueue';

describe('AsyncQueue', () => {
  it('buffers items enqueued before a consumer arrives', async () => {
    const queue = new AsyncQueue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    expect(queue.size).toBe(2);

    const received: number[] = [];
    queue.complete();
    for await (const item of queue) {
      received.push(item);
    }
    expect(received).toEqual([1, 2]);
  });

  it('delivers items to a waiting consumer immediately', async () => {
    const queue = new AsyncQueue<string>();
    const received: string[] = [];

    const consumer = (async () => {
      for await (const item of queue) {
        received.push(item);
        if (received.length === 2) break;
      }
    })();

    // Give the consumer a tick to start waiting.
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.hasWaitingConsumers).toBe(true);

    queue.enqueue('a');
    queue.enqueue('b');
    await consumer;

    expect(received).toEqual(['a', 'b']);
  });

  it('ends iteration once completed and drained', async () => {
    const queue = new AsyncQueue<number>();
    queue.enqueue(42);
    queue.complete();

    const received: number[] = [];
    for await (const item of queue) {
      received.push(item);
    }
    expect(received).toEqual([42]);
  });

  it('throws when enqueueing after completion', () => {
    const queue = new AsyncQueue<number>();
    queue.complete();
    expect(() => queue.enqueue(1)).toThrow('Cannot enqueue to completed queue');
  });

  it('resolves a pending consumer when completed', async () => {
    const queue = new AsyncQueue<number>();
    const received: number[] = [];

    const consumer = (async () => {
      for await (const item of queue) {
        received.push(item);
      }
    })();

    await new Promise((r) => setTimeout(r, 5));
    expect(queue.hasWaitingConsumers).toBe(true);

    queue.complete();
    await consumer;
    expect(received).toEqual([]);
  });

  it('reports size and waiting-consumer state accurately', () => {
    const queue = new AsyncQueue<number>();
    expect(queue.size).toBe(0);
    expect(queue.hasWaitingConsumers).toBe(false);
    queue.enqueue(1);
    expect(queue.size).toBe(1);
  });
});
