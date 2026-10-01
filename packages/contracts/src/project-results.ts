import { DomainError, revision, type Result, type Task } from './index.js';
import { exact, nodeId } from './nodes.js';

export const PROJECT_RESULT_EXCERPT_LENGTH = 160;

/** One fixed version per Result, with only the fields needed by a project card. */
export interface ProjectResultSummary {
  id: string;
  revisionId: string;
  revision: number;
  title: string;
  kind: Result['kind'];
  /** At most 160 Unicode code points. First NUL becomes U+FFFD; later text is omitted. */
  excerpt: string;
  excerptTruncated: boolean;
  savedAt: string;
  task: Pick<Task, 'id' | 'shortId' | 'title' | 'status'>;
}
export interface ProjectResultPage {
  projectId: string;
  items: ProjectResultSummary[];
  nextCursor: string | null;
}
export interface ProjectResultListQuery {
  cursor: string | null;
  limit: number;
}

export function parseProjectResultListQuery(value: unknown): ProjectResultListQuery {
  const query = exact(value, ['cursor', 'limit']);
  if (
    query.limit !== undefined &&
    (typeof query.limit !== 'string' || !/^[1-9]\d*$/.test(query.limit))
  )
    throw new DomainError('INVALID_INPUT', '成果分页需要正整数');
  const limit = query.limit === undefined ? 20 : revision(Number(query.limit));
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条成果');
  const cursor = query.cursor === undefined ? null : nodeId(query.cursor, '成果游标');
  if (cursor !== null && cursor !== query.cursor)
    throw new DomainError('INVALID_INPUT', '成果游标格式不正确');
  return { cursor, limit };
}
