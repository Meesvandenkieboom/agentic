/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandSlashCommand, BUILT_IN_COMMANDS } from './slashCommandExpander';

let tmpDir: string;
let commandsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-cmd-'));
  commandsDir = path.join(tmpDir, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BUILT_IN_COMMANDS', () => {
  it('contains the SDK-handled commands', () => {
    expect(BUILT_IN_COMMANDS.has('clear')).toBe(true);
    expect(BUILT_IN_COMMANDS.has('compact')).toBe(true);
  });
});

describe('expandSlashCommand', () => {
  it('returns null for a non-slash message', () => {
    expect(expandSlashCommand('hello world', tmpDir)).toBeNull();
  });

  it('passes through built-in commands unchanged', () => {
    expect(expandSlashCommand('/clear', tmpDir)).toBe('/clear');
    expect(expandSlashCommand('/compact', tmpDir)).toBe('/compact');
  });

  it('returns null when the command file does not exist', () => {
    expect(expandSlashCommand('/missing', tmpDir)).toBeNull();
  });

  it('expands a custom command body', () => {
    fs.writeFileSync(path.join(commandsDir, 'greet.md'), 'Say hello to the user.');
    expect(expandSlashCommand('/greet', tmpDir)).toBe('Say hello to the user.');
  });

  it('substitutes $ARGUMENTS with the supplied arguments', () => {
    fs.writeFileSync(path.join(commandsDir, 'echo.md'), 'Repeat this: $ARGUMENTS');
    expect(expandSlashCommand('/echo hello there', tmpDir)).toBe('Repeat this: hello there');
  });

  it('replaces multiple $ARGUMENTS occurrences', () => {
    fs.writeFileSync(path.join(commandsDir, 'dup.md'), '$ARGUMENTS and again $ARGUMENTS');
    expect(expandSlashCommand('/dup x', tmpDir)).toBe('x and again x');
  });

  it('substitutes empty string when no arguments are given', () => {
    fs.writeFileSync(path.join(commandsDir, 'noargs.md'), 'value=[$ARGUMENTS]');
    expect(expandSlashCommand('/noargs', tmpDir)).toBe('value=[]');
  });

  it('strips frontmatter and keeps only the body', () => {
    const content = ['---', 'description: A test command', 'argument-hint: <name>', '---', 'Body content here'].join('\n');
    fs.writeFileSync(path.join(commandsDir, 'fm.md'), content);
    expect(expandSlashCommand('/fm', tmpDir)).toBe('Body content here');
  });

  it('returns null for commands with invalid (non-kebab) names', () => {
    // Uppercase / numbers are not matched by the command regex.
    expect(expandSlashCommand('/Greet', tmpDir)).toBeNull();
    expect(expandSlashCommand('/cmd123', tmpDir)).toBeNull();
  });
});
