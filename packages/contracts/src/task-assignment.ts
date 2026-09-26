import { DomainError, record, revision, text, type Task } from './index.js';

export interface TaskAssignmentInput {
  expectedRevision: number;
  ownerUserId: string;
}
export interface AssignmentPerson {
  id: string;
  name: string;
}
export interface TaskAssignmentOptions {
  taskId: string;
  revision: number;
  owner: { id: string; name: string | null; availability: 'available' | 'read_only' | 'removed' };
  candidates: AssignmentPerson[];
}
export interface TaskAssignmentEvent {
  taskId: string;
  revision: number;
  fromUserId: string;
  fromName: string | null;
  toUserId: string;
  toName: string;
  actorId: string;
  actorName: string;
  createdAt: string;
}
export interface TaskAssignmentHistory {
  items: TaskAssignmentEvent[];
  nextCursor: number | null;
}
export function parseTaskAssignment(value: unknown): TaskAssignmentInput {
  const b = record(value);
  if (Object.keys(b).some((key) => !['expectedRevision', 'ownerUserId'].includes(key)))
    throw new DomainError('INVALID_INPUT', '改派只接受负责人和任务修订号');
  return {
    expectedRevision: revision(b.expectedRevision),
    ownerUserId: text(b.ownerUserId, '负责人', 100),
  };
}
export function parseAssignmentHistoryQuery(value: unknown) {
  const b = record(value);
  if (Object.keys(b).some((key) => !['before', 'limit'].includes(key)))
    throw new DomainError('INVALID_INPUT', '不支持的改派记录查询参数');
  const number = (value: unknown) => {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
      throw new DomainError('INVALID_INPUT', '改派记录查询需要正整数');
    return revision(Number(value));
  };
  const limit = b.limit === undefined ? 10 : number(b.limit);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条改派记录');
  return { limit, before: b.before === undefined ? null : number(b.before) };
}
// A reassignment returns the existing Task, never a Run or an access grant.
export type TaskAssignmentResult = Task;
