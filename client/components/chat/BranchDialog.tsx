/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState } from 'react';
import { GitBranch, X, Loader2 } from 'lucide-react';
import { AVAILABLE_MODELS } from '../../config/models';

interface BranchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: { model?: string; title?: string }) => Promise<void>;
  parentSessionTitle: string;
  messagePreview?: string;
  messageIndex?: number;
  currentModel: string;
}

export function BranchDialog({
  isOpen,
  onClose,
  onConfirm,
  parentSessionTitle,
  messagePreview,
  messageIndex,
  currentModel,
}: BranchDialogProps) {
  const [selectedModel, setSelectedModel] = useState(currentModel);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    setIsCreating(true);
    setError(null);

    try {
      // Title is auto-generated server-side ("Parent Title - Branch N")
      await onConfirm({
        model: selectedModel !== currentModel ? selectedModel : undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create branch');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-md mx-4 bg-[rgb(31,41,55)] border border-[rgba(255,255,255,0.1)] rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[rgba(255,255,255,0.1)]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[rgba(99,102,241,0.2)]">
              <GitBranch size={20} className="text-[rgb(165,180,252)]" />
            </div>
            <h2 className="text-lg font-semibold text-[rgb(243,244,246)]">
              Branch Conversation
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.1)] transition-colors"
            disabled={isCreating}
          >
            <X size={20} className="text-[rgb(156,163,175)]" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5">
          {/* Source context */}
          <div className="px-4 py-3 bg-[rgb(20,22,24)] rounded-lg border border-[rgba(255,255,255,0.05)]">
            <div className="text-xs text-[rgb(156,163,175)] mb-1">
              Branching from:{' '}
              <span className="font-medium text-[rgb(165,180,252)]">
                {parentSessionTitle}
              </span>
              {messageIndex !== undefined && (
                <span className="ml-1 opacity-70">at message #{messageIndex + 1}</span>
              )}
            </div>
            {messagePreview && (
              <div className="text-sm text-[rgb(156,163,175)] line-clamp-2 italic mt-1">
                &ldquo;{messagePreview.slice(0, 100)}{messagePreview.length > 100 ? '...' : ''}&rdquo;
              </div>
            )}
          </div>

          {/* Model selector */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[rgb(243,244,246)]">
              Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full px-4 py-2.5 bg-[rgb(38,40,42)] border border-[rgba(255,255,255,0.1)]
                       rounded-lg text-[rgb(243,244,246)]
                       focus:border-[rgb(165,180,252)] focus:ring-1 focus:ring-[rgb(165,180,252)]
                       focus:outline-none transition-all cursor-pointer"
              disabled={isCreating}
            >
              {AVAILABLE_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} {model.id === currentModel ? '(current)' : ''}
                </option>
              ))}
            </select>
            {selectedModel !== currentModel && (
              <p className="text-xs text-[rgb(165,180,252)]">
                Will switch to this model in the new branch
              </p>
            )}
          </div>

          {/* Error message */}
          {error && (
            <div className="px-4 py-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg">
              <p className="text-sm text-[rgb(252,165,165)]">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-[rgba(255,255,255,0.1)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-[rgb(156,163,175)]
                     hover:text-[rgb(243,244,246)] hover:bg-[rgba(255,255,255,0.1)]
                     rounded-lg transition-all"
            disabled={isCreating}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isCreating}
            className="px-5 py-2 text-sm font-medium text-[rgb(17,24,39)]
                     bg-gradient-to-r from-[rgb(165,180,252)] to-[rgb(196,181,253)]
                     hover:from-[rgb(139,156,246)] hover:to-[rgb(180,165,247)]
                     rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-2"
          >
            {isCreating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <GitBranch size={16} />
                Create Branch
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
