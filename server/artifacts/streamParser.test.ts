/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { ArtifactStreamParser } from './streamParser';
import type { ArtifactStreamEvent } from './types';

function runAll(chunks: string[]): ArtifactStreamEvent[] {
  const parser = new ArtifactStreamParser();
  const out: ArtifactStreamEvent[] = [];
  for (const c of chunks) out.push(...parser.feed(c));
  out.push(...parser.flush());
  return out;
}

describe('ArtifactStreamParser', () => {
  it('emits plain text when no artifact tags are present', () => {
    const events = runAll(['Hello, ', 'world!']);
    // Parser emits text per-chunk (streaming behavior); concatenation must equal input.
    const full = events
      .filter(e => e.kind === 'text')
      .map(e => (e.kind === 'text' ? e.text : ''))
      .join('');
    expect(full).toBe('Hello, world!');
    expect(events.every(e => e.kind === 'text')).toBe(true);
  });

  it('parses a complete artifact in one chunk', () => {
    const input =
      'Here you go: ' +
      '<antArtifact identifier="a1" type="text/html" title="T">' +
      '<p>hi</p>' +
      '</antArtifact>' +
      ' done.';
    const events = runAll([input]);

    expect(events).toEqual([
      { kind: 'text', text: 'Here you go: ' },
      {
        kind: 'artifactStart',
        meta: { id: 'a1', artifactType: 'text/html', title: 'T' },
      },
      { kind: 'artifactDelta', id: 'a1', text: '<p>hi</p>' },
      { kind: 'artifactEnd', id: 'a1' },
      { kind: 'text', text: ' done.' },
    ]);
  });

  it('handles open tag split across chunks', () => {
    const events = runAll([
      '<antArtif',
      'act identifier="x" type="text/markdown">',
      '# hi',
      '</antArtifact>',
    ]);
    expect(events).toEqual([
      {
        kind: 'artifactStart',
        meta: { id: 'x', artifactType: 'text/markdown' },
      },
      { kind: 'artifactDelta', id: 'x', text: '# hi' },
      { kind: 'artifactEnd', id: 'x' },
    ]);
  });

  it('handles close tag split across chunks', () => {
    const events = runAll([
      '<antArtifact identifier="x" type="text/html">',
      'before',
      '</antArti',
      'fact>',
      'after',
    ]);
    expect(events).toEqual([
      {
        kind: 'artifactStart',
        meta: { id: 'x', artifactType: 'text/html' },
      },
      { kind: 'artifactDelta', id: 'x', text: 'before' },
      { kind: 'artifactEnd', id: 'x' },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('handles artifact content split over many chunks', () => {
    const events = runAll([
      '<antArtifact identifier="p" type="text/html">',
      'a', 'b', 'c',
      '</antArtifact>',
    ]);
    // Deltas may be coalesced or split — check via concatenation.
    const start = events.filter(e => e.kind === 'artifactStart');
    const deltas = events.filter(e => e.kind === 'artifactDelta');
    const end = events.filter(e => e.kind === 'artifactEnd');
    expect(start).toHaveLength(1);
    expect(end).toHaveLength(1);
    const full = deltas
      .map(e => (e.kind === 'artifactDelta' ? e.text : ''))
      .join('');
    expect(full).toBe('abc');
  });

  it('falls back to plain text for unknown types', () => {
    const events = runAll([
      '<antArtifact identifier="x" type="unknown/bogus">body</antArtifact>',
    ]);
    // Open tag becomes plain text, close tag cannot be nested so shows as text too.
    const types = events.map(e => e.kind);
    expect(types).not.toContain('artifactStart');
    // Text should include the raw tag
    const allText = events
      .filter(e => e.kind === 'text')
      .map(e => (e.kind === 'text' ? e.text : ''))
      .join('');
    expect(allText).toContain('<antArtifact');
    expect(allText).toContain('unknown/bogus');
  });

  it('accepts "id" as an alias for "identifier"', () => {
    const events = runAll([
      '<antArtifact id="short" type="image/svg+xml"><svg/></antArtifact>',
    ]);
    const start = events.find(e => e.kind === 'artifactStart');
    expect(start).toBeTruthy();
    if (start && start.kind === 'artifactStart') {
      expect(start.meta.id).toBe('short');
      expect(start.meta.artifactType).toBe('image/svg+xml');
    }
  });

  it('captures language attribute for code artifacts', () => {
    const events = runAll([
      '<antArtifact identifier="c" type="application/vnd.ant.code" language="python">print()</antArtifact>',
    ]);
    const start = events.find(e => e.kind === 'artifactStart');
    expect(start).toBeTruthy();
    if (start && start.kind === 'artifactStart') {
      expect(start.meta.language).toBe('python');
    }
  });

  it('flush closes an unterminated artifact', () => {
    const parser = new ArtifactStreamParser();
    const out: ArtifactStreamEvent[] = [];
    out.push(...parser.feed('<antArtifact identifier="u" type="text/html">partial'));
    out.push(...parser.flush());

    const types = out.map(e => e.kind);
    expect(types).toContain('artifactStart');
    expect(types).toContain('artifactEnd');
    const deltaText = out
      .filter(e => e.kind === 'artifactDelta')
      .map(e => (e.kind === 'artifactDelta' ? e.text : ''))
      .join('');
    expect(deltaText).toBe('partial');
  });

  it('handles multiple artifacts in one stream', () => {
    const events = runAll([
      '<antArtifact identifier="a" type="text/html">A</antArtifact>',
      'mid',
      '<antArtifact identifier="b" type="text/markdown">B</antArtifact>',
    ]);
    const starts = events.filter(e => e.kind === 'artifactStart');
    expect(starts).toHaveLength(2);
    const ends = events.filter(e => e.kind === 'artifactEnd');
    expect(ends).toHaveLength(2);
    const midText = events.find(
      e => e.kind === 'text' && (e as { text: string }).text === 'mid',
    );
    expect(midText).toBeTruthy();
  });

  it('does not emit text prefix that could be a split open tag', () => {
    // After feeding "hello <antArt", parser must NOT emit "<antArt" as text
    // (it could still be an artifact opening).
    const parser = new ArtifactStreamParser();
    const events = parser.feed('hello <antArt');
    const textEmitted = events
      .filter(e => e.kind === 'text')
      .map(e => (e.kind === 'text' ? e.text : ''))
      .join('');
    expect(textEmitted).toBe('hello ');
    // Complete the tag and see full parse.
    const rest = parser.feed(
      'ifact identifier="x" type="text/html">body</antArtifact>',
    );
    const starts = rest.filter(e => e.kind === 'artifactStart');
    expect(starts).toHaveLength(1);
  });

  it('does not emit artifact content tail that could be a split close tag', () => {
    const parser = new ArtifactStreamParser();
    parser.feed('<antArtifact identifier="x" type="text/html">');
    const events = parser.feed('body</antArti');
    const deltaText = events
      .filter(e => e.kind === 'artifactDelta')
      .map(e => (e.kind === 'artifactDelta' ? e.text : ''))
      .join('');
    expect(deltaText).toBe('body');
    // Finish the close tag.
    const final = parser.feed('fact>');
    expect(final.some(e => e.kind === 'artifactEnd')).toBe(true);
  });

  it('parses single-quoted attribute values', () => {
    const events = runAll([
      "<antArtifact identifier='q' type='text/html'>x</antArtifact>",
    ]);
    const start = events.find(e => e.kind === 'artifactStart');
    expect(start).toBeTruthy();
  });

  it('treats tag missing identifier as plain text', () => {
    const events = runAll([
      '<antArtifact type="text/html">x</antArtifact>',
    ]);
    expect(events.some(e => e.kind === 'artifactStart')).toBe(false);
  });
});
