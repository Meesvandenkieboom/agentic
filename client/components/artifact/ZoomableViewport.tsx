/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { memo, useCallback, useState } from 'react';
import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ZoomableViewportProps {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
}

const ZOOM_STEP = 0.15;

export const ZoomableViewport = memo(function ZoomableViewport({
  children,
  className,
  contentClassName,
  initialScale = 1,
  minScale = 0.35,
  maxScale = 2.5,
}: ZoomableViewportProps) {
  const [scale, setScale] = useState(initialScale);

  const clampScale = useCallback((value: number) => (
    Math.max(minScale, Math.min(maxScale, Number(value.toFixed(2))))
  ), [maxScale, minScale]);

  const zoomIn = useCallback(() => setScale(value => clampScale(value + ZOOM_STEP)), [clampScale]);
  const zoomOut = useCallback(() => setScale(value => clampScale(value - ZOOM_STEP)), [clampScale]);
  const reset = useCallback(() => setScale(clampScale(initialScale)), [clampScale, initialScale]);
  const fit = useCallback(() => setScale(clampScale(0.75)), [clampScale]);

  return (
    <div className={cn('relative w-full h-full overflow-hidden bg-[#0C0E10]', className)}>
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-white/10 bg-[#151719]/95 p-1 shadow-lg shadow-black/30 backdrop-blur">
        <ViewportButton onClick={zoomOut} title="Zoom out" disabled={scale <= minScale + 0.01}>
          <Minus className="size-4" />
        </ViewportButton>
        <div className="w-11 select-none text-center text-[11px] tabular-nums text-white/60">
          {Math.round(scale * 100)}%
        </div>
        <ViewportButton onClick={zoomIn} title="Zoom in" disabled={scale >= maxScale - 0.01}>
          <Plus className="size-4" />
        </ViewportButton>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <ViewportButton onClick={fit} title="Fit to screen">
          <Maximize2 className="size-4" />
        </ViewportButton>
        <ViewportButton onClick={reset} title="Reset zoom">
          <RotateCcw className="size-4" />
        </ViewportButton>
      </div>

      <div className="h-full w-full overflow-auto p-6">
        <div className="flex min-h-full min-w-full items-start justify-center pt-10">
          <div
            className={cn('origin-top transition-transform duration-150 ease-out', contentClassName)}
            style={{ transform: `scale(${scale})` }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
});

interface ViewportButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}

function ViewportButton({ onClick, title, disabled, children }: ViewportButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={[
        'flex size-7 items-center justify-center rounded-md text-white/60',
        'transition-colors hover:bg-white/10 hover:text-white',
        'disabled:pointer-events-none disabled:opacity-30',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
