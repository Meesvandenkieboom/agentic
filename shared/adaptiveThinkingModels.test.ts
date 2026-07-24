import { describe, test, expect } from 'bun:test';
import { AVAILABLE_MODELS } from '../client/config/models';
import { isAdaptiveThinkingModel } from './adaptiveThinkingModels.mjs';

// Every Anthropic model must be consciously classified: adaptive thinking
// (Opus 4.7+, Sonnet 5+, Fable 5+, Mythos) or legacy enabled+budget_tokens.
// If the first test fails, a new model was added without classifying it here
// — decide which branch it belongs to and, if adaptive, make sure the shared
// regex matches it. Misclassifying an adaptive-only model as legacy makes
// its thinking blocks stream empty (Fable 5 and Sonnet 5 both hit this).
const EXPECTED_ADAPTIVE: Record<string, boolean> = {
  'claude-fable-5': true,
  'claude-opus-5': true,
  'claude-opus-4-8': true,
  'claude-sonnet-5': true,
  'claude-opus-4-6': false,
  'claude-haiku-4-5-20251001': false,
};

describe('adaptive thinking model classification', () => {
  test('every Anthropic model in AVAILABLE_MODELS is classified', () => {
    const anthropicIds = AVAILABLE_MODELS
      .filter(m => m.provider === 'anthropic')
      .map(m => m.apiModelId);
    for (const id of anthropicIds) {
      expect(Object.keys(EXPECTED_ADAPTIVE)).toContain(id);
    }
  });

  test('shared regex classifies each model as expected', () => {
    for (const [id, adaptive] of Object.entries(EXPECTED_ADAPTIVE)) {
      expect({ id, adaptive: isAdaptiveThinkingModel(id) }).toEqual({ id, adaptive });
    }
  });

  test('future versions of adaptive families stay adaptive', () => {
    for (const id of ['claude-opus-4-10', 'claude-opus-5', 'claude-sonnet-6', 'claude-fable-6']) {
      expect({ id, adaptive: isAdaptiveThinkingModel(id) }).toEqual({ id, adaptive: true });
    }
  });
});
