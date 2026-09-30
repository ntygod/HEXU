import { text } from './index.js';
import { exact } from './nodes.js';

export interface ResultFeedbackReplyInput {
  body: string;
}

/** Immutable, server-derived display snapshot of the directly referenced feedback. */
export interface ResultFeedbackReplyTarget {
  messageId: string;
  actorName: string;
  /** Absent when the source message did not record an explicit author. */
  createdByUserId?: string;
  bodyPreview: string;
  bodyTruncated: boolean;
}

export function parseResultFeedbackReply(input: unknown): ResultFeedbackReplyInput {
  const body = exact(input, ['body']);
  return { body: text(body.body, '回复', 12000) };
}
