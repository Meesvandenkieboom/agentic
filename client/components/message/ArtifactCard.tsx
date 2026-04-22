/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Inline "artifact pill" rendered in the chat stream. Clicking it focuses the
 * right-side ArtifactPanel on the matching artifact.
 */

import React, { memo } from 'react';
import type { ArtifactBlock } from './types';
import { ARTIFACT_TYPE_LABEL } from '../artifact/types';
import { useArtifactPanel } from '../../hooks/useArtifactPanel';

interface ArtifactCardProps {
  artifact: ArtifactBlock;
}

/** Pick an icon based on artifact type. */
function ArtifactIcon({ type }: { type: ArtifactBlock['artifactType'] }) {
  switch (type) {
    case 'text/html':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
          <path d="M9 13l-2 2 2 2M13 13l2 2-2 2" />
        </svg>
      );
    case 'image/svg+xml':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      );
    case 'text/markdown':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="16" y2="17" />
        </svg>
      );
    case 'application/vnd.ant.code':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case 'application/vnd.ant.mermaid':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      );
    case 'application/vnd.ant.react':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2" />
          <ellipse cx="12" cy="12" rx="10" ry="4" />
          <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
        </svg>
      );
    case 'application/vnd.ant.chart':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      );
    case 'application/json':
      return (
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 4v4a2 2 0 0 1-2 2" />
          <path d="M6 20v-4a2 2 0 0 0-2-2" />
          <path d="M18 4v4a2 2 0 0 0 2 2" />
          <path d="M18 20v-4a2 2 0 0 1 2-2" />
        </svg>
      );
    default:
      return null;
  }
}

function byteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const ArtifactCard = memo(function ArtifactCard({ artifact }: ArtifactCardProps) {
  const open = useArtifactPanel(s => s.open);
  const setActive = useArtifactPanel(s => s.setActive);

  const handleClick = () => {
    setActive(artifact.artifactId);
    open(artifact.artifactId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  const label = ARTIFACT_TYPE_LABEL[artifact.artifactType] ?? 'Artifact';
  const title = artifact.title || artifact.artifactId;
  const isStreaming = artifact.status === 'streaming';
  const size = byteSize(artifact.content.length);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={[
        'group flex items-center gap-3 my-3 px-4 py-3 rounded-xl',
        'border border-white/10 bg-white/[0.03] hover:bg-white/[0.06]',
        'cursor-pointer transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-[#A8C7FA]/40',
      ].join(' ')}
      aria-label={`Open artifact ${title}`}
    >
      <div className="flex items-center justify-center size-9 rounded-lg bg-[#A8C7FA]/10 text-[#A8C7FA] shrink-0">
        <ArtifactIcon type={artifact.artifactType} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/90 truncate">{title}</span>
          {isStreaming && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[#A8C7FA]/80">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full rounded-full bg-[#A8C7FA] opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full size-1.5 bg-[#A8C7FA]" />
              </span>
              Generating…
            </span>
          )}
        </div>
        <div className="text-xs text-white/50 mt-0.5 truncate">
          {label}
          {artifact.language ? ` · ${artifact.language}` : ''} · Click to open
          {!isStreaming ? ` · ${size}` : ''}
        </div>
      </div>

      <svg
        className="size-4 text-white/40 group-hover:text-white/70 transition-colors shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </div>
  );
});
