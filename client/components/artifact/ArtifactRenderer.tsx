/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Dispatches to the renderer matching the artifact type. Heavy renderers
 * (Chart with Recharts, React with @babel/standalone) are lazy-loaded.
 */

import React, { lazy, memo, Suspense } from 'react';
import type { Artifact } from './types';
import { HtmlRenderer } from './renderers/HtmlRenderer';
import { MarkdownRenderer } from './renderers/MarkdownRenderer';
import { MermaidRenderer } from './renderers/MermaidRenderer';
import { CodeRenderer } from './renderers/CodeRenderer';
import { JsonRenderer } from './renderers/JsonRenderer';
import { SvgRenderer } from './renderers/SvgRenderer';

const ChartRenderer = lazy(() => import('./renderers/ChartRenderer'));
const ReactRenderer = lazy(() => import('./renderers/ReactRenderer'));

interface ArtifactRendererProps {
  artifact: Artifact;
}

function LazyFallback() {
  return (
    <div className="w-full h-full flex items-center justify-center text-white/50 text-sm">
      Loading renderer…
    </div>
  );
}

export const ArtifactRenderer = memo(function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  const isStreaming = artifact.status === 'streaming';
  const key = `${artifact.id}-${isStreaming ? 'streaming' : 'complete'}`;

  switch (artifact.artifactType) {
    case 'text/html':
      return <HtmlRenderer content={artifact.content} stableKey={key} />;
    case 'image/svg+xml':
      return <SvgRenderer content={artifact.content} />;
    case 'text/markdown':
      return <MarkdownRenderer content={artifact.content} />;
    case 'application/vnd.ant.code':
      return <CodeRenderer content={artifact.content} language={artifact.language} />;
    case 'application/vnd.ant.mermaid':
      return <MermaidRenderer content={artifact.content} isStreaming={isStreaming} />;
    case 'application/json':
      return <JsonRenderer content={artifact.content} />;
    case 'application/vnd.ant.chart':
      return (
        <Suspense fallback={<LazyFallback />}>
          <ChartRenderer content={artifact.content} />
        </Suspense>
      );
    case 'application/vnd.ant.react':
      return (
        <Suspense fallback={<LazyFallback />}>
          <ReactRenderer content={artifact.content} isStreaming={isStreaming} />
        </Suspense>
      );
    default: {
      // Exhaustiveness safeguard
      return (
        <CodeRenderer content={artifact.content} language={artifact.language || 'text'} />
      );
    }
  }
});
