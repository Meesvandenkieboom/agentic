/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Renders a Recharts chart from a JSON spec produced by the assistant.
 *
 * Spec shape:
 *   {
 *     "kind": "bar" | "line" | "pie",
 *     "data": [{ "name": "Jan", "value": 10 }, ...],
 *     "xKey": "name",
 *     "series": [{ "key": "value", "color": "#A8C7FA", "name": "Sales" }]
 *   }
 */

import React, { memo, useMemo } from 'react';
import {
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';

interface ChartRendererProps {
  content: string;
}

interface Series {
  key: string;
  color?: string;
  name?: string;
}

interface ChartSpec {
  kind: 'bar' | 'line' | 'pie';
  data: Array<Record<string, number | string>>;
  xKey?: string;
  series?: Series[];
  /** For pie: key for the value */
  valueKey?: string;
  /** For pie: key for the slice label */
  nameKey?: string;
}

const DEFAULT_COLORS = [
  '#A8C7FA', '#DAEEFF', '#7FB3D5', '#5DADE2',
  '#48C9B0', '#F7DC6F', '#E59866', '#EC7063',
];

function isChartSpec(v: unknown): v is ChartSpec {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Partial<ChartSpec>;
  if (!obj.kind || !['bar', 'line', 'pie'].includes(obj.kind)) return false;
  if (!Array.isArray(obj.data)) return false;
  return true;
}

export const ChartRenderer = memo(function ChartRenderer({ content }: ChartRendererProps) {
  const { spec, error } = useMemo<{ spec: ChartSpec | null; error: string | null }>(() => {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!isChartSpec(parsed)) return { spec: null, error: 'Invalid chart spec' };
      return { spec: parsed, error: null };
    } catch (e) {
      return { spec: null, error: e instanceof Error ? e.message : 'Invalid JSON' };
    }
  }, [content]);

  if (!spec) {
    return (
      <div className="w-full h-full p-6 overflow-auto bg-[#0C0E10] rounded-b-lg">
        <div className="text-xs text-amber-400/80 mb-3">
          {error ?? 'Waiting for chart spec…'}
        </div>
        <pre className="text-xs text-white/60 whitespace-pre-wrap font-mono">{content}</pre>
      </div>
    );
  }

  const series = spec.series ?? [{ key: 'value' }];
  const xKey = spec.xKey ?? 'name';

  return (
    <div className="w-full h-full p-6 bg-[#0C0E10] rounded-b-lg">
      <ResponsiveContainer width="100%" height="100%">
        {spec.kind === 'bar' ? (
          <BarChart data={spec.data}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis dataKey={xKey} stroke="rgba(255,255,255,0.6)" />
            <YAxis stroke="rgba(255,255,255,0.6)" />
            <Tooltip contentStyle={{ background: '#111', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }} />
            <Legend wrapperStyle={{ color: 'rgba(255,255,255,0.8)' }} />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.name ?? s.key}
                fill={s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              />
            ))}
          </BarChart>
        ) : spec.kind === 'line' ? (
          <LineChart data={spec.data}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis dataKey={xKey} stroke="rgba(255,255,255,0.6)" />
            <YAxis stroke="rgba(255,255,255,0.6)" />
            <Tooltip contentStyle={{ background: '#111', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }} />
            <Legend wrapperStyle={{ color: 'rgba(255,255,255,0.8)' }} />
            {series.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name ?? s.key}
                stroke={s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            ))}
          </LineChart>
        ) : (
          <PieChart>
            <Tooltip contentStyle={{ background: '#111', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }} />
            <Legend wrapperStyle={{ color: 'rgba(255,255,255,0.8)' }} />
            <Pie
              data={spec.data}
              dataKey={spec.valueKey ?? (series[0]?.key ?? 'value')}
              nameKey={spec.nameKey ?? xKey}
              cx="50%"
              cy="50%"
              outerRadius={120}
              label
            >
              {spec.data.map((_, i) => (
                <Cell key={`cell-${i}`} fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
});

export default ChartRenderer;
