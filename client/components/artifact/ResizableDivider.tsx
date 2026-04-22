/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Draggable vertical separator used between the chat column and the
 * ArtifactPanel. Reports live width via onResize; persistence lives in the
 * useArtifactPanel store.
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

interface ResizableDividerProps {
  /** Current panel width (px) */
  width: number;
  /** Called on drag; new width in px */
  onResize: (width: number) => void;
  /** Minimum panel width (px) */
  minWidth?: number;
  /** Maximum panel width, as a ratio of window.innerWidth */
  maxRatio?: number;
  /** Optional className for the outer handle */
  className?: string;
}

export const ResizableDivider = memo(function ResizableDivider({
  width,
  onResize,
  minWidth = 320,
  maxRatio = 0.85,
  className,
}: ResizableDividerProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragStateRef.current) return;
    const { startX, startWidth } = dragStateRef.current;
    const delta = startX - e.clientX; // dragging left -> wider panel on the right
    const proposed = startWidth + delta;
    const max = window.innerWidth * maxRatio;
    const clamped = Math.max(minWidth, Math.min(proposed, max));
    onResize(clamped);
  }, [onResize, minWidth, maxRatio]);

  const onPointerUp = useCallback(() => {
    dragStateRef.current = null;
    setIsDragging(false);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [onPointerMove]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: width };
    setIsDragging(true);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize artifact panel"
      onPointerDown={onPointerDown}
      className={[
        'relative w-1 shrink-0 cursor-col-resize group',
        'transition-colors',
        isDragging ? 'bg-[#A8C7FA]/40' : 'bg-transparent hover:bg-[#A8C7FA]/20',
        className,
      ].filter(Boolean).join(' ')}
    >
      {/* Visual hint */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div
        className={[
          'absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2',
          'h-10 w-[3px] rounded-full',
          isDragging ? 'bg-[#A8C7FA]/70' : 'bg-white/10 group-hover:bg-white/30',
          'transition-colors',
        ].join(' ')}
      />
    </div>
  );
});
