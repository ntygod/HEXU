import { text } from './index.js';
import { exact } from './nodes.js';
import type { ResultCodeFeedbackAnchor } from './result-code-feedback.js';

/** Immutable provenance. The edited requirement is stored separately in NextInput.body. */
export interface ResultFeedbackInputOrigin {
  version: 1;
  kind: 'result_feedback';
  resultId: string;
  resultRevisionId: string;
  resultRevision: number;
  messageId: string;
  branchId: string;
  branchName: string;
  groupId: string;
  sourceRunId: string;
  authorName: string;
  authorId?: string;
  body: string;
  bodyHash: string;
  codeAnchor?: ResultCodeFeedbackAnchor;
}
export type ResultFeedbackInputPreview =
  | { available: true; taskId: string; origin: ResultFeedbackInputOrigin }
  | { available: false; reason: string };

export function parseResultFeedbackInput(input: unknown) {
  const b = exact(input, ['body']);
  return { body: text(b.body, '下一轮要求', 2000) };
}
