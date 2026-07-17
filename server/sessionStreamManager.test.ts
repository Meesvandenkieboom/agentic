import { describe, expect, it } from 'bun:test';
import { shouldCleanupIdleStream } from './sessionStreamManager';

describe('shouldCleanupIdleStream', () => {
  it('never expires a turn that is still generating', () => {
    expect(shouldCleanupIdleStream(true, 24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000)).toBe(false);
  });

  it('expires an idle stream after the inactivity limit', () => {
    expect(shouldCleanupIdleStream(false, 2 * 60 * 60 * 1000 + 1, 2 * 60 * 60 * 1000)).toBe(true);
  });
});
