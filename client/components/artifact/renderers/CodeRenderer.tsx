/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Renders arbitrary source code with syntax highlighting. Language is derived
 * from the `language` attribute on the artifact tag.
 */

import React, { memo } from 'react';
import { SyntaxHighlighter, vscDarkPlus } from '../../../utils/syntaxHighlighter';

interface CodeRendererProps {
  content: string;
  language?: string;
}

export const CodeRenderer = memo(function CodeRenderer({ content, language }: CodeRendererProps) {
  return (
    <div className="w-full h-full overflow-auto bg-[#0C0E10] rounded-b-lg">
      <SyntaxHighlighter
        language={language || 'text'}
        style={vscDarkPlus}
        showLineNumbers
        customStyle={{ margin: 0, padding: '1.25rem', background: 'transparent', minHeight: '100%' }}
        lineNumberStyle={{ color: 'rgba(255,255,255,0.3)', userSelect: 'none' }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
});
