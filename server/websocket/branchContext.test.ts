/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { formatBranchHistory } from './branchContext';

type Msg = { type: string; content: string; timestamp: string };

const msg = (type: string, content: string): Msg => ({
  type,
  content,
  timestamp: new Date().toISOString(),
});

describe('formatBranchHistory', () => {
  it('wraps output in conversation history markers', () => {
    const out = formatBranchHistory([msg('user', 'Hello')]);
    expect(out).toContain('=== CONVERSATION HISTORY (branched from parent chat) ===');
    expect(out).toContain('=== END OF CONVERSATION HISTORY ===');
    expect(out).toContain('Your new message from the user follows:');
  });

  it('labels user messages as Human and renders their content', () => {
    const out = formatBranchHistory([msg('user', 'What is 2+2?')]);
    expect(out).toContain('Human:');
    expect(out).toContain('What is 2+2?');
  });

  it('preserves chronological order across multiple messages', () => {
    const out = formatBranchHistory([
      msg('user', 'first-question'),
      msg('assistant', 'first-answer'),
      msg('user', 'second-question'),
    ]);
    expect(out.indexOf('first-question')).toBeLessThan(out.indexOf('first-answer'));
    expect(out.indexOf('first-answer')).toBeLessThan(out.indexOf('second-question'));
  });

  it('extracts text from assistant JSON content blocks', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Here is the answer.' },
      { type: 'text', text: 'A second paragraph.' },
    ]);
    const out = formatBranchHistory([msg('assistant', content)]);
    expect(out).toContain('Assistant:');
    expect(out).toContain('Here is the answer.');
    expect(out).toContain('A second paragraph.');
    // The raw JSON should not leak into the formatted output.
    expect(out).not.toContain('"type":"text"');
  });

  it('summarises tool_use blocks from assistant content', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Let me search.' },
      { type: 'tool_use', name: 'WebSearch', input: {} },
      { type: 'tool_use', name: 'Read', input: {} },
    ]);
    const out = formatBranchHistory([msg('assistant', content)]);
    expect(out).toContain('[Used 2 tool(s): WebSearch, Read]');
    expect(out).toContain('[Tool call: WebSearch; input: {}]');
  });

  it('carries stored tool results without carrying thinking blocks', () => {
    const content = JSON.stringify([
      { type: 'thinking', thinking: 'private-reasoning-marker' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'command output' },
    ]);
    const out = formatBranchHistory([msg('assistant', content)]);
    expect(out).toContain('[Tool result: command output]');
    expect(out).not.toContain('private-reasoning-marker');
  });

  it('describes structured user attachments without embedding their base64', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Review these.' },
      { type: 'document', name: 'report.pdf', data: 'base64-secret' },
      { type: 'image', source: { data: 'image-secret' } },
    ]);
    const out = formatBranchHistory([msg('user', content)]);
    expect(out).toContain('Review these.');
    expect(out).toContain('[Attached file: report.pdf]');
    expect(out).toContain('[Image attached in the original message]');
    expect(out).not.toContain('base64-secret');
    expect(out).not.toContain('image-secret');
  });

  it('keeps plain (non-JSON) assistant text as-is', () => {
    const out = formatBranchHistory([msg('assistant', 'just plain text')]);
    expect(out).toContain('just plain text');
  });

  it('truncates very long individual messages', () => {
    const longText = 'x'.repeat(5000);
    const out = formatBranchHistory([msg('user', longText)]);
    expect(out).toContain('[message truncated]');
    // Should not contain the full 5000-char run.
    expect(out).not.toContain('x'.repeat(4000));
  });

  it('omits older messages when the total budget is exceeded', () => {
    // Each message ~4000 chars; 30 of them blow past the 100k budget.
    const many: Msg[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(msg('user', `MSG${i}-` + 'y'.repeat(3500)));
    }
    const out = formatBranchHistory(many);
    expect(out).toContain('[... earlier messages omitted for brevity ...]');
    // The most recent message must survive.
    expect(out).toContain('MSG39-');
    expect(out.indexOf('[... earlier messages omitted')).toBeLessThan(out.indexOf('MSG39-'));
  });

  it('handles an empty history', () => {
    const out = formatBranchHistory([]);
    expect(out).toContain('=== CONVERSATION HISTORY (branched from parent chat) ===');
    expect(out).toContain('=== END OF CONVERSATION HISTORY ===');
  });
});
