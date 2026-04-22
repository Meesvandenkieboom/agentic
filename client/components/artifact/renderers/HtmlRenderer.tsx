/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Renders HTML artifacts inside a sandboxed iframe. The iframe sandbox
 * deliberately omits `allow-same-origin` so artifact scripts cannot access
 * the host document, cookies, or localStorage.
 */

import React, { memo, useMemo } from 'react';

interface HtmlRendererProps {
  content: string;
  /** When true, the iframe key is tied to a stable value so it doesn't reload on each delta. */
  stableKey?: string;
}

export const HtmlRenderer = memo(function HtmlRenderer({ content, stableKey }: HtmlRendererProps) {
  // We wrap bare HTML (no <html>) with a minimal doctype/head so basic styling works.
  const srcDoc = useMemo(() => {
    const trimmed = content.trimStart();
    const startsWithDoctype =
      trimmed.toLowerCase().startsWith('<!doctype') || trimmed.toLowerCase().startsWith('<html');
    if (startsWithDoctype) return content;
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 16px; font-family: Inter, system-ui, sans-serif; color: #111; background: #fff; }
    </style>
  </head>
  <body>${content}</body>
</html>`;
  }, [content]);

  return (
    <iframe
      key={stableKey}
      title="Artifact preview"
      srcDoc={srcDoc}
      // Deliberately no allow-same-origin (security)
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      className="w-full h-full bg-white rounded-b-lg border-0"
    />
  );
});
