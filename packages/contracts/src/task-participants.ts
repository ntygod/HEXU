import { DomainError, enumValue, record, revision, text } from './index.js';
import type { ProjectRole } from './identity.js';

export type ParticipationState = 'active' | 'left' | 'removed' | 'access_revoked';
export interface ParticipantPerson {
  id: string;
  name: string;
  role: ProjectRole;
}
export interface TaskParticipant {
  id: string;
  name: string;
  state: ParticipationState;
  available: boolean;
  role: ProjectRole | null;
  updatedAt: string;
}
export interface TaskParticipantsView {
  taskId: string;
  /** Version of participation only, independent of Task/model-material revision. */
  revision: number;
  canManage: boolean;
  participants: TaskParticipant[];
  candidates: ParticipantPerson[];
}
export interface ParticipantChange {
  expectedRevision: number;
  action: 'add' | 'remove';
  userId: string;
}
export interface ParticipantReceipt {
  taskId: string;
  revision: number;
}
export interface ParticipantEvent {
  taskId: string;
  revision: number;
  userId: string;
  name: string;
  action: 'joined' | 'added' | 'left' | 'removed' | 'access_revoked';
  actorId: string;
  actorName: string;
  createdAt: string;
}
export interface ParticipantHistory {
  items: ParticipantEvent[];
  nextCursor: number | null;
}
export interface TaskPeopleFilters {
  q?: string;
  ownerUserId?: string;
  participantUserId?: string;
}
export interface ProjectTaskPeople {
  owners: { id: string; name: string; availability: 'available' | 'read_only' | 'removed' }[];
  participants: ParticipantPerson[];
}
export function parseParticipantChange(value: unknown): ParticipantChange {
  const body = record(value);
  if (Object.keys(body).some((key) => !['expectedRevision', 'action', 'userId'].includes(key)))
    throw new DomainError('INVALID_INPUT', '参与关系只接受成员、加入/退出操作和参与修订号');
  return {
    expectedRevision: revision(body.expectedRevision),
    action: enumValue(body.action, ['add', 'remove'] as const, '参与操作'),
    userId: text(body.userId, '参与成员', 100),
  };
}
export function parseParticipantHistoryQuery(value: unknown) {
  const query = record(value);
  if (Object.keys(query).some((key) => !['before', 'limit'].includes(key)))
    throw new DomainError('INVALID_INPUT', '不支持的参与记录查询参数');
  const number = (value: unknown) => {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
      throw new DomainError('INVALID_INPUT', '参与记录查询需要正整数');
    return revision(Number(value));
  };
  const limit = query.limit === undefined ? 10 : number(query.limit);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条参与记录');
  return { limit, before: query.before === undefined ? null : number(query.before) };
}
/** Parse these filters without changing existing project/cursor/limit query semantics. */
export function parseTaskPeopleFilters(value: unknown): TaskPeopleFilters {
  const query = record(value);
  const optional = (value: unknown, label: string, max: number) =>
    value === undefined || (typeof value === 'string' && value.trim() === '')
      ? undefined
      : text(value, label, max);
  return {
    q: optional(query.q, '搜索', 160),
    ownerUserId: optional(query.ownerUserId, '负责人', 100),
    participantUserId: optional(query.participantUserId, '参与者', 100),
  };
}
