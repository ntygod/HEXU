import { DomainError, enumValue, text } from './index.js';
import { exact } from './nodes.js';

export const RESULT_REFERENCE_LIMIT = 20;

export interface AddResultReferenceInput {
  kind: 'report' | 'release';
  title: string;
  url: string;
  environment?: string;
  sourceNote?: string;
}

/** A member's link to one fixed version, with no observation of its external state. */
export interface ResultReference {
  id: string;
  resultId: string;
  resultRevisionId: string;
  taskId: string;
  kind: AddResultReferenceInput['kind'];
  title: string;
  url: string;
  environment: string | null;
  sourceNote: string | null;
  source: 'manual';
  externalState: 'unknown';
  availability: 'not_checked';
  recordedBy: { id: string; name: string };
  recordedAt: string;
  removedAt: string | null;
  removedBy: { id: string; name: string } | null;
}

export interface ResultReferenceList {
  items: ResultReference[];
  limit: number;
}

function plainText(value: unknown, label: string, max: number, optional = false) {
  const result = text(value, label, max, optional);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result))
    throw new DomainError('INVALID_INPUT', `${label}不能包含控制字符`);
  return result;
}

export function parseAddResultReference(input: unknown): AddResultReferenceInput {
  const body = exact(input, ['kind', 'title', 'url', 'environment', 'sourceNote']);
  const url = text(body.url, '外部链接', 2048);
  if (!/^https?:\/\/[^/?#\\\s]+/i.test(url) || /[\s\\\p{Cc}]/u.test(url))
    throw new DomainError('INVALID_INPUT', '外部链接必须是完整的 HTTP(S) 地址');
  try {
    const parsed = new URL(url);
    if (!parsed.hostname || parsed.username || parsed.password)
      throw new Error('Invalid external link');
  } catch {
    throw new DomainError('INVALID_INPUT', '外部链接必须是有效且不含账号密码的 HTTP(S) 地址');
  }
  return {
    kind: enumValue(body.kind, ['report', 'release'] as const, '关联种类'),
    title: plainText(body.title, '链接标题', 160),
    url,
    ...(body.environment === undefined
      ? {}
      : { environment: plainText(body.environment, '环境', 120, true) }),
    ...(body.sourceNote === undefined
      ? {}
      : { sourceNote: plainText(body.sourceNote, '来源说明', 1000, true) }),
  };
}

export function parseRemoveResultReference(input: unknown) {
  exact(input, []);
  return {};
}
