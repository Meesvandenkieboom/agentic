/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Model Configuration
 *
 * Centralized definitions for all available AI models.
 * Add new models here to make them available in the UI.
 */

export type ProviderType = 'anthropic' | 'codex';

export const DEFAULT_MODEL_ID = 'opus-4-8';

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'opus-4-7': DEFAULT_MODEL_ID,
};

export interface ModelConfig {
  id: string;
  name: string;
  description: string;
  apiModelId: string;
  provider: ProviderType;
}

/**
 * Available Models
 *
 * Add new models to this array to make them available in the model selector.
 */
export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: 'opus-4-8',
    name: 'Claude Opus 4.8',
    description: 'Latest and most capable Opus model for advanced reasoning and coding',
    apiModelId: 'claude-opus-4-8',
    provider: 'anthropic',
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet 4.6',
    description: 'Anthropic\'s most intelligent model for complex agents and coding',
    apiModelId: 'claude-sonnet-4-6',
    provider: 'anthropic',
  },
  {
    id: 'opus',
    name: 'Claude Opus 4.6',
    description: 'Powerful model with enhanced capabilities for advanced tasks',
    apiModelId: 'claude-opus-4-6',
    provider: 'anthropic',
  },
  {
    id: 'hive',
    name: 'Claude HIVE',
    description: 'Opus orchestrator with Sonnet worker swarm for complex tasks',
    apiModelId: 'claude-opus-4-8',
    provider: 'anthropic',
  },
  {
    id: 'haiku',
    name: 'Claude Haiku 4.5',
    description: 'Fast and efficient model for quick tasks and rapid responses',
    apiModelId: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
  },
  {
    id: 'codex',
    name: 'Codex (GPT-5.5)',
    description: 'OpenAI Codex via ChatGPT — latest GPT-5.5 coding agent',
    apiModelId: 'gpt-5.5',
    provider: 'codex',
  },
  {
    id: 'codex-5-4',
    name: 'Codex (GPT-5.4)',
    description: 'OpenAI Codex via ChatGPT — stable GPT-5.4 coding agent',
    apiModelId: 'gpt-5.4',
    provider: 'codex',
  },
  {
    id: 'codex-5-4-mini',
    name: 'Codex (GPT-5.4 mini)',
    description: 'OpenAI Codex via ChatGPT — faster, lighter GPT-5.4 mini',
    apiModelId: 'gpt-5.4-mini',
    provider: 'codex',
  },
];

/**
 * Get model configuration by ID
 */
export function getModelConfig(modelId: string): ModelConfig | undefined {
  return AVAILABLE_MODELS.find(m => m.id === modelId);
}

/**
 * Get the default model
 */
export function getDefaultModel(): ModelConfig {
  return AVAILABLE_MODELS.find(m => m.id === DEFAULT_MODEL_ID) || AVAILABLE_MODELS[0];
}

/**
 * Normalize persisted/requested model IDs to a currently available selector ID.
 */
export function normalizeModelId(modelId?: string | null): string {
  const candidate = modelId ? LEGACY_MODEL_ALIASES[modelId] || modelId : DEFAULT_MODEL_ID;
  return getModelConfig(candidate)?.id || getDefaultModel().id;
}
