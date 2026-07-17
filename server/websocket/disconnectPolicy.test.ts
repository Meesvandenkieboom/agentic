import { describe, expect, it } from 'bun:test';
import { getDisconnectAction } from './disconnectPolicy';

describe('getDisconnectAction', () => {
  it('keeps an active turn running when its last client disconnects', () => {
    expect(getDisconnectAction({
      remainingSockets: 0,
      hasStream: true,
      isGenerating: true,
    })).toBe('keep-generating');
  });

  it('allows an idle SDK stream to be cleaned up after its last client leaves', () => {
    expect(getDisconnectAction({
      remainingSockets: 0,
      hasStream: true,
      isGenerating: false,
    })).toBe('cleanup-after-grace');
  });

  it('does nothing while another client remains attached', () => {
    expect(getDisconnectAction({
      remainingSockets: 1,
      hasStream: true,
      isGenerating: true,
    })).toBe('none');
  });
});
