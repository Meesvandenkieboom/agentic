/**
 * Commands API Routes
 * Handles loading slash commands from .claude/commands directory
 */

import * as fs from 'fs';
import * as path from 'path';
import { sessionDb } from "../database";
import { setupSessionCommands } from '../commandSetup';
import { getRuntimeSessionPaths } from '../sessionWorkspace';

interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/**
 * Built-in Claude Code commands that are passed through to the SDK
 * These commands are handled internally by the SDK and don't require .md files
 */
const BUILT_IN_COMMANDS: SlashCommand[] = [
  {
    name: 'clear',
    description: 'Clear conversation history and start fresh',
    argumentHint: '',
  },
  {
    name: 'compact',
    description: 'Compact conversation history to reduce token usage',
    argumentHint: '',
  },
];

/**
 * Parse frontmatter from markdown file
 */
function parseFrontmatter(content: string): { description: string; argumentHint: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return { description: '', argumentHint: '' };
  }

  const frontmatter = frontmatterMatch[1];
  const descMatch = frontmatter.match(/description:\s*(.+)/);
  const argMatch = frontmatter.match(/argument-hint:\s*(.+)/);

  return {
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    argumentHint: argMatch ? argMatch[1].trim().replace(/^["']|["']$/g, '') : '',
  };
}

/**
 * Load app-owned commands plus any commands intentionally present in the
 * selected project. Project commands win on name collisions.
 */
async function loadSessionCommands(
  workspaceDir: string,
  metadataDir: string,
  mode: string,
): Promise<SlashCommand[]> {
  const appCommandsDir = path.join(metadataDir, '.claude', 'commands');

  if (!fs.existsSync(appCommandsDir)) {
    setupSessionCommands(metadataDir, mode);
  }

  const commands = new Map<string, SlashCommand>();
  const commandDirs = [appCommandsDir, path.join(workspaceDir, '.claude', 'commands')];
  for (const commandsDir of commandDirs) {
    if (!fs.existsSync(commandsDir)) continue;
    for (const file of fs.readdirSync(commandsDir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(commandsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const { description, argumentHint } = parseFrontmatter(content);
      const name = file.replace('.md', '');
      commands.set(name, {
        name,
        description,
        argumentHint,
      });
    }
  }

  return [...commands.values()];
}

/**
 * Handle command-related API routes
 */
export async function handleCommandRoutes(
  req: Request,
  url: URL
): Promise<Response | undefined> {

  // GET /api/sessions/:id/commands - Get slash commands for session
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/commands$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[3];
    const session = sessionDb.getSession(sessionId);

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const paths = getRuntimeSessionPaths(session);
    const customCommands = await loadSessionCommands(paths.workspace, paths.metadata, session.mode);

    // Merge built-in commands with custom commands
    const commands = [...BUILT_IN_COMMANDS, ...customCommands];

    return new Response(JSON.stringify({ commands }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return undefined;
}
