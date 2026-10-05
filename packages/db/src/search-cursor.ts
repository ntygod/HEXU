import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import { canonicalJson } from '../../domain/src/index.js';

type AnchorField = 'afterTaskId' | 'afterResultId';
interface Cursor {
  v: 1;
  queryHash: string;
  sequenceHash: string;
  afterId: string;
}
const pageSize = 30;
export const searchHash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalidCursor = () => new DomainError('INVALID_CURSOR', '搜索游标无效，请重新搜索');

function decodeCursor(cursor: string, anchorField: AnchorField): Cursor {
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== cursor) throw invalidCursor();
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor();
    const decoded = value as Record<string, unknown>;
    const afterId = decoded[anchorField];
    if (
      Object.keys(decoded).length !== 4 ||
      decoded.v !== 1 ||
      typeof decoded.queryHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decoded.queryHash) ||
      typeof decoded.sequenceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decoded.sequenceHash) ||
      typeof afterId !== 'string' ||
      !afterId.trim() ||
      afterId.length > 150
    )
      throw invalidCursor();
    return { v: 1, queryHash: decoded.queryHash, sequenceHash: decoded.sequenceHash, afterId };
  } catch {
    throw invalidCursor();
  }
}

/** Bounded bookmarks over one current matching projection; never a retained snapshot. */
export function pageSearchItems<T extends { id: string }>(
  matches: readonly T[],
  queryHash: string,
  rawCursor: string | null,
  anchorField: AnchorField,
): { items: T[]; nextCursor: string | null } {
  const sequenceHash = searchHash(canonicalJson(matches));
  let start = 0;
  if (rawCursor !== null) {
    const cursor = decodeCursor(rawCursor, anchorField);
    if (cursor.queryHash !== queryHash) throw invalidCursor();
    if (cursor.sequenceHash !== sequenceHash)
      throw new DomainError('SEARCH_RESULTS_CHANGED', '搜索结果已变化，请重新搜索', 409);
    const anchor = matches.findIndex((item) => item.id === cursor.afterId);
    if (anchor < 0) throw invalidCursor();
    start = anchor + 1;
  }
  const items = matches.slice(start, start + pageSize);
  const cursor =
    start + items.length < matches.length
      ? { v: 1, queryHash, sequenceHash, [anchorField]: items.at(-1)!.id }
      : null;
  return {
    items,
    nextCursor: cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null,
  };
}
