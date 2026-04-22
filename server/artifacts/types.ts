/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Supported artifact MIME-style types. Mirrors Claude.ai conventions with a
 * few Agentic-specific additions (chart).
 */
export type ArtifactType =
  | 'text/html'
  | 'image/svg+xml'
  | 'text/markdown'
  | 'application/vnd.ant.code'
  | 'application/vnd.ant.mermaid'
  | 'application/vnd.ant.react'
  | 'application/vnd.ant.chart'
  | 'application/json';

/** All artifact types as a tuple (for runtime validation) */
export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  'text/html',
  'image/svg+xml',
  'text/markdown',
  'application/vnd.ant.code',
  'application/vnd.ant.mermaid',
  'application/vnd.ant.react',
  'application/vnd.ant.chart',
  'application/json',
] as const;

/** Metadata for a single artifact (no content body) */
export interface ArtifactMeta {
  /** Stable identifier chosen by the assistant (or auto-assigned) */
  id: string;
  /** Artifact MIME type */
  artifactType: ArtifactType;
  /** Optional human title */
  title?: string;
  /** Optional language hint for code artifacts */
  language?: string;
}

/** A fully materialised artifact with content */
export interface Artifact extends ArtifactMeta {
  /** Raw content (html, svg, markdown, JSON string, JSX source, etc.) */
  content: string;
  /** Streaming lifecycle status */
  status: 'streaming' | 'complete';
}

/** Wire events emitted from the server's stream parser */
export type ArtifactStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'artifactStart'; meta: ArtifactMeta }
  | { kind: 'artifactDelta'; id: string; text: string }
  | { kind: 'artifactEnd'; id: string };

/** Check if a string is a valid ArtifactType */
export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}
