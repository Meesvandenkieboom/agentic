import fs from 'fs';
import path from 'path';

/**
 * Built-in Claude Code commands that are handled by the SDK
 * These don't need .md files and are passed through unchanged
 */
export const BUILT_IN_COMMANDS = new Set(['clear', 'compact']);

/**
 * Parse frontmatter from markdown file
 */
function parseFrontmatter(content: string): {
  description?: string;
  argumentHint?: string;
  body: string;
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { body: content };
  }

  const [, frontmatter, body] = match;
  const parsed: Record<string, string> = {};

  frontmatter.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split(':');
    if (key && valueParts.length > 0) {
      const trimmedKey = key.trim().replace(/-/g, '_'); // Convert kebab-case to snake_case
      const value = valueParts.join(':').trim().replace(/^["']|["']$/g, ''); // Remove quotes
      parsed[trimmedKey] = value;
    }
  });

  return {
    description: parsed.description,
    argumentHint: parsed.argument_hint,
    body: body.trim(),
  };
}

/**
 * Expand slash command to full prompt
 * Returns null if not a slash command or command not found
 */
export function expandSlashCommand(
  message: string,
  workingDir: string,
  metadataDir?: string,
): string | null {
  // Check if message starts with slash command
  const commandMatch = message.match(/^\/([a-z-]+)(\s+(.*))?$/);
  if (!commandMatch) {
    return null; // Not a slash command
  }

  const [, commandName, , commandArgs = ''] = commandMatch;

  // Check if this is a built-in command (handled by SDK internally)
  if (BUILT_IN_COMMANDS.has(commandName)) {
    console.log(`✨ Built-in command detected: /${commandName}, passing through to SDK`);
    return message; // Return original message unchanged - SDK will handle it
  }

  // User project commands take precedence; Agentic's app-owned commands are
  // stored in the session metadata directory so selected repos stay clean.
  const commandFiles = [
    path.join(workingDir, '.claude', 'commands', `${commandName}.md`),
    metadataDir ? path.join(metadataDir, '.claude', 'commands', `${commandName}.md`) : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const commandFile = commandFiles.find(candidate => fs.existsSync(candidate));

  if (!commandFile) {
    console.warn(`⚠️  Slash command not found: /${commandName} (looked in ${commandFiles.join(', ')})`);
    return null; // Command file not found
  }

  try {
    // Read command file
    const commandContent = fs.readFileSync(commandFile, 'utf-8');
    const { body } = parseFrontmatter(commandContent);

    // Replace $ARGUMENTS with actual arguments
    const expandedPrompt = body.replace(/\$ARGUMENTS/g, commandArgs.trim());
    return expandedPrompt;
  } catch (error) {
    console.error(`❌ Error expanding slash command /${commandName}:`, error);
    return null;
  }
}
