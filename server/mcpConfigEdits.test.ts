import { describe, expect, it } from 'bun:test';
import {
  connectionConfigChanged,
  editServerConfig,
  resolveServerConfig,
  type MCPServerConfig,
} from './mcpConfigEdits';

describe('MCP configuration editing', () => {
  const http: MCPServerConfig = {
    type: 'http',
    name: 'Docs',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer saved' },
  };
  it('preserves credentials and URL when only renaming', () => {
    const updated = editServerConfig(http, { name: 'New name' });
    expect(updated).toEqual({ ...http, name: 'New name' });
    expect(connectionConfigChanged(http, updated)).toBe(false);
  });
  it('does not reconnect for equivalent empty fields or reordered headers', () => {
    const stdio: MCPServerConfig = { type: 'stdio', command: 'node' };
    expect(
      connectionConfigChanged(
        stdio,
        editServerConfig(stdio, { name: 'Renamed', args: [] })
      )
    ).toBe(false);
    expect(
      connectionConfigChanged(
        { ...http, headers: { A: 'one', B: 'two' } },
        { ...http, headers: { B: 'two', A: 'one' } }
      )
    ).toBe(false);
  });
  it('removes credentials only when explicitly requested', () => {
    expect(editServerConfig(http, { headers: null })).toMatchObject({
      headers: {},
    });
    expect(
      editServerConfig(http, { headers: { 'X-Key': 'replacement' } })
    ).toMatchObject({ headers: { 'X-Key': 'replacement' } });
  });
  it('preserves environment secrets and exact argument boundaries', () => {
    const stdio: MCPServerConfig = {
      type: 'stdio',
      command: 'node',
      args: ['file with spaces.js', 'a,b', ''],
      env: { TOKEN: 'saved' },
    };
    expect(editServerConfig(stdio, { name: 'Local' })).toEqual({
      ...stdio,
      name: 'Local',
    });
    expect(editServerConfig(stdio, { env: null })).toMatchObject({ env: {} });
  });
  it('drops incompatible fields when changing transport', () => {
    expect(
      editServerConfig(http, {
        type: 'stdio',
        command: 'npx',
        args: ['server'],
      })
    ).toEqual({
      type: 'stdio',
      name: 'Docs',
      command: 'npx',
      args: ['server'],
      env: undefined,
    });
    expect(() => editServerConfig(http, { type: 'stdio' })).toThrow('command');
  });
  it('resolves built-in overrides and legacy name/header overrides consistently', () => {
    const config = {
      custom: { docs: { ...http, url: 'https://other.example/mcp' } },
      headerOverrides: { docs: { 'X-Key': 'legacy' } },
      nameOverrides: { docs: 'Legacy name' },
    };
    expect(resolveServerConfig(config, { docs: http }, 'docs')).toEqual({
      ...http,
      name: 'Legacy name',
      url: 'https://other.example/mcp',
      headers: { Authorization: 'Bearer saved', 'X-Key': 'legacy' },
    });
  });
  it('rejects malformed configuration without altering the current value', () => {
    for (const patch of [
      { url: 'file:///tmp/foo' },
      { headers: [] },
      { headers: { Auth: 1 } },
      { headers: { 'Bad Header': 'x' } },
      { headers: { Auth: 'a\r\nb' } },
      { name: null },
      { type: 'other' },
    ]) {
      expect(() => editServerConfig(http, patch)).toThrow();
    }
    expect(http.headers).toEqual({ Authorization: 'Bearer saved' });
  });
});
