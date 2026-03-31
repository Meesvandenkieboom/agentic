/**
 * AskUserQuestionComponent — Compact inline display for AskUserQuestion tool.
 * Shows in the message stream as a non-interactive indicator.
 * The actual interaction happens in QuestionInput (replaces the chat input bar).
 */

import React from 'react';
import { HelpCircle, Loader2 } from 'lucide-react';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface AskUserQuestionComponentProps {
  toolId: string;
  questions: Question[];
}

export function AskUserQuestionComponent({
  questions,
}: AskUserQuestionComponentProps) {
  if (!questions || questions.length === 0) return null;

  return (
    <div className="w-full border border-white/10 rounded-xl my-3 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 bg-[#0C0E10] border-b border-white/10">
        <HelpCircle size={14} className="text-blue-400 shrink-0" />
        <span className="text-sm font-medium leading-6" style={{ color: 'rgb(var(--text-primary))' }}>
          Question
        </span>
        <span className="flex-1 min-w-0 text-xs truncate text-white/50">
          {questions.map(q => q.question).join(' · ')}
        </span>
        <Loader2 size={12} className="text-white/30 animate-spin shrink-0" />
      </div>
    </div>
  );
}
