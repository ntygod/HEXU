import { DomainError, record, revision } from './index.js';

export type TaskContentField = 'title' | 'description' | 'attention';
export interface TaskContentRevision {
  taskId: string;
  revision: number;
  title: string;
  description: string;
  attention: string | null;
  actorId: string | null;
  actorName: string | null;
  savedAt: string | null;
  source: 'created' | 'edited' | 'adopted' | 'status' | 'legacy';
  changedFields: TaskContentField[];
}
export interface TaskContentHistory {
  items: TaskContentRevision[];
  nextCursor: number | null;
}
export function parseTaskContentHistoryQuery(value: unknown) {
  const body = record(value);
  if (Object.keys(body).some((key) => !['before', 'limit'].includes(key)))
    throw new DomainError('INVALID_INPUT', '不支持的工作说明历史查询参数');
  const number = (value: unknown) => {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
      throw new DomainError('INVALID_INPUT', '工作说明历史查询需要正整数');
    return revision(Number(value));
  };
  const limit = body.limit === undefined ? 10 : number(body.limit);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条工作说明历史');
  return { limit, before: body.before === undefined ? null : number(body.before) };
}
