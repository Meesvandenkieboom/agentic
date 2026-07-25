import { describe, expect, it } from 'bun:test';
import { buildCodexConfig, parseCodexRetryNotice } from './codex';

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

describe('parseCodexRetryNotice', () => {
  it('recognizes a transient reconnect notice', () => {
    expect(parseCodexRetryNotice(
      'Reconnecting... 1/5 (stream disconnected before completion: Internal server error)',
    )).toEqual({
      type: 'retry_attempt',
      attempt: 1,
      maxAttempts: 5,
      message: 'stream disconnected before completion: Internal server error',
    });
  });

  it('handles nested parentheses in the detail', () => {
    expect(parseCodexRetryNotice(
      'Reconnecting... 2/5 (stream disconnected before completion: Connection reset by peer (os error 54))',
    )?.message).toBe('stream disconnected before completion: Connection reset by peer (os error 54)');
  });

  it('handles a notice with no detail', () => {
    expect(parseCodexRetryNotice('Reconnecting... 3/5')).toEqual({
      type: 'retry_attempt',
      attempt: 3,
      maxAttempts: 5,
      message: 'Connection interrupted',
    });
  });

  it('leaves real errors alone', () => {
    expect(parseCodexRetryNotice('backend failed (request id abc)')).toBeNull();
    expect(parseCodexRetryNotice(undefined)).toBeNull();
  });
});
