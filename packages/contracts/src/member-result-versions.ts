import { revision, text } from './index.js';
import { exact, nodeId } from './nodes.js';
import type { ResultRevision } from './results.js';

export interface MemberResultVersionInput {
  expectedRevision: number;
  expectedRevisionId: string;
  title: string;
  body: string;
}

export type MemberResultVersionPreview =
  | { available: true; version: ResultRevision }
  | { available: false; reason: string };

/** A receipt always identifies the version created by this explicit request. */
export interface MemberResultVersionReceipt {
  resultId: string;
  revisionId: string;
  revision: number;
}

export function parseMemberResultVersion(input: unknown): MemberResultVersionInput {
  const body = exact(input, ['expectedRevision', 'expectedRevisionId', 'title', 'body']);
  return {
    expectedRevision: revision(body.expectedRevision),
    expectedRevisionId: nodeId(body.expectedRevisionId, '原成果版本'),
    title: text(body.title, '成果标题', 160),
    body: text(body.body, '成果说明', 12000),
  };
}
