import { text, type Task } from './index.js';
import { exact } from './nodes.js';
import type { ResultCodeFeedbackAnchor } from './result-code-feedback.js';

export interface ResultFeedbackFollowUpInput {
  title: string;
  description: string;
}

/** Immutable provenance, separate from the user's editable Task title and description. */
export interface ResultFeedbackFollowUpOrigin {
  version: 1;
  kind: 'result_feedback';
  sourceTaskId: string;
  sourceTaskShortId: string;
  sourceTaskTitle: string;
  resultId: string;
  resultRevisionId: string;
  resultRevision: number;
  resultTitle: string;
  messageId: string;
  authorName: string;
  /** Absent when the original message did not record an explicit author. */
  authorId?: string;
  body: string;
  bodyHash: string;
  codeAnchor?: ResultCodeFeedbackAnchor;
}

export interface ResultFeedbackFollowUpTarget {
  spaceId: string;
  projectId: string | null;
  projectName: string | null;
  visibility: 'private' | 'project';
  ownerUserId: string;
  ownerName: string;
}

export type ResultFeedbackFollowUpPreview =
  | {
      available: true;
      origin: ResultFeedbackFollowUpOrigin;
      target: ResultFeedbackFollowUpTarget;
    }
  | { available: false; reason: string };

export type ResultFeedbackFollowUpSummary = Pick<
  Task,
  'id' | 'shortId' | 'title' | 'status' | 'ownerUserId' | 'createdAt'
>;
export interface ResultFeedbackFollowUpList {
  items: ResultFeedbackFollowUpSummary[];
  /** At most 50 currently accessible Tasks, newest first. */
  truncated: boolean;
}

export function parseResultFeedbackFollowUp(input: unknown): ResultFeedbackFollowUpInput {
  const body = exact(input, ['title', 'description']);
  return {
    title: text(body.title, '任务标题', 160),
    description: text(body.description, '说明', 12000, true),
  };
}
