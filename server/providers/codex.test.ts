import { describe, expect, it } from 'bun:test';
import { buildCodexConfig, buildCodexInput, parseCodexRetryNotice } from './codex';

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

describe('buildCodexInput', () => {
  it('keeps text-only turns as a string', () => {
    expect(buildCodexInput('Inspect the component')).toBe('Inspect the component');
  });

  it('adds attached images as local_image entries', () => {
    expect(buildCodexInput('Compare these', ['/tmp/before.png', '/tmp/after.jpg'])).toEqual([
      { type: 'text', text: 'Compare these' },
      { type: 'local_image', path: '/tmp/before.png' },
      { type: 'local_image', path: '/tmp/after.jpg' },
    ]);
  });

  it('supports an image-only turn without adding a blank text entry', () => {
    expect(buildCodexInput('', ['/tmp/screenshot.png'])).toEqual([
      { type: 'local_image', path: '/tmp/screenshot.png' },
    ]);
  });
});
