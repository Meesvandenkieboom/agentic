export type DisconnectAction = 'none' | 'keep-generating' | 'cleanup-after-grace';

interface DisconnectState {
  remainingSockets: number;
  hasStream: boolean;
  isGenerating: boolean;
}

/**
 * Decide what to do with a session after one of its WebSockets disconnects.
 * Active turns belong to the server and must survive refreshes and temporary
 * network failures; only idle SDK streams are eligible for delayed cleanup.
 */
export function getDisconnectAction({
  remainingSockets,
  hasStream,
  isGenerating,
}: DisconnectState): DisconnectAction {
  if (remainingSockets > 0 || !hasStream) return 'none';
  return isGenerating ? 'keep-generating' : 'cleanup-after-grace';
}
