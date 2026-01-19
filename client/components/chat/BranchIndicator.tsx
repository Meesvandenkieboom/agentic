/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React from 'react';
import { GitBranch, ArrowLeft } from 'lucide-react';

interface BranchIndicatorProps {
  parentSessionTitle: string;
  parentSessionId: string;
  onNavigateToParent: () => void;
  compact?: boolean;
}

export function BranchIndicator({
  parentSessionTitle,
  onNavigateToParent,
  compact = false,
}: BranchIndicatorProps) {
  if (compact) {
    return (
      <button
        onClick={onNavigateToParent}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
                   bg-[rgba(99,102,241,0.15)] border border-[rgba(99,102,241,0.3)]
                   hover:bg-[rgba(99,102,241,0.25)] transition-all
                   text-[rgb(165,180,252)] text-xs font-medium"
        title={`Branch of: ${parentSessionTitle}`}
      >
        <GitBranch size={12} />
        <span className="max-w-[100px] truncate">{parentSessionTitle}</span>
        <ArrowLeft size={10} className="opacity-60" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg
                    bg-[rgba(99,102,241,0.1)] border border-[rgba(99,102,241,0.2)]">
      <GitBranch size={14} className="text-[rgb(165,180,252)]" />
      <div className="flex flex-col">
        <span className="text-xs text-[rgb(156,163,175)]">Branch of</span>
        <button
          onClick={onNavigateToParent}
          className="text-sm font-medium text-[rgb(165,180,252)] hover:underline text-left"
        >
          {parentSessionTitle}
        </button>
      </div>
    </div>
  );
}
