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
  } catch (err) {
    // Diagnostic: surface why the config didn't load. ENOENT is silent
    // (no config = fresh install, which is fine), but anything else is a
    // real problem that may explain "my MCP server isn't showing up!"
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      console.warn(`⚠️  MCP config read failed (${MCP_CONFIG_PATH}): ${e.code ?? ''} ${e.message ?? err}`);
    }
    return { enabled: {}, custom: {}, headerOverrides: {} };
  }
}

/**
 * Load header overrides from config file
 */
async function _loadHeaderOverrides(): Promise<Record<string, Record<string, string>>> {
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

  // Diagnostic: show what we loaded so user can verify the config file
  // was found and parsed. Useful for "my custom MCP server isn't showing
  // up" issues — typically the file path is wrong because process.cwd()
  // differs between dev (repo) and installed (~/.local/share/agentic-app).
  const customCount = Object.keys(mcpConfig.custom).length;
  const enabledIds = Object.keys(servers);
  console.log(
    `🔌 MCP loader [${provider}]: file=${MCP_CONFIG_PATH} ` +
    `built-in=${Object.keys(baseServers).length} custom=${customCount} → ` +
    `${enabledIds.length} enabled: [${enabledIds.join(', ') || 'none'}]`
  );

  return servers;
}

/**
 * Codex MCP server config shape.
 *
 * The Codex CLI reads MCP servers from `mcp_servers.<name>.*` config keys
 * (normally in ~/.codex/config.toml). We inject these at runtime via the
 * @openai/codex-sdk `CodexOptions.config` object, which the SDK flattens into
 * `--config key=value` CLI overrides. stdio servers use command/args/env;
 * streamable-HTTP servers use `url` (+ optional static `http_headers`).
 */
type CodexMcpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; http_headers?: Record<string, string> };

/**
 * Convert Agentic's internal MCP server map into the shape the Codex CLI
 * expects under `mcp_servers.*`.
 *
 * Agentic uses `{ type: 'http' | 'sse', url, headers? }` and
 * `{ type: 'stdio', command, args?, env? }`. Codex drops the discriminant and
 * keys HTTP transports off `url` (renaming `headers` → `http_headers`) and
 * stdio transports off `command`. Unknown/malformed entries are skipped.
 *
 * @param servers - Agentic-shaped MCP server map (post-bridging)
 * @returns Codex-shaped map suitable for `config.mcp_servers`
 */
export function toCodexMcpServers(
  servers: Record<string, unknown>,
): Record<string, CodexMcpServerConfig> {
  const out: Record<string, CodexMcpServerConfig> = {};

  for (const [id, raw] of Object.entries(servers)) {
    const cfg = raw as Record<string, unknown>;
    if (!cfg || typeof cfg !== 'object') continue;

    if ((cfg.type === 'http' || cfg.type === 'sse') && typeof cfg.url === 'string') {
      const headers = cfg.headers as Record<string, string> | undefined;
      out[id] = {
        url: cfg.url,
        ...(headers && Object.keys(headers).length > 0 ? { http_headers: headers } : {}),
      };
    } else if (cfg.type === 'stdio' && typeof cfg.command === 'string') {
      const args = cfg.args as string[] | undefined;
      const env = cfg.env as Record<string, string> | undefined;
      out[id] = {
        command: cfg.command,
        ...(args && args.length > 0 ? { args } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }

  return out;
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
