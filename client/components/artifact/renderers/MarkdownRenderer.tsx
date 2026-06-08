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
    <div className="h-full w-full overflow-auto bg-[#101214] px-6 py-8">
      <article className="mx-auto max-w-[900px] pb-16">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
          rehypePlugins={[rehypeKatex]}
          components={{
            h1({ children, node: _node, ...props }) {
              return <h1 className="mb-5 border-b border-white/10 pb-4 text-3xl font-semibold leading-tight text-white" {...props}>{children}</h1>;
            },
            h2({ children, node: _node, ...props }) {
              return <h2 className="mb-3 mt-8 text-2xl font-semibold leading-snug text-white" {...props}>{children}</h2>;
            },
            h3({ children, node: _node, ...props }) {
              return <h3 className="mb-2.5 mt-6 text-lg font-semibold leading-snug text-white/95" {...props}>{children}</h3>;
            },
            h4({ children, node: _node, ...props }) {
              return <h4 className="mb-2 mt-5 text-base font-semibold leading-snug text-white/90" {...props}>{children}</h4>;
            },
            p({ children, node: _node, ...props }) {
              return <p className="my-4 text-[15px] leading-7 text-white/85" {...props}>{children}</p>;
            },
            a({ children, node: _node, ...props }) {
              return (
                <a
                  className="font-medium text-[#A8C7FA] underline decoration-[#A8C7FA]/35 underline-offset-4 hover:text-[#DAEEFF]"
                  {...props}
                  target="_blank"
                  rel="noreferrer"
                >
                  {children}
                </a>
              );
            },
            strong({ children, node: _node, ...props }) {
              return <strong className="font-semibold text-white" {...props}>{children}</strong>;
            },
            em({ children, node: _node, ...props }) {
              return <em className="text-white/90" {...props}>{children}</em>;
            },
            ul({ children, node: _node, ...props }) {
              return <ul className="my-4 ml-6 list-disc space-y-2 text-[15px] leading-7 text-white/85 marker:text-[#A8C7FA]/75" {...props}>{children}</ul>;
            },
            ol({ children, node: _node, ...props }) {
              return <ol className="my-4 ml-6 list-decimal space-y-2 text-[15px] leading-7 text-white/85 marker:text-[#A8C7FA]/85" {...props}>{children}</ol>;
            },
            li({ children, node: _node, ...props }) {
              return <li className="pl-1" {...props}>{children}</li>;
            },
            blockquote({ children, node: _node, ...props }) {
              return (
                <blockquote
                  className="my-5 border-l-2 border-[#A8C7FA]/60 bg-white/[0.03] px-4 py-3 text-[15px] leading-7 text-white/75"
                  {...props}
                >
                  {children}
                </blockquote>
              );
            },
            hr({ node: _node, ...props }) {
              return <hr className="my-8 border-white/10" {...props} />;
            },
            table({ children, node: _node, ...props }) {
              return (
                <div className="my-6 overflow-x-auto rounded-lg border border-white/10">
                  <table className="min-w-full border-collapse text-left text-sm text-white/85" {...props}>
                    {children}
                  </table>
                </div>
              );
            },
            thead({ children, node: _node, ...props }) {
              return <thead className="bg-white/[0.06] text-white" {...props}>{children}</thead>;
            },
            th({ children, node: _node, ...props }) {
              return <th className="border-b border-white/10 px-4 py-3 font-semibold" {...props}>{children}</th>;
            },
            td({ children, node: _node, ...props }) {
              return <td className="border-t border-white/10 px-4 py-3 align-top" {...props}>{children}</td>;
            },
            pre({ children }) {
              return (
                <div className="my-5 overflow-hidden rounded-lg border border-white/10 bg-[#0A0C0E]">
                  {children}
                </div>
              );
            },
            code(props) {
              const { children, className, node: _node, ...rest } = props as {
                children?: React.ReactNode;
                className?: string;
                node?: unknown;
              };
              const match = /language-(\w+)/.exec(className || '');
              const raw = String(children);
              const inline = !className && !raw.includes('\n');
              if (inline) {
                return (
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[0.88em] text-[#DAEEFF]" {...rest}>
                    {children}
                  </code>
                );
              }
              return (
                <SyntaxHighlighter
                  language={match?.[1] ?? 'text'}
                  style={vscDarkPlus}
                  customStyle={{ background: 'transparent', margin: 0, padding: '1rem', fontSize: '0.86rem', lineHeight: 1.65 }}
                >
                  {raw.replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </article>
    </div>
  );
});
