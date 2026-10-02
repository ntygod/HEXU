import { DomainError, record } from './index.js';

/** An existing completion event, not a reconstructed Task or Run transition. */
export interface TaskCompletionEvent {
  id: string;
  taskId: string;
  actorId: string;
  /** Currently visible member name; no historical name was recorded with this event. */
  actorName: string | null;
  /** Preserve the recorded value, including any unrecognized legacy action. */
  action: string;
  taskRevision: number;
  createdAt: string;
}
export interface TaskCompletionHistory {
  items: TaskCompletionEvent[];
  nextCursor: string | null;
}
export interface TaskCompletionHistoryQuery {
  limit: number;
  before: string | null;
}

export function parseTaskCompletionHistoryQuery(value: unknown): TaskCompletionHistoryQuery {
  const query = record(value);
  if (Object.keys(query).some((key) => !['before', 'limit'].includes(key)))
    throw new DomainError('INVALID_INPUT', '不支持的完成记录查询参数');
  if (
    query.limit !== undefined &&
    (typeof query.limit !== 'string' || !/^[1-9]\d*$/.test(query.limit))
  )
    throw new DomainError('INVALID_INPUT', '完成记录每次读取条数需为 1–50 的整数');
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit > 50)
    throw new DomainError('INVALID_INPUT', '完成记录每次读取条数需为 1–50 的整数');
  if (
    query.before !== undefined &&
    (typeof query.before !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(query.before))
  )
    throw new DomainError('INVALID_INPUT', '完成记录位置需要有效的记录标识');
  return { limit, before: (query.before as string | undefined) ?? null };
}
