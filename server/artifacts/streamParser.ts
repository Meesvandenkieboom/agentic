/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ArtifactStreamParser
 * --------------------
 * Stateful parser that consumes text chunks (as they arrive from the Claude
 * stream) and emits a sequence of events:
 *
 *   - { kind: 'text',         text }              // plain text outside any artifact
 *   - { kind: 'artifactStart', meta }              // <antArtifact ...> opened
 *   - { kind: 'artifactDelta', id, text }          // body chunk within an artifact
 *   - { kind: 'artifactEnd',   id }                // </antArtifact> seen
 *
 * The tag format matches Claude.ai:
 *   <antArtifact identifier="foo" type="text/html" title="Demo" language="py">
 *     ...content...
 *   </antArtifact>
 *
 * Both `identifier` and `id` are accepted for the id attribute to be forgiving
 * of the model. Unknown/invalid `type` values cause the whole tag to be treated
 * as plain text (fallback).
 */

import {
  type ArtifactMeta,
  type ArtifactStreamEvent,
  type ArtifactType,
  isArtifactType,
} from './types';

const OPEN_TAG = '<antArtifact';
const CLOSE_TAG = '</antArtifact>';

type State =
  | { kind: 'outside' }
  | { kind: 'insideArtifact'; id: string };

export class ArtifactStreamParser {
  private buffer = '';
  private state: State = { kind: 'outside' };

  /**
   * Feed a chunk of streamed text. Returns the list of events produced by
   * this chunk (possibly empty).
   */
  feed(chunk: string): ArtifactStreamEvent[] {
    this.buffer += chunk;
    const events: ArtifactStreamEvent[] = [];

    // Drain the buffer greedily.
    // We loop because one chunk can contain multiple transitions
    // (e.g., a full artifact + trailing text).
    for (;;) {
      if (this.state.kind === 'outside') {
        const drained = this.drainOutside();
        if (drained.events.length > 0) events.push(...drained.events);
        if (!drained.transitioned) break;
      } else {
        const drained = this.drainInside();
        if (drained.events.length > 0) events.push(...drained.events);
        if (!drained.transitioned) break;
      }
    }

    return events;
  }

  /**
   * Signal end of stream. Emits any buffered plain text.
   * If an artifact is still open, emits a final artifactEnd.
   */
  flush(): ArtifactStreamEvent[] {
    const events: ArtifactStreamEvent[] = [];

    if (this.state.kind === 'outside') {
      if (this.buffer.length > 0) {
        events.push({ kind: 'text', text: this.buffer });
        this.buffer = '';
      }
    } else {
      // Still inside an unclosed artifact — emit remaining content then close.
      if (this.buffer.length > 0) {
        events.push({
          kind: 'artifactDelta',
          id: this.state.id,
          text: this.buffer,
        });
        this.buffer = '';
      }
      events.push({ kind: 'artifactEnd', id: this.state.id });
      this.state = { kind: 'outside' };
    }

    return events;
  }

  /** Handle buffer when we're outside any artifact. */
  private drainOutside(): { events: ArtifactStreamEvent[]; transitioned: boolean } {
    const events: ArtifactStreamEvent[] = [];
    const openIdx = this.buffer.indexOf(OPEN_TAG);

    if (openIdx === -1) {
      // No open tag visible. Emit all text except the tail that could be the
      // START of "<antArtifact" (partial match across chunks).
      const safe = this.safeOutsideCut();
      if (safe > 0) {
        events.push({ kind: 'text', text: this.buffer.slice(0, safe) });
        this.buffer = this.buffer.slice(safe);
      }
      return { events, transitioned: false };
    }

    // Emit any plain text before the open tag.
    if (openIdx > 0) {
      events.push({ kind: 'text', text: this.buffer.slice(0, openIdx) });
      this.buffer = this.buffer.slice(openIdx);
    }

    // Look for the closing '>' of the open tag.
    const tagEnd = this.buffer.indexOf('>');
    if (tagEnd === -1) {
      // Full open tag hasn't arrived yet.
      return { events, transitioned: false };
    }

    const rawTag = this.buffer.slice(0, tagEnd + 1); // e.g. '<antArtifact id="x" type="...">'
    const meta = parseOpenTag(rawTag);
    this.buffer = this.buffer.slice(tagEnd + 1);

    if (!meta) {
      // Malformed / unknown type — re-emit as plain text and carry on.
      events.push({ kind: 'text', text: rawTag });
      return { events, transitioned: true };
    }

    events.push({ kind: 'artifactStart', meta });
    this.state = { kind: 'insideArtifact', id: meta.id };
    return { events, transitioned: true };
  }

  /** Handle buffer when we're inside an open artifact. */
  private drainInside(): { events: ArtifactStreamEvent[]; transitioned: boolean } {
    if (this.state.kind !== 'insideArtifact') {
      return { events: [], transitioned: false };
    }

    const events: ArtifactStreamEvent[] = [];
    const closeIdx = this.buffer.indexOf(CLOSE_TAG);

    if (closeIdx === -1) {
      // Emit everything except the possible prefix of '</antArtifact>' at the
      // end of the buffer.
      const safe = this.safeInsideCut();
      if (safe > 0) {
        events.push({
          kind: 'artifactDelta',
          id: this.state.id,
          text: this.buffer.slice(0, safe),
        });
        this.buffer = this.buffer.slice(safe);
      }
      return { events, transitioned: false };
    }

    // Emit content before the closing tag.
    if (closeIdx > 0) {
      events.push({
        kind: 'artifactDelta',
        id: this.state.id,
        text: this.buffer.slice(0, closeIdx),
      });
    }
    events.push({ kind: 'artifactEnd', id: this.state.id });
    this.buffer = this.buffer.slice(closeIdx + CLOSE_TAG.length);
    this.state = { kind: 'outside' };
    return { events, transitioned: true };
  }

  /**
   * Returns how many chars from the start of the buffer are safe to flush as
   * plain text (no risk of being part of a split "<antArtifact" prefix).
   */
  private safeOutsideCut(): number {
    const buf = this.buffer;
    // Longest suffix of buf that is a prefix of OPEN_TAG.
    const maxCheck = Math.min(buf.length, OPEN_TAG.length - 1);
    for (let n = maxCheck; n > 0; n--) {
      if (OPEN_TAG.startsWith(buf.slice(buf.length - n))) {
        return buf.length - n;
      }
    }
    return buf.length;
  }

  /**
   * Returns how many chars from the start of the buffer are safe to flush as
   * artifact content (no risk of being part of a split "</antArtifact>" prefix).
   */
  private safeInsideCut(): number {
    const buf = this.buffer;
    const maxCheck = Math.min(buf.length, CLOSE_TAG.length - 1);
    for (let n = maxCheck; n > 0; n--) {
      if (CLOSE_TAG.startsWith(buf.slice(buf.length - n))) {
        return buf.length - n;
      }
    }
    return buf.length;
  }
}

/**
 * Parse `<antArtifact identifier="x" type="text/html" title="t" language="py">`
 * into ArtifactMeta. Returns null if required fields are missing or invalid.
 */
function parseOpenTag(rawTag: string): ArtifactMeta | null {
  // Strip leading '<antArtifact' and trailing '>'; what remains is attrs.
  const inner = rawTag.slice(OPEN_TAG.length, rawTag.length - 1).trim();

  const attrs: Record<string, string> = {};
  // Match name="value" or name='value'
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    if (m[1] !== undefined) attrs[m[1]] = m[2];
    else if (m[3] !== undefined) attrs[m[3]] = m[4];
  }

  const id = attrs.identifier ?? attrs.id;
  const typeRaw = attrs.type;
  if (!id || !typeRaw) return null;
  if (!isArtifactType(typeRaw)) return null;

  const meta: ArtifactMeta = {
    id,
    artifactType: typeRaw as ArtifactType,
  };
  if (attrs.title) meta.title = attrs.title;
  if (attrs.language) meta.language = attrs.language;

  return meta;
}
