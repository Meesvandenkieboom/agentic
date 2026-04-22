/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Thin tab strip at the top of the ArtifactPanel listing all artifacts in the
 * current session. Click to switch focus, X to close a tab.
 */

import React, { memo } from 'react';
import type { Artifact } from './types';
import { ARTIFACT_TYPE_LABEL } from './types';

interface ArtifactTabsProps {
  artifacts: Artifact[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export const ArtifactTabs = memo(function ArtifactTabs({
  artifacts,
  activeId,
  onSelect,
  onClose,
}: ArtifactTabsProps) {
  if (artifacts.length === 0) return null;

  return (
    <div className="flex items-center gap-1 px-3 py-2 overflow-x-auto border-b border-white/5 bg-black/10">
      {artifacts.map(a => {
        const isActive = a.id === activeId;
        const label = a.title || ARTIFACT_TYPE_LABEL[a.artifactType];
        return (
          <div
            key={a.id}
            className={[
              'group inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs shrink-0',
              'border transition-colors cursor-pointer',
              isActive
                ? 'bg-[#A8C7FA]/15 border-[#A8C7FA]/30 text-white'
                : 'border-transparent text-white/60 hover:text-white/90 hover:bg-white/5',
            ].join(' ')}
            onClick={() => onSelect(a.id)}
            role="tab"
            aria-selected={isActive}
          >
            {a.status === 'streaming' && (
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full rounded-full bg-[#A8C7FA] opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full size-1.5 bg-[#A8C7FA]" />
              </span>
            )}
            <span className="truncate max-w-[180px]">{label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(a.id); }}
              className={[
                'flex items-center justify-center size-4 rounded',
                'opacity-60 hover:opacity-100 hover:bg-white/10 transition-opacity',
              ].join(' ')}
              aria-label={`Close ${label}`}
              title="Close tab"
            >
              <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
});
