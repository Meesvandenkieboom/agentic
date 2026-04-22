/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Renders a Mermaid diagram artifact by delegating to the shared mermaid lib.
 * During streaming we debounce render attempts so partial text doesn't throw.
 */

import React, { memo, useEffect, useRef } from 'react';
import mermaid from 'mermaid';

let initialised = false;
function ensureInit(): void {
  if (initialised) return;
  initialised = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      primaryColor: '#A8C7FA',
      primaryTextColor: '#DAEEFF',
      primaryBorderColor: 'rgba(168, 199, 250, 0.3)',
      lineColor: 'rgba(168, 199, 250, 0.5)',
      secondaryColor: 'rgba(168, 199, 250, 0.1)',
      background: 'transparent',
      mainBkg: 'rgba(168, 199, 250, 0.1)',
      secondBkg: 'rgba(168, 199, 250, 0.05)',
      fontFamily: 'Inter, system-ui, sans-serif',
    },
    flowchart: { htmlLabels: true, curve: 'basis' },
    securityLevel: 'loose',
  });
}

interface MermaidRendererProps {
  content: string;
  /** While streaming we delay rendering longer to avoid noisy syntax errors. */
  isStreaming?: boolean;
}

export const MermaidRenderer = memo(function MermaidRenderer({ content, isStreaming }: MermaidRendererProps) {
  ensureInit();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const delay = isStreaming ? 500 : 80;
    const t = setTimeout(async () => {
      if (!ref.current) return;
      try {
        const id = `mermaid-panel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, content);
        ref.current.innerHTML = svg;
      } catch {
        if (ref.current) {
          ref.current.innerHTML =
            `<pre class="text-xs text-white/60 whitespace-pre-wrap">${escapeHtml(content)}</pre>`;
        }
      }
    }, delay);
    return () => clearTimeout(t);
  }, [content, isStreaming]);

  return (
    <div className="w-full h-full overflow-auto p-6 bg-black/20 rounded-b-lg">
      <div ref={ref} className="w-full h-full flex items-center justify-center [&_svg]:max-w-full" />
    </div>
  );
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
