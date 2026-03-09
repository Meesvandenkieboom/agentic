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

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ProviderType } from '../client/config/models';

const MCP_CONFIG_PATH = path.join(process.cwd(), '.claude', 'mcp-servers.json');

interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

interface McpStdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

interface McpServersConfig {
  enabled: Record<string, boolean>;
  custom: Record<string, McpServerConfig & { name?: string }>;
  headerOverrides: Record<string, Record<string, string>>;
}

/**
 * Load MCP config from file
 */
async function loadMcpConfig(): Promise<McpServersConfig> {
  try {
    const data = await fs.readFile(MCP_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(data);
    return {
      enabled: config.enabled || {},
      custom: config.custom || {},
      headerOverrides: config.headerOverrides || {},
    };
  } catch {
    return { enabled: {}, custom: {}, headerOverrides: {} };
  }
}

/**
 * Load header overrides from config file
 */
async function loadHeaderOverrides(): Promise<Record<string, Record<string, string>>> {
  const config = await loadMcpConfig();
  return config.headerOverrides;
}

/**
 * MCP servers configuration for different providers
 * - Shared MCP servers (grep.app, context7): Available to all providers
 */
export const MCP_SERVERS_BY_PROVIDER: Record<ProviderType, Record<string, McpServerConfig>> = {
  'anthropic': {
    // Grep.app MCP - code search across public GitHub repositories
    'grep': {
      type: 'http',
      url: 'https://mcp.grep.app',
    },
    // Context7 MCP - real-time library documentation lookup
    'context7': {
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
    },
  },
  'codex': {
    // Grep.app MCP - code search across public GitHub repositories
    'grep': {
      type: 'http',
      url: 'https://mcp.grep.app',
    },
    // Context7 MCP - real-time library documentation lookup
    'context7': {
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
    },
  },
};

/**
 * Get MCP servers for a specific provider (with header overrides merged)
 * Includes both built-in servers and user-added custom servers
 *
 * @param provider - The provider type
 * @param _modelId - Optional model ID for model-specific MCP server restrictions
 */
export async function getMcpServers(provider: ProviderType, _modelId?: string): Promise<Record<string, McpServerConfig>> {
  const baseServers = MCP_SERVERS_BY_PROVIDER[provider] || {};
  const mcpConfig = await loadMcpConfig();

  // Deep clone and merge header overrides for built-in servers
  const servers: Record<string, McpServerConfig> = {};

  // Add built-in servers (if enabled)
  for (const [id, config] of Object.entries(baseServers)) {
    // Skip if explicitly disabled
    if (mcpConfig.enabled[id] === false) {
      continue;
    }

    if (config.type === 'http' && mcpConfig.headerOverrides[id]) {
      servers[id] = {
        ...config,
        headers: {
          ...config.headers,
          ...mcpConfig.headerOverrides[id],
        },
      };
    } else {
      servers[id] = config;
    }
  }

  // Add custom servers (if enabled)
  for (const [id, config] of Object.entries(mcpConfig.custom)) {
    // Skip if explicitly disabled
    if (mcpConfig.enabled[id] === false) {
      continue;
    }

    // Add the custom server (strip the name field as it's not part of McpServerConfig)
    const { name: _name, ...serverConfig } = config;
    servers[id] = serverConfig as McpServerConfig;
  }

  return servers;
}

/**
 * Get allowed tools for a provider's MCP servers
 *
 * @param provider - The provider type
 * @param _modelId - Optional model ID for model-specific tool restrictions
 */
export function getAllowedMcpTools(provider: ProviderType, _modelId?: string): string[] {
  // Grep.app MCP tools - available to all providers
  const grepTools = [
    'mcp__grep__searchGitHub',
  ];

  // Context7 MCP tools - real-time library documentation lookup
  const context7Tools = [
    'mcp__context7__resolve-library-id',
    'mcp__context7__get-library-docs',
  ];

  if (provider === 'anthropic' || provider === 'codex') {
    return [
      ...grepTools,
      ...context7Tools,
    ];
  }

  return [];
}
