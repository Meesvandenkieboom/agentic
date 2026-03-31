/**
 * Event bus for AskUserQuestion answers.
 * Uses CustomEvents on window to communicate from deeply nested
 * message components back to ChatContainer where sendMessage lives.
 */

export const QUESTION_ANSWER_EVENT = 'agentic:question-answer';

export interface QuestionAnswerDetail {
  toolId: string;
  answers: Record<string, string>;
}

export function dispatchQuestionAnswer(toolId: string, answers: Record<string, string>): void {
  window.dispatchEvent(
    new CustomEvent<QuestionAnswerDetail>(QUESTION_ANSWER_EVENT, {
      detail: { toolId, answers },
    })
  );
}
