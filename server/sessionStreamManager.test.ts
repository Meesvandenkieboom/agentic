import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStreamManager } from './sessionStreamManager';
const managers: SessionStreamManager[] = [];
const create = () => { const manager = new SessionStreamManager(); managers.push(manager); return manager; };
afterEach(() => { for (const manager of managers.splice(0)) manager.shutdown(); });

describe('session lifecycle', () => {
  it('expires only idle sessions, even after hours of quiet generation', () => {
    const manager = create();
    manager.getOrCreateStream('busy'); manager.setGenerating('busy', true);
    manager.getOrCreateStream('idle');
    manager.cleanupIdleSessions(Date.now() + 3 * 60 * 60 * 1000);
    expect(manager.hasStream('busy')).toBe(true);
    expect(manager.getAbortController('busy')?.signal.aborted).toBe(false);
    expect(manager.hasStream('idle')).toBe(false);
  });

  it('evicts an idle session at capacity and refuses to evict active work', () => {
    const manager = create();
    for (let n = 0; n < 100; n++) { manager.getOrCreateStream(String(n)); manager.setGenerating(String(n), true); }
    expect(() => manager.getOrCreateStream('overflow')).toThrow('All available sessions are busy');
    expect(manager.getActiveSessionIds()).toHaveLength(100);
    manager.setIdle('20'); manager.getOrCreateStream('new');
    expect(manager.hasStream('20')).toBe(false); expect(manager.hasStream('0')).toBe(true);
  });

  it('keeps Codex alive across browser disconnects and waits for native Stop completion', async () => {
    const manager = create(); manager.getOrCreateStream('codex'); manager.keepAliveOnDisconnect('codex'); manager.setGenerating('codex', true);
    let expired = false;
    manager.startDisconnectGracePeriod('codex', () => { expired = true; }, 1);
    await Bun.sleep(10);
    expect(expired).toBe(false);
    expect(manager.isGenerating('codex')).toBe(true);
    manager.abortSession('codex');
    expect(manager.getAbortController('codex')?.signal.aborted).toBe(true);
    expect(manager.isGenerating('codex')).toBe(true);
    manager.setIdle('codex'); expect(manager.isGenerating('codex')).toBe(false);
  });
});
