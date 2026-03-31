/**
 * AskUserQuestionComponent - Inline question/poll UI for AskUserQuestion tool
 * Renders questions with selectable options inline in the chat.
 */

import React, { useState, useCallback } from 'react';
import { HelpCircle, Check, ChevronRight } from 'lucide-react';
import { dispatchQuestionAnswer } from '../../utils/questionEvents';

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
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [showCustom, setShowCustom] = useState<Record<number, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string>>({});

  const handleSelect = useCallback((questionIdx: number, optionLabel: string, multiSelect: boolean) => {
    if (submitted) return;
    setSelections(prev => {
      const current = prev[questionIdx] || [];
      if (multiSelect) {
        const isSelected = current.includes(optionLabel);
        return {
          ...prev,
          [questionIdx]: isSelected
            ? current.filter(l => l !== optionLabel)
            : [...current, optionLabel],
        };
      }
      setShowCustom(p => ({ ...p, [questionIdx]: false }));
      return { ...prev, [questionIdx]: [optionLabel] };
    });
  }, [submitted]);

  const handleCustomToggle = useCallback((questionIdx: number) => {
    if (submitted) return;
    setShowCustom(prev => {
      const isShowing = !prev[questionIdx];
      if (isShowing) {
        setSelections(p => ({ ...p, [questionIdx]: [] }));
      }
      return { ...prev, [questionIdx]: isShowing };
    });
  }, [submitted]);

  const buildAnswers = useCallback((): Record<string, string> => {
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      const key = q.header || `question_${idx}`;
      if (showCustom[idx] && customInputs[idx]) {
        answers[key] = customInputs[idx];
      } else {
        const selected = selections[idx] || [];
        answers[key] = selected.join(', ') || 'Skipped';
      }
    });
    return answers;
  }, [questions, selections, customInputs, showCustom]);

  const handleSubmit = useCallback(() => {
    if (submitted) return;
    const answers = buildAnswers();
    setSubmittedAnswers(answers);
    setSubmitted(true);
    dispatchQuestionAnswer(toolId, answers);
  }, [submitted, buildAnswers, toolId]);

  const handleSkip = useCallback(() => {
    if (submitted) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      answers[q.header || `question_${idx}`] = 'Skipped';
    });
    setSubmittedAnswers(answers);
    setSubmitted(true);
    dispatchQuestionAnswer(toolId, answers);
  }, [submitted, questions, toolId]);

  const canSubmit = questions.some((_, idx) => {
    if (showCustom[idx]) return (customInputs[idx] || '').trim().length > 0;
    return (selections[idx] || []).length > 0;
  });

  return (
    <div className="w-full my-3">
      <div className="border border-white/10 rounded-xl overflow-hidden" style={{ background: 'rgb(var(--bg-input))' }}>
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/10 bg-[#0C0E10]">
          <HelpCircle size={18} className="text-blue-400 shrink-0" />
          <span className="text-sm font-medium" style={{ color: 'rgb(var(--text-primary))' }}>
            Questions
          </span>
          {submitted && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
              Answered
            </span>
          )}
        </div>

        {/* Questions */}
        <div className="divide-y divide-white/5">
          {questions.map((q, qIdx) => {
            const selected = selections[qIdx] || [];
            const answerKey = q.header || `question_${qIdx}`;
            const answeredValue = submittedAnswers[answerKey];

            return (
              <div key={qIdx} className="px-4 py-4">
                {/* Question text + badge */}
                <div className="flex items-start gap-2 mb-3">
                  <p className="text-sm font-medium flex-1" style={{ color: 'rgb(var(--text-primary))' }}>
                    {q.question}
                  </p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded text-white/40 bg-white/5 border border-white/10 shrink-0 mt-0.5">
                    {q.multiSelect ? 'Select multiple' : 'Select one answer'}
                  </span>
                </div>

                {/* Options */}
                {!submitted ? (
                  <div className="space-y-2">
                    {q.options.map((opt, optIdx) => {
                      const isSelected = selected.includes(opt.label);
                      return (
                        <button
                          key={optIdx}
                          onClick={() => handleSelect(qIdx, opt.label, q.multiSelect || false)}
                          className="w-full text-left group transition-all duration-150"
                        >
                          <div
                            className={`
                              flex items-start gap-3 px-3.5 py-2.5 rounded-lg border transition-all duration-150
                              ${isSelected
                                ? 'border-blue-500/50 bg-blue-500/10'
                                : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                              }
                            `}
                          >
                            <div className={`
                              shrink-0 mt-0.5 w-4 h-4 border flex items-center justify-center transition-all duration-150
                              ${q.multiSelect ? 'rounded-sm' : 'rounded-full'}
                              ${isSelected ? 'border-blue-500 bg-blue-500' : 'border-white/20 bg-transparent'}
                            `}>
                              {isSelected && <Check size={10} className="text-white" strokeWidth={3} />}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className={`text-sm font-medium ${isSelected ? 'text-blue-300' : 'text-white/80'}`}>
                                {opt.label}
                              </div>
                              {opt.description && (
                                <div className="text-xs text-white/40 mt-0.5 leading-relaxed">
                                  {opt.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}

                    {/* "Other" custom input toggle */}
                    <button
                      onClick={() => handleCustomToggle(qIdx)}
                      className="w-full text-left"
                    >
                      <div
                        className={`
                          flex items-center gap-3 px-3.5 py-2.5 rounded-lg border transition-all duration-150
                          ${showCustom[qIdx]
                            ? 'border-blue-500/50 bg-blue-500/10'
                            : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                          }
                        `}
                      >
                        <div className={`
                          shrink-0 w-4 h-4 border flex items-center justify-center transition-all duration-150
                          ${q.multiSelect ? 'rounded-sm' : 'rounded-full'}
                          ${showCustom[qIdx] ? 'border-blue-500 bg-blue-500' : 'border-white/20 bg-transparent'}
                        `}>
                          {showCustom[qIdx] && <Check size={10} className="text-white" strokeWidth={3} />}
                        </div>
                        <span className={`text-sm ${showCustom[qIdx] ? 'text-blue-300 font-medium' : 'text-white/40'}`}>
                          Other
                        </span>
                      </div>
                    </button>

                    {/* Custom text input */}
                    {showCustom[qIdx] && (
                      <div className="pl-7 mt-1">
                        <input
                          type="text"
                          placeholder="Type your answer..."
                          value={customInputs[qIdx] || ''}
                          onChange={(e) => setCustomInputs(prev => ({ ...prev, [qIdx]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleSubmit(); }}
                          autoFocus
                          className="w-full px-3 py-2 text-sm rounded-lg border border-white/10 bg-white/[0.03] text-white/80 placeholder-white/30 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  /* Answered state */
                  <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-lg border border-white/10 bg-white/[0.02]">
                    <ChevronRight size={14} className="text-blue-400 shrink-0" />
                    <span className="text-sm text-white/70">{answeredValue}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer with buttons */}
        {!submitted && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/10 bg-[#0C0E10]">
            <button
              onClick={handleSkip}
              className="px-3 py-1.5 text-xs font-medium text-white/40 hover:text-white/60 transition-colors rounded-md hover:bg-white/5"
            >
              Skip
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="send-button-active px-4 py-1.5 text-xs font-medium rounded-md transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Submit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
