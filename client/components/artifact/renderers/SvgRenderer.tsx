/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Renders an SVG artifact after sanitising with DOMPurify (SVG profile). We
 * never trust SVG payloads directly because they can carry <script> nodes.
 */

import React, { memo, useMemo } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import { ZoomableViewport } from '../ZoomableViewport';

interface SvgRendererProps {
  content: string;
}

export const SvgRenderer = memo(function SvgRenderer({ content }: SvgRendererProps) {
  const safeSvg = useMemo(() => {
    try {
      return DOMPurify.sanitize(content, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
    } catch {
      return '';
    }
  }, [content]);

  return (
    <ZoomableViewport contentClassName="max-w-none [&>svg]:max-w-full [&>svg]:max-h-[70vh] [&>svg]:h-auto [&>svg]:w-auto">
      <div
        dangerouslySetInnerHTML={{ __html: safeSvg }}
      />
    </ZoomableViewport>
  );
});
