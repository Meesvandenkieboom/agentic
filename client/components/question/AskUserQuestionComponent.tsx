/**
 * AskUserQuestionComponent — Compact inline display for AskUserQuestion tool.
 * Shows in the message stream as a non-interactive indicator.
 * The actual interaction happens in QuestionInput (replaces the chat input bar).
 */

import React, { useState, useEffect } from 'react';
import { HelpCircle, Loader2, CheckCircle2 } from 'lucide-react';
import { QUESTION_ANSWER_EVENT, type QuestionAnswerDetail } from '../../utils/questionEvents';

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
  toolId,
  questions,
}: AskUserQuestionComponentProps) {
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<QuestionAnswerDetail>).detail;
      if (detail.toolId === toolId) {
        setAnswered(true);
      }
    };
    window.addEventListener(QUESTION_ANSWER_EVENT, handler);
    return () => window.removeEventListener(QUESTION_ANSWER_EVENT, handler);
  }, [toolId]);

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
        {answered ? (
          <CheckCircle2 size={12} className="text-green-400 shrink-0" />
        ) : (
          <Loader2 size={12} className="text-white/30 animate-spin shrink-0" />
        )}
      </div>
    </div>
  );
}
