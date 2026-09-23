import { describe, expect, it } from 'bun:test';
import type { Message } from '../components/message/types';
import { MessageCache } from './messageCache';

const messages = (text: string): Message[] => [{ id: 'm', type: 'user', timestamp: '', content: text }];

describe('message history cache', () => {
  it('evicts least recently read chats when payloads exceed the total budget', () => {
    const payload = messages('x'.repeat(100));
    const measured = new MessageCache();
    measured.set('a', payload);
    const budget = measured.estimatedBytes * 2;
    const cache = new MessageCache(budget, budget);
    cache.set('a', payload);
    cache.set('b', payload);
    expect(cache.get('a')).toBe(payload);
    cache.set('c', payload);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(payload);
    expect(cache.get('c')).toBe(payload);
    expect(cache.estimatedBytes).toBeLessThanOrEqual(budget);
  });

  it('drops an entry when background output grows too large, including tool results', () => {
    const cache = new MessageCache(10_000, 1_000);
    cache.set('chat', messages('small'));
    cache.set('chat', [{ id: 'm', type: 'assistant', timestamp: '', content: [
      { type: 'tool_use', id: 'tool', name: 'Bash', input: { output: 'x'.repeat(1_000) } },
    ] }]);
    expect(cache.get('chat')).toBeUndefined();
    expect(cache.estimatedBytes).toBe(0);
  });

  it('counts attachment previews and releases replaced, cleared, and removed entries', () => {
    const cache = new MessageCache(10_000, 1_000);
    cache.set('image', [{ id: 'm', type: 'user', timestamp: '', content: '', attachments: [
      { id: 'a', name: 'image', type: 'image/png', size: 10, preview: 'x'.repeat(1_000) },
    ] }]);
    expect(cache.size).toBe(0);
    cache.set('chat', messages('first'));
    const size = cache.estimatedBytes;
    cache.set('chat', messages('later'));
    expect(cache.estimatedBytes).toBe(size);
    cache.delete('chat');
    expect(cache.estimatedBytes).toBe(0);
    cache.set('chat', messages('first'));
    cache.set('chat', []);
    expect(cache.size).toBe(0);
    expect(cache.estimatedBytes).toBe(0);
  });

  it('also limits the number of tiny chats', () => {
    const cache = new MessageCache(10_000, 1_000, 2);
    for (const id of ['a', 'b', 'c']) cache.set(id, messages('small'));
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
  });
});
