/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Zustand store driving the right-side artifact panel:
 *   - artifacts map keyed by id
 *   - activeId (current tab)
 *   - isOpen / isMaximized / width (persisted to localStorage)
 *
 * Streaming flow:
 *   upsertMeta(meta)  →  appendDelta(id, text)  →  finalize(id)
 */

import { create } from 'zustand';
import type { Artifact, ArtifactMeta } from '../components/artifact/types';

const WIDTH_KEY = 'agentic-artifact-panel-width';
const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.85; // up to 85% of window

function loadWidth(): number {
  if (typeof window === 'undefined') return 560;
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (!raw) return 560;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 560;
    return Math.max(MIN_WIDTH, Math.min(n, window.innerWidth * MAX_WIDTH_RATIO));
  } catch {
    return 560;
  }
}

function saveWidth(width: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(width))); } catch { /* ignore */ }
}

interface ArtifactPanelState {
  /** All artifacts ever seen (across sessions), keyed by artifactId. */
  artifacts: Map<string, Artifact>;
  /** Currently focused artifact (tab) */
  activeId: string | null;
  /** Whether the right-side panel is visible */
  isOpen: boolean;
  /** If true, panel takes full width */
  isMaximized: boolean;
  /** Current panel width in px (user-resizable) */
  width: number;

  // Actions
  upsertMeta: (meta: ArtifactMeta, sessionId?: string | null) => void;
  appendDelta: (id: string, text: string) => void;
  finalize: (id: string) => void;
  setContent: (id: string, content: string) => void;
  hydrateArtifact: (artifact: Artifact) => void;
  remove: (id: string) => void;
  clearAll: () => void;

  open: (id?: string | null) => void;
  close: () => void;
  toggle: () => void;
  setActive: (id: string | null) => void;
  setMaximized: (v: boolean) => void;
  setWidth: (width: number) => void;

  /** Return ordered list of artifacts for a given session (or all) */
  listForSession: (sessionId: string | null) => Artifact[];
}

export const useArtifactPanel = create<ArtifactPanelState>((set, get) => ({
  artifacts: new Map(),
  activeId: null,
  isOpen: false,
  isMaximized: false,
  width: loadWidth(),

  upsertMeta: (meta, sessionId) => set(state => {
    const next = new Map(state.artifacts);
    const existing = next.get(meta.id);
    const now = Date.now();
    // A fresh `<antArtifact>` opening tag always starts a new stream cycle —
    // the content between opener and closer fully replaces whatever was there
    // before. Never preserve old content here or updates to the same id
    // (identical identifier) will concatenate, producing Frankenstein renders.
    const merged: Artifact = existing
      ? {
          ...existing,
          ...meta,
          content: '',
          status: 'streaming',
          updatedAt: now,
          sessionId: sessionId ?? existing.sessionId ?? null,
          // Keep the original createdAt so ordering in listForSession stays stable.
        }
      : {
          ...meta,
          content: '',
          status: 'streaming',
          sessionId: sessionId ?? null,
          createdAt: now,
          updatedAt: now,
        };
    next.set(meta.id, merged);
    return {
      artifacts: next,
      // auto-open & focus (re-)streamed artifact
      activeId: meta.id,
      isOpen: true,
    };
  }),

  appendDelta: (id, text) => set(state => {
    const existing = state.artifacts.get(id);
    if (!existing) return {};
    const next = new Map(state.artifacts);
    next.set(id, {
      ...existing,
      content: existing.content + text,
      status: 'streaming',
      updatedAt: Date.now(),
    });
    return { artifacts: next };
  }),

  finalize: (id) => set(state => {
    const existing = state.artifacts.get(id);
    if (!existing) return {};
    const next = new Map(state.artifacts);
    next.set(id, { ...existing, status: 'complete', updatedAt: Date.now() });
    return { artifacts: next };
  }),

  setContent: (id, content) => set(state => {
    const existing = state.artifacts.get(id);
    if (!existing) return {};
    const next = new Map(state.artifacts);
    next.set(id, { ...existing, content, updatedAt: Date.now() });
    return { artifacts: next };
  }),

  hydrateArtifact: (artifact) => set(state => {
    const next = new Map(state.artifacts);
    // Only hydrate if not already present (streaming state wins)
    if (!next.has(artifact.id)) next.set(artifact.id, artifact);
    return { artifacts: next };
  }),

  remove: (id) => set(state => {
    const next = new Map(state.artifacts);
    next.delete(id);
    const activeId = state.activeId === id ? null : state.activeId;
    return { artifacts: next, activeId };
  }),

  clearAll: () => set({ artifacts: new Map(), activeId: null, isOpen: false, isMaximized: false }),

  open: (id) => set(state => ({
    isOpen: true,
    activeId: id !== undefined ? id : (state.activeId ?? null),
  })),
  close: () => set({ isOpen: false, isMaximized: false }),
  toggle: () => set(state => ({ isOpen: !state.isOpen })),
  setActive: (id) => set({ activeId: id }),
  setMaximized: (v) => set({ isMaximized: v }),
  setWidth: (width) => {
    const clamped = Math.max(
      MIN_WIDTH,
      Math.min(width, typeof window !== 'undefined' ? window.innerWidth * MAX_WIDTH_RATIO : 1200),
    );
    saveWidth(clamped);
    set({ width: clamped });
  },

  listForSession: (sessionId) => {
    const all = Array.from(get().artifacts.values());
    const filtered = sessionId
      ? all.filter(a => a.sessionId === sessionId || a.sessionId == null)
      : all;
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  },
}));
