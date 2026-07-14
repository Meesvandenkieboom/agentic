/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useEffect, useRef, useState } from 'react';
import { Brain, ChevronDown, Check } from 'lucide-react';
import type { ProviderType } from '../../config/models';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const DEFAULT_EFFORT: ReasoningEffort = 'high';

export const ALL_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

interface EffortOption {
  id: ReasoningEffort;
  label: string;
  description: string;
}

const CLAUDE_EFFORT_OPTIONS: EffortOption[] = [
  { id: 'low',    label: 'Low',    description: 'Fastest, minimal thinking' },
  { id: 'medium', label: 'Medium', description: 'Balanced speed and depth' },
  { id: 'high',   label: 'High',   description: 'Default — strong reasoning' },
  { id: 'xhigh',  label: 'xHigh',  description: 'Deep multi-step reasoning' },
  { id: 'max',    label: 'Max',    description: 'Exhaustive — slowest, highest quality' },
];

// ChatGPT/Codex reasoning ladder (GPT-5.6 era). Ultra is Codex-specific:
// it fans work out to parallel subagents rather than just thinking longer.
const CODEX_EFFORT_OPTIONS: EffortOption[] = [
  { id: 'low',    label: 'Low',        description: 'Fast responses with lighter reasoning' },
  { id: 'medium', label: 'Medium',     description: 'Balances speed and reasoning depth' },
  { id: 'high',   label: 'High',       description: 'Greater reasoning depth for complex problems' },
  { id: 'xhigh',  label: 'Extra High', description: 'Extra-high reasoning depth for complex problems' },
  { id: 'max',    label: 'Max',        description: 'Maximum reasoning depth for the hardest problems' },
  { id: 'ultra',  label: 'Ultra',      description: 'Maximum reasoning with parallel subagent delegation' },
];

export function effortOptionsFor(provider: ProviderType): EffortOption[] {
  return provider === 'codex' ? CODEX_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS;
}

/** Clamp an effort to the selected provider's ladder (e.g. Codex 'ultra' → Claude 'max'). */
export function normalizeEffort(effort: ReasoningEffort, provider: ProviderType): ReasoningEffort {
  if (effortOptionsFor(provider).some(o => o.id === effort)) return effort;
  return effort === 'ultra' ? 'max' : DEFAULT_EFFORT;
}

interface ReasoningEffortSelectorProps {
  effort: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  /** Provider of the selected model; decides which effort ladder to show. */
  provider?: ProviderType;
  /** When true, renders the button with the NewChatWelcome styling. */
  welcomeStyle?: boolean;
}

export function ReasoningEffortSelector({ effort, onChange, provider = 'anthropic', welcomeStyle = false }: ReasoningEffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const options = effortOptionsFor(provider);
  const current = options.find(o => o.id === effort) ?? options.find(o => o.id === DEFAULT_EFFORT)!;

  const buttonClass = welcomeStyle
    ? 'border border-white/10 bg-transparent text-white hover:bg-gray-800 rounded-lg transition outline-none focus:outline-none flex items-center gap-1'
    : 'btn-icon rounded-lg flex items-center gap-1';

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setIsOpen(v => !v)}
        type="button"
        className={buttonClass}
        title={`Reasoning effort: ${current.label}`}
        style={{
          fontSize: '0.75rem',
          fontWeight: 500,
          padding: '0.375rem 0.625rem',
        }}
      >
        <Brain size={14} />
        <span>{current.label}</span>
        <ChevronDown size={12} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-56 bg-[#1a1c1e] border border-white/10 rounded-lg shadow-lg overflow-hidden z-50">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-gray-500 border-b border-white/5">
            Reasoning Effort
          </div>
          {options.map((opt, index) => {
            const isSelected = opt.id === effort;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onChange(opt.id);
                  setIsOpen(false);
                }}
                className={`w-full flex items-start gap-2 px-3 py-2.5 text-left transition-colors ${
                  index > 0 ? 'border-t border-white/5' : ''
                } ${isSelected ? 'bg-white/5' : 'hover:bg-white/5'}`}
              >
                <div className="flex-shrink-0 w-4 mt-0.5">
                  {isSelected && <Check size={14} className="text-emerald-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-100 font-medium">{opt.label}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{opt.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
