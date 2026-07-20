import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCodexSkillConfig,
  discoverUserSkills,
  normalizeSkillPolicy,
  parseSkillFrontmatter,
} from './skills';

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-skills-'));
});

afterEach(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('parseSkillFrontmatter', () => {
  it('parses folded descriptions', () => {
    expect(parseSkillFrontmatter(`---\nname: firecrawl\ndescription: >\n  Search and scrape the web.\n  Use for current sources.\n---\n`)).toEqual({
      name: 'firecrawl',
      description: 'Search and scrape the web. Use for current sources.',
    });
  });
});

describe('discoverUserSkills', () => {
  it('discovers direct skill folders and ignores unrelated directories', async () => {
    const skillDirectory = path.join(tempDirectory, 'demo');
    fs.mkdirSync(skillDirectory);
    fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\n');
    fs.mkdirSync(path.join(tempDirectory, 'not-a-skill'));

    const skills = await discoverUserSkills(tempDirectory);

    expect(skills).toEqual([{
      name: 'demo',
      description: 'Demo skill',
      path: path.join(skillDirectory, 'SKILL.md'),
    }]);
  });
});

describe('skill policy', () => {
  const skills = [
    { name: 'alpha', description: '', path: '/skills/alpha/SKILL.md' },
    { name: 'beta', description: '', path: '/skills/beta/SKILL.md' },
  ];

  it('does not override native Codex discovery in inherit mode', () => {
    expect(buildCodexSkillConfig(skills, normalizeSkillPolicy(undefined))).toBeUndefined();
  });

  it('turns a custom selection into explicit enable and disable entries', () => {
    expect(buildCodexSkillConfig(skills, {
      mode: 'custom',
      enabledPaths: ['/skills/beta/SKILL.md'],
    })).toEqual([
      { path: '/skills/alpha/SKILL.md', enabled: false },
      { path: '/skills/beta/SKILL.md', enabled: true },
    ]);
  });

  it('preserves an explicit empty custom selection', () => {
    expect(normalizeSkillPolicy({ mode: 'custom', enabledPaths: [] })).toEqual({
      mode: 'custom',
      enabledPaths: [],
    });
  });
});
