/**
 * QuestionInput — Replaces the ChatInput bar when AskUserQuestion is active.
 * Uses the same CSS classes (input-container, input-wrapper, input-field-wrapper)
 * so it seamlessly transforms the input area.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { HelpCircle, Check, X, Pencil } from 'lucide-react';

interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestionData {
  toolId: string;
  questions: Question[];
}

interface QuestionInputProps {
  question: PendingQuestionData;
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
}

export function QuestionInput({ question, onAnswer, onSkip }: QuestionInputProps) {
  const [currentQIdx, setCurrentQIdx] = useState(0);
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [showCustom, setShowCustom] = useState<Record<number, boolean>>({});
  const [focusedIdx, setFocusedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  const q = question.questions[currentQIdx];
  const totalQuestions = question.questions.length;
  const selected = selections[currentQIdx] || [];
  // Options + 1 for "Something else"
  const totalOptions = q.options.length + 1;

  // Focus container for keyboard nav
  useEffect(() => {
    containerRef.current?.focus();
  }, [currentQIdx]);

  // Focus custom input when shown
  useEffect(() => {
    if (showCustom[currentQIdx]) {
      customInputRef.current?.focus();
    }
  }, [showCustom, currentQIdx]);

  const handleSelect = useCallback((optionLabel: string) => {
    setSelections(prev => {
      const current = prev[currentQIdx] || [];
      if (q.multiSelect) {
        const isSelected = current.includes(optionLabel);
        return {
          ...prev,
          [currentQIdx]: isSelected
            ? current.filter(l => l !== optionLabel)
            : [...current, optionLabel],
        };
      }
      setShowCustom(p => ({ ...p, [currentQIdx]: false }));
      return { ...prev, [currentQIdx]: [optionLabel] };
    });
  }, [currentQIdx, q.multiSelect]);

  const handleCustomToggle = useCallback(() => {
    setShowCustom(prev => {
      const isShowing = !prev[currentQIdx];
      if (isShowing) {
        setSelections(p => ({ ...p, [currentQIdx]: [] }));
      }
      return { ...prev, [currentQIdx]: isShowing };
    });
  }, [currentQIdx]);

  const buildAnswers = useCallback((): Record<string, string> => {
    const answers: Record<string, string> = {};
    question.questions.forEach((qq, idx) => {
      const key = qq.header || `question_${idx}`;
      if (showCustom[idx] && customInputs[idx]) {
        answers[key] = customInputs[idx];
      } else {
        const sel = selections[idx] || [];
        answers[key] = sel.join(', ') || 'Skipped';
      }
    });
    return answers;
  }, [question.questions, selections, customInputs, showCustom]);

  const canSubmitCurrent = (() => {
    if (showCustom[currentQIdx]) return (customInputs[currentQIdx] || '').trim().length > 0;
    return (selections[currentQIdx] || []).length > 0;
  })();

  const handleSubmit = useCallback(() => {
    if (!canSubmitCurrent) return;
    if (currentQIdx < totalQuestions - 1) {
      setCurrentQIdx(prev => prev + 1);
      setFocusedIdx(0);
    } else {
      onAnswer(buildAnswers());
    }
  }, [canSubmitCurrent, currentQIdx, totalQuestions, buildAnswers, onAnswer]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // If custom input is focused, only handle Enter/Escape
    if (showCustom[currentQIdx]) {
      if (e.key === 'Enter' && canSubmitCurrent) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onSkip();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIdx(prev => (prev - 1 + totalOptions) % totalOptions);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIdx(prev => (prev + 1) % totalOptions);
        break;
      case 'Enter':
        e.preventDefault();
        if (focusedIdx < q.options.length) {
          handleSelect(q.options[focusedIdx].label);
          // Auto-submit on Enter for single-select
          if (!q.multiSelect) {
            // Use timeout so selection state updates first
            setTimeout(() => {
              if (currentQIdx < totalQuestions - 1) {
                setCurrentQIdx(prev => prev + 1);
                setFocusedIdx(0);
              } else {
                const answers: Record<string, string> = {};
                question.questions.forEach((qq, idx) => {
                  const key = qq.header || `question_${idx}`;
                  if (idx === currentQIdx) {
                    answers[key] = q.options[focusedIdx].label;
                  } else if (showCustom[idx] && customInputs[idx]) {
                    answers[key] = customInputs[idx];
                  } else {
                    answers[key] = (selections[idx] || []).join(', ') || 'Skipped';
                  }
                });
                onAnswer(answers);
              }
            }, 100);
          }
        } else {
          handleCustomToggle();
        }
        break;
      case 'Escape':
        e.preventDefault();
        onSkip();
        break;
    }
  }, [showCustom, currentQIdx, canSubmitCurrent, handleSubmit, onSkip, focusedIdx, totalOptions, q, handleSelect, handleCustomToggle, totalQuestions, question.questions, customInputs, selections, onAnswer]);

  return (
    <div className="input-container" ref={containerRef} tabIndex={0} onKeyDown={handleKeyDown} style={{ outline: 'none' }}>
      <div className="input-wrapper flex-col">
        <div className="input-field-wrapper">
          {/* Question header */}
          <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <HelpCircle size={16} className="text-blue-400 shrink-0" />
              <p className="text-sm font-medium truncate" style={{ color: 'rgb(var(--text-primary))' }}>
                {q.question}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-3">
              {totalQuestions > 1 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded text-white/40 bg-white/5 border border-white/10">
                  {currentQIdx + 1}/{totalQuestions}
                </span>
              )}
              <button
                onClick={onSkip}
                className="p-1 rounded-md text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
                title="Skip (Esc)"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Options */}
          <div className="px-3 pb-2 space-y-1">
            {q.options.map((opt, optIdx) => {
              const isSelected = selected.includes(opt.label);
              const isFocused = focusedIdx === optIdx;
              return (
                <button
                  key={optIdx}
                  onClick={() => handleSelect(opt.label)}
                  onMouseEnter={() => setFocusedIdx(optIdx)}
                  className="w-full text-left transition-all duration-100"
                >
                  <div
                    className={`
                      flex items-center gap-3 px-3 py-2 rounded-lg border transition-all duration-100
                      ${isFocused
                        ? 'border-white/15 bg-white/[0.04]'
                        : 'border-transparent bg-transparent hover:bg-white/[0.03]'
                      }
                    `}
                  >
                    {/* Number badge */}
                    <span className={`
                      shrink-0 w-5 h-5 rounded-md text-[11px] font-medium flex items-center justify-center transition-all
                      ${isSelected
                        ? 'bg-blue-500 text-white'
                        : 'bg-white/8 text-white/40'
                      }
                    `}>
                      {isSelected ? <Check size={11} strokeWidth={3} /> : optIdx + 1}
                    </span>

                    <div className="flex-1 min-w-0">
                      <span className={`text-sm ${isSelected ? 'text-white/90 font-medium' : 'text-white/70'}`}>
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="text-xs text-white/30 ml-2">{opt.description}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* "Something else" option */}
            <button
              onClick={handleCustomToggle}
              onMouseEnter={() => setFocusedIdx(q.options.length)}
              className="w-full text-left transition-all duration-100"
            >
              <div
                className={`
                  flex items-center gap-3 px-3 py-2 rounded-lg border transition-all duration-100
                  ${focusedIdx === q.options.length
                    ? 'border-white/15 bg-white/[0.04]'
                    : 'border-transparent bg-transparent hover:bg-white/[0.03]'
                  }
                `}
              >
                <span className={`
                  shrink-0 w-5 h-5 rounded-md flex items-center justify-center transition-all
                  ${showCustom[currentQIdx] ? 'bg-blue-500 text-white' : 'bg-white/8 text-white/40'}
                `}>
                  <Pencil size={11} />
                </span>
                <span className={`text-sm ${showCustom[currentQIdx] ? 'text-blue-300 font-medium' : 'text-white/40'}`}>
                  Something else
                </span>
              </div>
            </button>

            {/* Custom text input */}
            {showCustom[currentQIdx] && (
              <div className="px-3 pb-1">
                <input
                  ref={customInputRef}
                  type="text"
                  placeholder="Type your answer..."
                  value={customInputs[currentQIdx] || ''}
                  onChange={(e) => setCustomInputs(prev => ({ ...prev, [currentQIdx]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSubmitCurrent) {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSubmit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      onSkip();
                    }
                  }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-white/10 bg-white/[0.03] text-white/80 placeholder-white/30 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
                />
              </div>
            )}
          </div>

          {/* Footer controls */}
          <div className="input-controls">
            <div className="input-controls-left">
              <span className="text-[11px] text-white/25 select-none">
                ↑ ↓ to navigate · Enter to select · Esc to skip
              </span>
            </div>
            <div className="input-controls-right">
              <button
                onClick={onSkip}
                className="px-3 py-1.5 text-xs font-medium text-white/40 hover:text-white/60 transition-colors rounded-md hover:bg-white/5"
              >
                Skip
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmitCurrent}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  canSubmitCurrent
                    ? 'bg-blue-500 text-white hover:bg-blue-400 cursor-pointer'
                    : 'bg-white/5 text-white/20 cursor-not-allowed'
                }`}
              >
                {currentQIdx < totalQuestions - 1 ? 'Next' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
