import { DomainError, revision, type Task } from './index.js';
import { exact, nodeId } from './nodes.js';

export const INCOMING_HANDOFF_CURSOR_MAX_LENGTH = 512;
export const INCOMING_HANDOFF_SUMMARY_MAX_LENGTH = 4000;
export const INCOMING_HANDOFF_REMAINING_WORK_MAX_LENGTH = 4000;
export const INCOMING_HANDOFF_ENVIRONMENT_MAX_LENGTH = 2000;

/** Recipient discovery only. Authored notes convey no material or execution permission. */
export interface IncomingHandoffSummary {
  id: string;
  task: Pick<Task, 'id' | 'shortId' | 'title'> & { projectId: string };
  /** Current visible space member, or null if their identity is no longer visible. */
  sender: { id: string; name: string } | null;
  summary: string;
  remainingWork: string;
  environment: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface IncomingHandoffPage {
  items: IncomingHandoffSummary[];
  nextCursor: string | null;
}
export interface IncomingHandoffListQuery {
  cursor: string | null;
  limit: number;
}

export function invalidIncomingHandoffCursor(): DomainError {
  return new DomainError('INVALID_CURSOR', '邀请列表位置已无效，请刷新列表', 409);
}
export function parseIncomingHandoffListQuery(value: unknown): IncomingHandoffListQuery {
  const query = exact(value, ['cursor', 'limit']);
  if (
    query.limit !== undefined &&
    (typeof query.limit !== 'string' || !/^[1-9]\d*$/.test(query.limit))
  )
    throw new DomainError('INVALID_INPUT', '邀请分页需要正整数');
  const limit = query.limit === undefined ? 20 : revision(Number(query.limit));
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条邀请');
  const cursor = query.cursor === undefined ? null : query.cursor;
  if (
    query.cursor === null ||
    (cursor !== null &&
      (typeof cursor !== 'string' ||
        cursor.length > INCOMING_HANDOFF_CURSOR_MAX_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(cursor)))
  )
    throw invalidIncomingHandoffCursor();
  return { cursor, limit };
}
export function parseIncomingHandoffTarget(value: unknown, query: unknown) {
  exact(query, []);
  const params = exact(value, ['targetTaskId', 'handoffId']);
  const taskId = nodeId(params.targetTaskId, '任务标识');
  const handoffId = nodeId(params.handoffId, '邀请标识');
  if (taskId !== params.targetTaskId || handoffId !== params.handoffId)
    throw new DomainError('INVALID_INPUT', '接手邀请地址格式不正确');
  return { taskId, handoffId };
}
