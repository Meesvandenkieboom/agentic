/**
 * Discovery and Agentic-specific selection of user-installed Codex skills.
 *
 * Agentic never edits the user's native Codex configuration. In inherit mode
 * no override is sent to Codex. Custom mode supplies a per-session allowlist
 * for skills discovered under ~/.agents/skills.
 */

import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import { homedir } from 'os';
import * as path from 'path';

export type SkillPolicyMode = 'inherit' | 'custom';

export interface SkillPolicy {
  mode: SkillPolicyMode;
  enabledPaths: string[];
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string;
}

export interface CodexSkillConfigEntry {
  path: string;
  enabled: boolean;
}

export const DEFAULT_SKILL_POLICY: SkillPolicy = {
  mode: 'inherit',
  enabledPaths: [],
};

export function getUserSkillsDirectory(): string {
  return process.env.AGENTIC_SKILLS_DIR || path.join(homedir(), '.agents', 'skills');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillFrontmatter(content: string): Pick<DiscoveredSkill, 'name' | 'description'> {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!match) return { name: '', description: '' };

  const lines = match[1].split('\n');
  let name = '';
  let description = '';

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;

    if (field[1] === 'name') {
      name = unquote(field[2]);
      continue;
    }

    if (field[1] !== 'description') continue;

    const inline = field[2].trim();
    if (inline !== '>' && inline !== '|') {
      description = unquote(inline);
      continue;
    }

    const continuation: string[] = [];
    while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
      continuation.push(lines[++index].trim());
    }
    description = inline === '|'
      ? continuation.join('\n').trim()
      : continuation.join(' ').trim();
  }

  return { name, description };
}

export async function discoverUserSkills(
  skillsDirectory = getUserSkillsDirectory(),
): Promise<DiscoveredSkill[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const skills = await Promise.all(entries.map(async (entry): Promise<DiscoveredSkill | null> => {
    const skillDirectory = path.join(skillsDirectory, entry.name);
    try {
      const directoryStat = entry.isDirectory() ? null : await fs.stat(skillDirectory);
      if (!entry.isDirectory() && !directoryStat?.isDirectory()) return null;

      const skillPath = path.join(skillDirectory, 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf-8');
      const metadata = parseSkillFrontmatter(content);
      return {
        name: metadata.name || entry.name,
        description: metadata.description,
        path: skillPath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }));

  return skills
    .filter((skill): skill is DiscoveredSkill => skill !== null)
    .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}

export function normalizeSkillPolicy(value: unknown): SkillPolicy {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SKILL_POLICY };

  const candidate = value as Partial<SkillPolicy>;
  if (candidate.mode !== 'custom') return { ...DEFAULT_SKILL_POLICY };

  const enabledPaths = Array.isArray(candidate.enabledPaths)
    ? [...new Set(candidate.enabledPaths.filter((entry): entry is string => typeof entry === 'string'))]
    : [];

  return { mode: 'custom', enabledPaths };
}

export function buildCodexSkillConfig(
  skills: DiscoveredSkill[],
  policy: SkillPolicy,
): CodexSkillConfigEntry[] | undefined {
  if (policy.mode === 'inherit') return undefined;

  const enabledPaths = new Set(policy.enabledPaths);
  return skills.map((skill) => ({
    path: skill.path,
    enabled: enabledPaths.has(skill.path),
  }));
}
