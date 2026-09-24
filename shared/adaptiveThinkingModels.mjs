/**
 * Classify Claude models for the Agent SDK's thinking configuration.
 * Current models use adaptive thinking and an effort level; older models
 * use a fixed token budget. Update the matching tests with each new model.
 */

// Opus 4.6+, Sonnet 5+, Fable 5+, and Mythos use adaptive thinking.
export const ADAPTIVE_THINKING_MODEL_REGEX_SOURCE =
  String.raw`opus-(?:4-(?:[6-9]|\d{2,})|[5-9])|sonnet-[5-9]|fable-[5-9]|mythos`;

export const ADAPTIVE_THINKING_MODEL_REGEX = new RegExp(ADAPTIVE_THINKING_MODEL_REGEX_SOURCE);

export function isAdaptiveThinkingModel(modelId) {
  return ADAPTIVE_THINKING_MODEL_REGEX.test(modelId);
}
