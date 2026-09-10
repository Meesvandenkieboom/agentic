/** Shared configuration rules for the settings API and chat runtime. */
export type MCPServerConfig =
  | {
      type: 'http';
      name?: string;
      url: string;
      headers?: Record<string, string>;
      authProvider?: string;
    }
  | {
      type: 'stdio';
      name?: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export interface EditableMCPConfig {
  custom: Record<string, MCPServerConfig>;
  headerOverrides: Record<string, Record<string, string>>;
  nameOverrides?: Record<string, string>;
}

export function resolveServerConfig(
  config: EditableMCPConfig,
  builtins: Record<string, MCPServerConfig>,
  id: string
): MCPServerConfig | undefined {
  const server = config.custom[id] || builtins[id];
  if (!server) return undefined;
  return {
    ...server,
    ...(config.nameOverrides?.[id] ? { name: config.nameOverrides[id] } : {}),
    ...(server.type === 'http' && config.headerOverrides[id]
      ? { headers: { ...server.headers, ...config.headerOverrides[id] } }
      : {}),
  };
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, v]) => !key.trim() || typeof v !== 'string'
    )
  ) {
    throw new Error(
      `${label} must be an object with non-empty keys and string values`
    );
  }
  const entries = Object.entries(value) as Array<[string, string]>;
  for (const [key, val] of entries) {
    if (
      label === 'Headers' &&
      (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(val))
    ) {
      throw new Error('Headers contain an invalid name or line break');
    }
    if (
      label === 'Environment variables' &&
      (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || val.includes('\0'))
    ) {
      throw new Error('Environment variables contain an invalid name or value');
    }
  }
  return Object.fromEntries(entries);
}

/** Omitted fields are preserved; null explicitly removes credentials. */
export function editServerConfig(
  current: MCPServerConfig | undefined,
  input: unknown
): MCPServerConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected a configuration object');
  const body = input as Record<string, unknown>;
  const type = body.type ?? current?.type;
  if (type !== 'http' && type !== 'stdio')
    throw new Error('Choose HTTP or Stdio');
  if ('name' in body && typeof body.name !== 'string')
    throw new Error('Display name must be text');
  const name = 'name' in body ? (body.name as string).trim() : current?.name;
  if (type === 'http') {
    const previous = current?.type === 'http' ? current : undefined;
    const url = body.url ?? previous?.url;
    if (typeof url !== 'string' || !url.trim())
      throw new Error('HTTP servers require a URL');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Enter a valid HTTP or HTTPS URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new Error('Use an HTTP or HTTPS URL');
    const headers =
      'headers' in body
        ? body.headers === null
          ? {}
          : stringMap(body.headers, 'Headers')
        : previous?.headers;
    return {
      type,
      name,
      url: url.trim(),
      headers,
      ...(previous?.authProvider && previous.url === url.trim()
        ? { authProvider: previous.authProvider }
        : {}),
    };
  }
  const previous = current?.type === 'stdio' ? current : undefined;
  const command = body.command ?? previous?.command;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0'))
    throw new Error('Stdio servers require a command');
  const args = body.args ?? previous?.args ?? [];
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new Error('Arguments must be an array of strings');
  const env =
    'env' in body
      ? body.env === null
        ? {}
        : stringMap(body.env, 'Environment variables')
      : previous?.env;
  return { type, name, command: command.trim(), args, env };
}

export function connectionConfigChanged(
  before: MCPServerConfig,
  after: MCPServerConfig
): boolean {
  const sortedValues = (values: Record<string, string> = {}) =>
    Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  const connection = (server: MCPServerConfig) =>
    server.type === 'http'
      ? {
          type: server.type,
          url: server.url,
          headers: sortedValues(server.headers),
        }
      : {
          type: server.type,
          command: server.command,
          args: server.args || [],
          env: sortedValues(server.env),
        };
  return (
    JSON.stringify(connection(before)) !== JSON.stringify(connection(after))
  );
}
