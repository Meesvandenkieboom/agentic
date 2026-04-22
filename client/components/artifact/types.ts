/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Client-side mirror of server/artifacts/types.ts. Kept separate so the client
 * bundle doesn't import from `server/` (which could drag Bun-only code in).
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

export interface ArtifactMeta {
  id: string;
  artifactType: ArtifactType;
  title?: string;
  language?: string;
}

export interface Artifact extends ArtifactMeta {
  content: string;
  status: 'streaming' | 'complete';
  /** Session that produced this artifact (for scoping tabs to a chat) */
  sessionId?: string | null;
  /** Timestamp (ms) of first emission */
  createdAt: number;
  /** Timestamp (ms) of last content update */
  updatedAt: number;
}

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Human-friendly labels for each artifact type. */
export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  'text/html': 'HTML',
  'image/svg+xml': 'SVG',
  'text/markdown': 'Markdown',
  'application/vnd.ant.code': 'Code',
  'application/vnd.ant.mermaid': 'Mermaid',
  'application/vnd.ant.react': 'React',
  'application/vnd.ant.chart': 'Chart',
  'application/json': 'JSON',
};

/** File extension hint used for "download" actions. */
export function fileExtensionFor(artifactType: ArtifactType, language?: string): string {
  switch (artifactType) {
    case 'text/html': return 'html';
    case 'image/svg+xml': return 'svg';
    case 'text/markdown': return 'md';
    case 'application/vnd.ant.mermaid': return 'mmd';
    case 'application/vnd.ant.react': return 'jsx';
    case 'application/vnd.ant.chart': return 'json';
    case 'application/json': return 'json';
    case 'application/vnd.ant.code': {
      const map: Record<string, string> = {
        javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
        python: 'py', ruby: 'rb', go: 'go', rust: 'rs',
        java: 'java', kotlin: 'kt', swift: 'swift',
        c: 'c', cpp: 'cpp', csharp: 'cs',
        shell: 'sh', bash: 'sh', zsh: 'sh',
        sql: 'sql', yaml: 'yml', toml: 'toml', json: 'json',
        html: 'html', css: 'css', scss: 'scss',
        markdown: 'md', md: 'md',
      };
      return (language && map[language.toLowerCase()]) || 'txt';
    }
    default:
      return 'txt';
  }
}
