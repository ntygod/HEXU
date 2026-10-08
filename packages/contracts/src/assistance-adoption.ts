import { DomainError, enumValue, record, revision, text } from './index.js';
import {
  parseDraftRanges,
  type DraftRange,
  type DraftTarget,
  type DraftAdoption,
} from './ai-drafts.js';
import {
  selectedAssistanceText,
  type AssistanceReply,
  type AssistanceSnapshot,
} from './assistance.js';

export interface AssistanceAdoptionSource {
  /** Authenticated external answer provenance; never a fabricated successful Run. */
  external?: {
    requestId: string;
    response: import('./agent-assistance.js').AgentAssistanceResponseRecord;
  };
  assistanceId: string;
  assistanceRevision: number;
  snapshotHash: string;
  snapshot: AssistanceSnapshot;
  question: string;
  sourceChanged: boolean | null;
  reply: AssistanceReply;
  replyHash: string;
}
export interface AssistanceAdoptionPreview {
  source: AssistanceAdoptionSource;
  target: DraftTarget;
  canAdopt: boolean;
}
export interface AssistanceAdoptionInput {
  replyId: string;
  expectedAssistanceRevision: number;
  expectedSnapshotHash: string;
  expectedReplyHash: string;
  expectedTaskRevision: number;
  ranges: DraftRange[];
  mode: 'append' | 'replace';
}
export interface AssistanceAdoption {
  id: string;
  taskId: string;
  source: AssistanceAdoptionSource;
  ranges: DraftRange[];
  selectedText: string;
  mode: AssistanceAdoptionInput['mode'];
  target: DraftAdoption['target'];
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
}
export interface AssistanceAdoptionPage {
  items: AssistanceAdoption[];
  nextCursor: string | null;
}
export function parseAssistanceAdoption(input: unknown): AssistanceAdoptionInput {
  const b = record(input);
  const allowed = [
    'replyId',
    'expectedAssistanceRevision',
    'expectedSnapshotHash',
    'expectedReplyHash',
    'expectedTaskRevision',
    'ranges',
    'mode',
  ];
  if (Object.keys(b).some((k) => !allowed.includes(k)))
    throw new DomainError('INVALID_INPUT', '采用请求包含不支持的字段');
  const hash = (v: unknown) => {
    const h = text(v, '建议版本', 64);
    if (!/^[a-f0-9]{64}$/.test(h))
      throw new DomainError('INVALID_INPUT', '建议版本无效，请重新查看');
    return h;
  };
  return {
    replyId: text(b.replyId, '建议回复', 150),
    expectedAssistanceRevision: revision(b.expectedAssistanceRevision),
    expectedSnapshotHash: hash(b.expectedSnapshotHash),
    expectedReplyHash: hash(b.expectedReplyHash),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    ranges: parseDraftRanges(b.ranges),
    mode: enumValue(b.mode, ['append', 'replace'] as const, '采用方式'),
  };
}
/** Preserve the saved reply verbatim, including CRLF. Reject split pairs and CRLF boundaries. */
export function selectedAssistanceSuggestion(body: string, ranges: DraftRange[]): string {
  return parseDraftRanges(ranges)
    .map((range) => selectedAssistanceText(body, range))
    .join('\n\n');
}
