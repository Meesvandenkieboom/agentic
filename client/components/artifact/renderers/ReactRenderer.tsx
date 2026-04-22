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

// NOTE: React 19 dropped UMD builds entirely — `unpkg.com/react@19/umd/...`
// 404s, which leaves `window.React` undefined and every artifact throws
// "Cannot read properties of undefined (reading 'useState')". Pin to React 18
// UMD, which is rock-solid for standalone script-tag usage and exposes
// `createRoot` via `window.ReactDOM`.
const REACT_CDN = 'https://unpkg.com/react@18.3.1/umd/react.production.min.js';
const REACT_DOM_CDN = 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js';
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
    // inlined as a classic <script>. We handle three common default-export
    // shapes so the resulting binding is always on window.__ArtifactDefault:
    //   (a) export default function App(){...}  -> function App(){...}; window.__ArtifactDefault = App;
    //   (b) export default class App {}         -> class App {};          window.__ArtifactDefault = App;
    //   (c) export default <expression>         -> window.__ArtifactDefault = <expression>;
    let defaultName: string | null = null;
    const stripped = compiled
      // Kill ES imports (we inject CDN globals instead).
      .replace(/^\s*import\s[^;]*;?\s*$/gm, '')
      // Named export declarations: just drop the `export` keyword.
      .replace(/^\s*export\s+(const|let|var|function|class)\s/gm, '$1 ')
      // Default-exported function/class → keep the declaration intact and
      // remember its name so we can assign it to __ArtifactDefault below.
      .replace(
        /^\s*export\s+default\s+(function|class)\s+([A-Za-z_$][\w$]*)/gm,
        (_m, kind: string, name: string) => { defaultName = name; return `${kind} ${name}`; },
      )
      // Default-exported expression → straight assignment.
      .replace(/^\s*export\s+default\s+/gm, 'window.__ArtifactDefault = ');

    const bindDefault = defaultName
      ? `\ntry { window.__ArtifactDefault = ${defaultName}; } catch(_){}`
      : '';

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
      // Render error into #root (called from multiple places below)
      function __artifactError(msg) {
        var el = document.getElementById('root');
        if (!el) return;
        el.innerHTML = '';
        var err = document.createElement('div');
        err.className = 'artifact-error';
        err.textContent = 'Runtime error: ' + msg;
        el.appendChild(err);
      }
      // Catch any uncaught errors (e.g. CDN blocked)
      window.addEventListener('error', function (e) {
        __artifactError(e.message || 'unknown error');
      });

      function __runArtifact() {
        try {
          if (!window.React || !window.ReactDOM) {
            throw new Error('React failed to load from CDN. Check network / blocklist.');
          }
          var React = window.React;
          var ReactDOM = window.ReactDOM;
          var useState = React.useState;
          var useEffect = React.useEffect;
          var useLayoutEffect = React.useLayoutEffect;
          var useRef = React.useRef;
          var useMemo = React.useMemo;
          var useCallback = React.useCallback;
          var useReducer = React.useReducer;
          var useContext = React.useContext;
          var createContext = React.createContext;
          var Fragment = React.Fragment;
          var Children = React.Children;
          var cloneElement = React.cloneElement;
          var createElement = React.createElement;
          var memo = React.memo;
          var forwardRef = React.forwardRef;
          var Suspense = React.Suspense;
          ${stripped}
          ${bindDefault}
          var Component = window.__ArtifactDefault
            || (typeof App !== 'undefined' ? App : null)
            || (typeof Main !== 'undefined' ? Main : null);
          if (!Component) {
            throw new Error('No default export found. Use: export default function App(){ ... }');
          }
          var rootEl = document.getElementById('root');
          if (ReactDOM.createRoot) {
            ReactDOM.createRoot(rootEl).render(React.createElement(Component));
          } else if (ReactDOM.render) {
            // Fallback for React <18 UMD
            ReactDOM.render(React.createElement(Component), rootEl);
          } else {
            throw new Error('ReactDOM has neither createRoot nor render.');
          }
        } catch (e) {
          __artifactError((e && e.message ? e.message : String(e)));
        }
      }

      // Wait until both React and ReactDOM are on window. The CDN scripts above
      // are synchronous <script src>, so they'll normally be ready by now — but
      // in rare cases (slow network, HTTP/2 reordering) they aren't. Poll
      // briefly, then fail with a clear message.
      (function () {
        var start = Date.now();
        (function check() {
          if (window.React && window.ReactDOM) return __runArtifact();
          if (Date.now() - start > 3000) {
            return __artifactError('Timed out waiting for React to load from CDN.');
          }
          setTimeout(check, 30);
        })();
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
