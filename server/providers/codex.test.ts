import { describe, expect, it } from 'bun:test';
import { buildCodexConfig } from './codex';

describe('buildCodexConfig', () => {
  it('preserves native configuration when Agentic has no overrides', () => {
    expect(buildCodexConfig({})).toEqual({});
  });

  it('preserves an explicit empty skill selection', () => {
    expect(buildCodexConfig({ skillsConfig: [] })).toEqual({
      skills: { config: [] },
    });
  });

  it('combines repository guidance, MCP servers, and skill selection', () => {
    expect(buildCodexConfig({
      developerInstructions: 'Use Agentic GitHub credentials.',
      mcpServers: { docs: { url: 'https://example.test/mcp' } },
      skillsConfig: [
        { path: '/skills/firecrawl/SKILL.md', enabled: false },
        { path: '/skills/demo/SKILL.md', enabled: true },
      ],
    })).toEqual({
      developer_instructions: 'Use Agentic GitHub credentials.',
      mcp_servers: { docs: { url: 'https://example.test/mcp' } },
      skills: {
        config: [
          { path: '/skills/firecrawl/SKILL.md', enabled: false },
          { path: '/skills/demo/SKILL.md', enabled: true },
        ],
      },
    });
  });
});
