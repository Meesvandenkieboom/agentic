/**
 * Single source of truth for which Anthropic models use the adaptive
 * thinking API ({type:"adaptive",display:"summarized"}) instead of the
 * legacy {type:"enabled",budget_tokens:N} form.
 *
 * Imported by BOTH:
 *   - scripts/patch-sdk-reminders.mjs (embeds the regex source into the
 *     patched SDK cli.js — plain node, so this file must stay .mjs)
 *   - server/websocket/messageHandlers.ts (max_tokens cap branch)
 *
 * Getting this wrong is silent: on adaptive-only models (Sonnet 5, Fable 5,
 * Mythos) the legacy form makes thinking blocks stream with an empty
 * `thinking` field. When adding a model, classify it here and update
 * shared/adaptiveThinkingModels.test.ts.
 */

// Opus 4.7+ (incl. 4.10+), Opus 5+, Sonnet 5+, Fable 5+, Mythos.
export const ADAPTIVE_THINKING_MODEL_REGEX_SOURCE =
  String.raw`opus-(?:4-(?:[7-9]|\d{2,})|[5-9])|sonnet-[5-9]|fable-[5-9]|mythos`;

export const ADAPTIVE_THINKING_MODEL_REGEX = new RegExp(ADAPTIVE_THINKING_MODEL_REGEX_SOURCE);

export function isAdaptiveThinkingModel(modelId) {
  return ADAPTIVE_THINKING_MODEL_REGEX.test(modelId);
}
