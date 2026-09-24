import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { isAdaptiveThinkingModel } from '../../shared/adaptiveThinkingModels.mjs';

type ClaudeThinkingOptions = Pick<Options, 'thinking' | 'effort'>;

const THINKING_BUDGETS: Record<string, number> = {
  low: 2_000,
  medium: 16_000,
  high: 80_000,
  xhigh: 128_000,
  max: 200_000,
};

/** Use the SDK's native thinking and effort controls for current Claude models. */
export function getClaudeThinkingOptions(modelId: string, requestedEffort?: string): ClaudeThinkingOptions {
  const effort = requestedEffort === 'ultra' ? 'max' : requestedEffort;
  const selectedEffort = effort && Object.hasOwn(THINKING_BUDGETS, effort) ? effort : 'high';

  if (isAdaptiveThinkingModel(modelId)) {
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: selectedEffort as Options['effort'],
    };
  }

  // Haiku 4.5 has a 64K maximum output; leave room for its final answer.
  const maxBudget = modelId.includes('haiku-4-5') ? 32_000 : 127_000;
  return {
    thinking: {
      type: 'enabled',
      budgetTokens: Math.min(THINKING_BUDGETS[selectedEffort], maxBudget),
    },
  };
}
