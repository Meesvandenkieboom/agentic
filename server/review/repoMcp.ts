import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { REPO_TOOLS, runRepoTool } from './gemini';

export interface McpRequest {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

/** Handles one JSON-RPC 2.0 MCP request against a fixed read-only worktree root. */
export async function handleMcpRequest(root: string, req: McpRequest): Promise<Record<string, unknown> | null> {
  if (req.id === undefined) return null;
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'repo', version: '1.0.0' },
        },
      };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: REPO_TOOLS.map(t => ({ ...t, annotations: { readOnlyHint: true } })),
        },
      };
    case 'tools/call': {
      const name = typeof req.params?.name === 'string' ? req.params.name : '';
      const args = (req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {}) as Record<string, unknown>;
      const r = await runRepoTool(root, name, args);
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{ type: 'text', text: r.text }],
          ...(r.isError ? { isError: true } : {}),
        },
      };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id: req.id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id: req.id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id: req.id, result: { prompts: [] } };
    case 'ping':
      return { jsonrpc: '2.0', id: req.id, result: {} };
    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
  }
}

if (import.meta.main) {
  const rawRoot = process.argv[2];
  if (!rawRoot) {
    process.stderr.write('Usage: repoMcp.ts <worktree-root>\n');
    process.exit(1);
  }
  const root = realpathSync(rawRoot);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    void (async () => {
      let req: McpRequest;
      try {
        req = JSON.parse(line) as McpRequest;
      } catch {
        return;
      }
      const res = await handleMcpRequest(root, req);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    })();
  });
}
