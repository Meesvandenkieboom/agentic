import type { Message } from '../components/message/types';

// Approximate retained JS payload, not serialized JSON size. Stop counting as
// soon as an entry is too large; never allocate another copy of a huge transcript.
function estimateBytes(value: unknown, limit: number, seen = new WeakSet<object>()): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 64;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    bytes += key.length * 2 + estimateBytes((value as Record<string, unknown>)[key], limit - bytes, seen);
    if (bytes > limit) break;
  }
  return bytes;
}

/** Disposable history cache: evicted chats are reloaded from the database. */
export class MessageCache {
  private entries = new Map<string, { messages: Message[]; bytes: number }>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntryBytes = 8 * 1024 * 1024,
    private readonly maxEntries = 20,
  ) {}

  get size(): number { return this.entries.size; }
  get estimatedBytes(): number { return this.bytes; }

  get(id: string): Message[] | undefined {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.messages;
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(id); }
  }

  set(id: string, messages: Message[]): void {
    this.delete(id);
    if (!id || !messages.length) return;
    const limit = Math.min(this.maxBytes, this.maxEntryBytes);
    const bytes = estimateBytes(messages, limit);
    if (bytes > limit) return;
    this.entries.set(id, { messages, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      this.delete(this.entries.keys().next().value!);
    }
  }
}
