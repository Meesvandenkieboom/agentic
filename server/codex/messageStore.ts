import type { SessionDatabase, SessionMessage } from '../database';
import type { CodexBlock } from '../providers/codex';

interface Group { message: SessionMessage; blocks: Map<string, CodexBlock> }

/** Persist stable message identities and coalesce small deltas before publishing snapshots. */
export class CodexMessageStore {
  private current: Group | null = null;
  private owners = new Map<string, Group>();
  private dirty = new Set<Group>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly sessionId: string,
    private readonly db: Pick<SessionDatabase, 'addMessage' | 'updateMessage'>,
    private readonly publish: (message: SessionMessage) => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  update(block: CodexBlock): void {
    let group = this.owners.get(block.id);
    if (!group) {
      // Bound each saved snapshot during long turns with many tool calls.
      if (this.current && this.current.blocks.size >= 32) this.current = null;
      if (!this.current) this.current = { message: this.db.addMessage(this.sessionId, 'assistant', '[]'), blocks: new Map() };
      group = this.current;
      this.owners.set(block.id, group);
    }
    group.blocks.set(block.id, block);
    this.dirty.add(group);
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      try { this.flush(); } catch (error) { this.onError(error); }
    }, 120);
  }

  inputBoundary(): void { this.flush(); this.current = null; }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const group of this.dirty) {
      group.message.content = JSON.stringify([...group.blocks.values()]);
      this.db.updateMessage(group.message.id, group.message.content);
      this.publish(group.message);
      this.dirty.delete(group);
    }
  }
}
