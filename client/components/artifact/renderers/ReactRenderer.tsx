/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Executes a single-file React/JSX artifact inside a sandboxed iframe.
 * Babel compiles the JSX → ES in the parent window; the resulting code runs
 * inside an iframe whose sandbox attribute blocks same-origin access.
 */

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';

interface ReactRendererProps {
  content: string;
  isStreaming?: boolean;
}

const REACT_CDN = 'https://unpkg.com/react@19/umd/react.production.min.js';
const REACT_DOM_CDN = 'https://unpkg.com/react-dom@19/umd/react-dom.production.min.js';
const TAILWIND_CDN = 'https://cdn.tailwindcss.com';

export const ReactRenderer = memo(function ReactRenderer({ content, isStreaming }: ReactRendererProps) {
  const [compiled, setCompiled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Stable iframe key keeps the iframe mounted across content updates so we
  // can refresh by re-writing srcDoc; React component state inside the iframe
  // resets on each compile, which matches Claude.ai's behaviour.
  useEffect(() => {
    if (isStreaming) return; // don't compile mid-stream
    let cancelled = false;
    (async () => {
      try {
        const babel = await import('@babel/standalone');
        const result = babel.transform(content, {
          presets: [
            ['env', { modules: false, targets: { esmodules: true } }],
            'react',
            'typescript',
          ],
          filename: 'artifact.tsx',
        });
        if (!cancelled) {
          setCompiled(result.code ?? '');
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setCompiled(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [content, isStreaming]);

  const srcDoc = useMemo(() => {
    if (!compiled) return null;
    // Strip bare ES import/export statements so the iframe bundle can be
    // inlined as a classic <script>.
    const stripped = compiled
      .replace(/^\s*import[^;]+;?\s*$/gm, '')
      .replace(/^\s*export\s+default\s+/gm, 'window.__ArtifactDefault = ')
      .replace(/^\s*export\s+/gm, '');

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <script src="${TAILWIND_CDN}"></script>
    <script src="${REACT_CDN}"></script>
    <script src="${REACT_DOM_CDN}"></script>
    <style>
      html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: Inter, system-ui, sans-serif; }
      #root { padding: 16px; }
      .artifact-error { padding: 16px; color: #b91c1c; background: #fee2e2; font-family: monospace; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      (function() {
        try {
          var React = window.React;
          var ReactDOM = window.ReactDOM;
          var useState = React.useState;
          var useEffect = React.useEffect;
          var useRef = React.useRef;
          var useMemo = React.useMemo;
          var useCallback = React.useCallback;
          var useReducer = React.useReducer;
          var useContext = React.useContext;
          var Fragment = React.Fragment;
          ${stripped}
          var Component = window.__ArtifactDefault
            || (typeof App !== 'undefined' ? App : null)
            || (typeof Main !== 'undefined' ? Main : null);
          if (!Component) {
            throw new Error('No default export found. Use: export default function App(){ ... }');
          }
          var root = ReactDOM.createRoot(document.getElementById('root'));
          root.render(React.createElement(Component));
        } catch (e) {
          var el = document.getElementById('root');
          el.innerHTML = '';
          var err = document.createElement('div');
          err.className = 'artifact-error';
          err.textContent = 'Runtime error: ' + (e && e.message ? e.message : e);
          el.appendChild(err);
        }
      })();
    </script>
  </body>
</html>`;
  }, [compiled]);

  if (isStreaming) {
    return (
      <div className="w-full h-full overflow-auto p-6 bg-[#0C0E10] rounded-b-lg">
        <div className="text-xs text-[#A8C7FA]/80 mb-3 flex items-center gap-2">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full rounded-full bg-[#A8C7FA] opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full size-1.5 bg-[#A8C7FA]" />
          </span>
          Receiving component source…
        </div>
        <pre className="text-xs text-white/70 whitespace-pre-wrap font-mono">{content}</pre>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full overflow-auto p-6 bg-[#0C0E10] rounded-b-lg">
        <div className="text-sm text-red-400 mb-3 font-medium">Compilation error</div>
        <pre className="text-xs text-red-300/80 whitespace-pre-wrap font-mono">{error}</pre>
        <div className="mt-4 text-xs text-white/40 font-medium">Source</div>
        <pre className="mt-1 text-xs text-white/60 whitespace-pre-wrap font-mono">{content}</pre>
      </div>
    );
  }

  if (!srcDoc) {
    return (
      <div className="w-full h-full flex items-center justify-center text-white/50 text-sm">
        Compiling…
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title="React artifact"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      className="w-full h-full bg-white rounded-b-lg border-0"
    />
  );
});

export default ReactRenderer;
