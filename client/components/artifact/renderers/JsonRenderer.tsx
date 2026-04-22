/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Collapsible JSON tree renderer (no external deps). Falls back to a plain
 * pre-formatted block if the payload is invalid JSON (e.g. still streaming).
 */

import React, { memo, useMemo, useState } from 'react';

interface JsonRendererProps {
  content: string;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export const JsonRenderer = memo(function JsonRenderer({ content }: JsonRendererProps) {
  const parsed = useMemo<Json | { __error: true }>(() => {
    try {
      return JSON.parse(content) as Json;
    } catch {
      return { __error: true };
    }
  }, [content]);

  if (parsed && typeof parsed === 'object' && '__error' in parsed) {
    return (
      <div className="w-full h-full overflow-auto p-6 bg-[#0C0E10] rounded-b-lg">
        <pre className="text-xs text-white/70 whitespace-pre-wrap font-mono">{content}</pre>
        <div className="mt-4 text-xs text-amber-400/80">Waiting for valid JSON…</div>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-auto p-6 bg-[#0C0E10] rounded-b-lg font-mono text-sm">
      <JsonNode value={parsed as Json} depth={0} isRoot />
    </div>
  );
});

interface JsonNodeProps {
  value: Json;
  depth: number;
  isRoot?: boolean;
  keyName?: string;
}

const JsonNode = memo(function JsonNode({ value, depth, isRoot, keyName }: JsonNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (value === null) return <Leaf k={keyName} v="null" className="text-white/50" />;
  if (typeof value === 'string') return <Leaf k={keyName} v={`"${value}"`} className="text-green-300/90" />;
  if (typeof value === 'number') return <Leaf k={keyName} v={String(value)} className="text-amber-300/90" />;
  if (typeof value === 'boolean') return <Leaf k={keyName} v={String(value)} className="text-purple-300/90" />;

  const isArray = Array.isArray(value);
  const entries: [string, Json][] = isArray
    ? (value as Json[]).map((v, i) => [String(i), v])
    : Object.entries(value as { [k: string]: Json });

  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const summary = entries.length === 0
    ? `${open}${close}`
    : `${open} ${entries.length} ${isArray ? 'items' : 'keys'} ${close}`;

  return (
    <div className={isRoot ? '' : 'ml-4'}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="inline-flex items-center gap-1 text-white/80 hover:text-white focus:outline-none"
      >
        <svg
          className={`size-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {keyName !== undefined && (
          <span className="text-[#A8C7FA]/90">&quot;{keyName}&quot;</span>
        )}
        {keyName !== undefined && <span className="text-white/40">:</span>}
        <span className="text-white/60">{expanded ? open : summary}</span>
      </button>
      {expanded && (
        <div className="border-l border-white/5 pl-2 ml-1.5">
          {entries.map(([k, v]) => (
            <div key={k} className="py-0.5">
              <JsonNode value={v} depth={depth + 1} keyName={isArray ? undefined : k} />
            </div>
          ))}
          <div className="text-white/60">{close}</div>
        </div>
      )}
    </div>
  );
});

function Leaf({ k, v, className }: { k?: string; v: string; className?: string }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      {k !== undefined && <span className="text-[#A8C7FA]/90">&quot;{k}&quot;</span>}
      {k !== undefined && <span className="text-white/40">:</span>}
      <span className={className}>{v}</span>
    </div>
  );
}
