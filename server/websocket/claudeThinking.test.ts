import { describe, expect, it } from 'bun:test';
import { getClaudeThinkingOptions } from './claudeThinking';

describe('Claude thinking options', () => {
  it('uses native adaptive thinking and preserves effort for current models', () => {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-4-6']) {
      expect(getClaudeThinkingOptions(model, 'xhigh')).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'xhigh',
      });
    }
    expect(getClaudeThinkingOptions('claude-opus-5-5', 'ultra').effort).toBe('max');
    expect(getClaudeThinkingOptions('claude-opus-5-5').effort).toBe('high');
  });

  it('keeps Haiku on fixed thinking with room for output at high effort', () => {
    const model = 'claude-haiku-4-5-20251001';
    expect(getClaudeThinkingOptions(model, 'low')).toEqual({
      thinking: { type: 'enabled', budgetTokens: 2_000 },
    });
    expect(getClaudeThinkingOptions(model, 'max')).toEqual({
      thinking: { type: 'enabled', budgetTokens: 32_000 },
    });
  });
});
