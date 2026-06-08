/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Right-side artifact panel: header with title + actions, tabs, and renderer.
 * Width is controlled by the caller (ChatContainer) so it can render the
 * resizable divider between this panel and the chat column.
 */

import React, { memo, useCallback, useEffect, useMemo } from 'react';
import { Copy, Download, Maximize2, Minimize2, X } from 'lucide-react';
import { useArtifactPanel } from '../../hooks/useArtifactPanel';
import { ArtifactTabs } from './ArtifactTabs';
import { ArtifactRenderer } from './ArtifactRenderer';
import { ARTIFACT_TYPE_LABEL, fileExtensionFor, type Artifact } from './types';
import { toast } from '../../utils/toast';

interface ArtifactPanelProps {
  /** Session scope for tabs. Null means no artifact is selected. */
  sessionId: string | null;
}

export const ArtifactPanel = memo(function ArtifactPanel({ sessionId }: ArtifactPanelProps) {
  const isOpen = useArtifactPanel(s => s.isOpen);
  const isMaximized = useArtifactPanel(s => s.isMaximized);
  const activeId = useArtifactPanel(s => s.activeId);
  const artifactsMap = useArtifactPanel(s => s.artifacts);
  const setActive = useArtifactPanel(s => s.setActive);
  const close = useArtifactPanel(s => s.close);
  const setMaximized = useArtifactPanel(s => s.setMaximized);
  const remove = useArtifactPanel(s => s.remove);
  const listForSession = useArtifactPanel(s => s.listForSession);

  const artifacts = useMemo(
    () => listForSession(sessionId),
    // Re-compute when the artifact map changes or when sessionId changes.
    // `listForSession` is a stable selector since zustand create returns
    // identity-stable references.
    [artifactsMap, sessionId, listForSession],
  );

  // Derive the active artifact (fall back to last if activeId missing).
  const active: Artifact | null = useMemo(() => {
    if (activeId) {
      const hit = artifacts.find(a => a.id === activeId);
      if (hit) return hit;
    }
    return artifacts[artifacts.length - 1] ?? null;
  }, [artifacts, activeId]);

  const handleCopy = useCallback(async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.content);
      toast.success('Copied', { description: 'Artifact copied to clipboard', duration: 2000 });
    } catch {
      toast.error('Copy failed', { description: 'Clipboard access denied', duration: 3000 });
    }
  }, [active]);

  const handleDownload = useCallback(() => {
    if (!active) return;
    const ext = fileExtensionFor(active.artifactType, active.language);
    const blob = new Blob([active.content], { type: guessMime(active.artifactType) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(active.title || active.id)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [active]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the panel.
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      // Cmd/Ctrl + [ / ] switches tabs.
      if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) {
        if (artifacts.length === 0) return;
        e.preventDefault();
        const idx = Math.max(0, artifacts.findIndex(a => a.id === (active?.id ?? '')));
        const next = e.key === ']'
          ? (idx + 1) % artifacts.length
          : (idx - 1 + artifacts.length) % artifacts.length;
        const target = artifacts[next];
        if (target) setActive(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, artifacts, active, close, setActive]);

  useEffect(() => {
    if (isOpen && artifacts.length === 0) close();
  }, [artifacts.length, close, isOpen]);

  if (!isOpen || artifacts.length === 0) return null;

  return (
    <div
      className={[
        'flex flex-col h-full bg-[#0F1112] border-l border-white/5',
        isMaximized ? 'w-full' : 'w-full',
      ].join(' ')}
      role="complementary"
      aria-label="Artifact panel"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-white truncate">
            {active?.title || (active ? ARTIFACT_TYPE_LABEL[active.artifactType] : 'Artifacts')}
          </div>
          {active && (
            <div className="text-[11px] text-white/50 truncate">
              {ARTIFACT_TYPE_LABEL[active.artifactType]}
              {active.language ? ` · ${active.language}` : ''}
              {active.status === 'streaming' ? ' · generating…' : ''}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <IconButton onClick={handleCopy} title="Copy content" disabled={!active}>
            <Copy className="size-4" />
          </IconButton>
          <IconButton onClick={handleDownload} title="Download" disabled={!active}>
            <Download className="size-4" />
          </IconButton>
          <IconButton
            onClick={() => setMaximized(!isMaximized)}
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
          </IconButton>
          <IconButton onClick={close} title="Close panel (Esc)">
            <X className="size-4" />
          </IconButton>
        </div>
      </div>

      {/* Tabs */}
      <ArtifactTabs
        artifacts={artifacts}
        activeId={active?.id ?? null}
        onSelect={setActive}
        onClose={(id) => remove(id)}
      />

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {active ? (
          <ArtifactRenderer artifact={active} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/40 text-sm">
            No artifact selected.
          </div>
        )}
      </div>
    </div>
  );
});

interface IconButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}

function IconButton({ onClick, title, disabled, children }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={[
        'flex items-center justify-center size-8 rounded-md',
        'text-white/60 hover:text-white hover:bg-white/5',
        'disabled:opacity-30 disabled:pointer-events-none',
        'transition-colors',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function guessMime(t: Artifact['artifactType']): string {
  switch (t) {
    case 'text/html': return 'text/html';
    case 'image/svg+xml': return 'image/svg+xml';
    case 'text/markdown': return 'text/markdown';
    case 'application/json':
    case 'application/vnd.ant.chart': return 'application/json';
    case 'application/vnd.ant.react': return 'text/jsx';
    default: return 'text/plain';
  }
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'artifact';
}
