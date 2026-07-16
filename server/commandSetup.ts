/**
 * Command Setup - Automatically copies slash commands to session directories
 */

import * as fs from 'fs';
import * as path from 'path';
import { getBinaryDir } from './startup';

/**
 * Setup slash commands for a session by copying template .md files
 * App-owned commands and mode metadata live outside the working tree. This is
 * especially important for user-selected repositories, which Agentic must not
 * mutate merely to attach a chat to them.
 */
export function setupSessionCommands(metadataDir: string, mode: string): void {
  const commandsDir = path.join(metadataDir, '.claude', 'commands');

  // Create .claude/commands/ directory
  if (!fs.existsSync(commandsDir)) {
    fs.mkdirSync(commandsDir, { recursive: true });
  }

  // Get the app's base directory (works in both dev and release)
  const baseDir = getBinaryDir();

  let copiedCount = 0;

  // Copy shared commands (available in all modes)
  const sharedCommandsDir = path.join(baseDir, 'server', 'commands', 'shared');
  if (fs.existsSync(sharedCommandsDir)) {
    const sharedFiles = fs.readdirSync(sharedCommandsDir).filter(f => f.endsWith('.md'));
    for (const file of sharedFiles) {
      const sourcePath = path.join(sharedCommandsDir, file);
      const destPath = path.join(commandsDir, file);
      fs.copyFileSync(sourcePath, destPath);
      copiedCount++;
    }
  }

  // Copy mode-specific commands
  const modeCommandsDir = path.join(baseDir, 'server', 'commands', mode);
  if (fs.existsSync(modeCommandsDir)) {
    const modeFiles = fs.readdirSync(modeCommandsDir).filter(f => f.endsWith('.md'));
    for (const file of modeFiles) {
      const sourcePath = path.join(modeCommandsDir, file);
      const destPath = path.join(commandsDir, file);
      fs.copyFileSync(sourcePath, destPath);
      copiedCount++;
    }
  }

  const templateClaudeFile = path.join(baseDir, 'server', 'templates', mode, 'CLAUDE.md');
  const destClaudeFile = path.join(metadataDir, 'CLAUDE.md');

  // Ensure metadata directory exists
  if (!fs.existsSync(metadataDir)) {
    fs.mkdirSync(metadataDir, { recursive: true });
  }

  // Only copy if template exists and destination doesn't exist (don't overwrite user's CLAUDE.md)
  if (fs.existsSync(templateClaudeFile) && !fs.existsSync(destClaudeFile)) {
    fs.copyFileSync(templateClaudeFile, destClaudeFile);
    console.log(`📝 Created CLAUDE.md in metadata/ for ${mode} mode`);
  }

  // Only log if commands were actually copied (less noise)
  if (copiedCount > 0) {
    console.log(`📋 Loaded ${copiedCount} slash command${copiedCount === 1 ? '' : 's'} for ${mode} mode`);
  }
}

/**
 * Get count of available commands for a session
 */
export function getCommandCount(metadataDir: string): number {
  const commandsDir = path.join(metadataDir, '.claude', 'commands');

  if (!fs.existsSync(commandsDir)) {
    return 0;
  }

  const files = fs.readdirSync(commandsDir);
  return files.filter(f => f.endsWith('.md')).length;
}
