/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Renders markdown artifacts using the same pipeline as chat messages:
 * react-markdown + remark-gfm + remark-math + rehype-katex.
 */

import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { SyntaxHighlighter, vscDarkPlus } from '../../../utils/syntaxHighlighter';

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="w-full h-full overflow-auto p-6 prose prose-invert prose-sm max-w-none
      prose-headings:text-white prose-p:text-white/85 prose-strong:text-white
      prose-a:text-[#A8C7FA] prose-code:text-[#DAEEFF]
      prose-pre:bg-[#0C0E10] prose-pre:border prose-pre:border-white/10
      prose-hr:border-white/10 prose-blockquote:border-l-[#A8C7FA]/50 prose-blockquote:text-white/70
      prose-li:text-white/85"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code(props) {
            const { children, className, node: _node, ...rest } = props as {
              children?: React.ReactNode;
              className?: string;
              node?: unknown;
            };
            const match = /language-(\w+)/.exec(className || '');
            const inline = !match;
            if (inline) {
              return (
                <code className="px-1.5 py-0.5 rounded bg-white/10 text-[0.9em]" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <SyntaxHighlighter
                language={match?.[1] ?? 'text'}
                style={vscDarkPlus}
                customStyle={{ background: 'transparent', margin: 0, padding: '1em' }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
