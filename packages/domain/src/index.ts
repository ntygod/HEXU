import {
  DomainError,
  type RunState,
  type Task,
  type TaskStatus,
} from '../../contracts/src/index.js';
import type { TaskPeopleFilters } from '../../contracts/src/task-participants.js';
export function matchesTaskPeopleFilters(task: Task, filters: TaskPeopleFilters): boolean {
  if (filters.ownerUserId && task.ownerUserId !== filters.ownerUserId) return false;
  if (filters.participantUserId && !task.participantUserIds?.includes(filters.participantUserId))
    return false;
  const query = filters.q?.trim().toLocaleLowerCase();
  return (
    !query ||
    `${task.title} ${task.shortId} ${task.description}`.toLocaleLowerCase().includes(query)
  );
}
export const activeRunStates: readonly RunState[] = [
  'queued',
  'preparing',
  'running',
  'waiting_input',
  'waiting_approval',
  'stopping',
];
export const isActiveRun = (state: RunState) => activeRunStates.includes(state);
const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'cancelled'],
  preparing: ['running', 'failed', 'stopping'],
  running: ['waiting_input', 'waiting_approval', 'stopping', 'succeeded', 'failed'],
  waiting_input: ['running', 'stopping', 'failed'],
  waiting_approval: ['running', 'stopping', 'failed'],
  stopping: ['cancelled', 'succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};
export function assertRunTransition(from: RunState, to: RunState) {
  if (from !== to && !transitions[from].includes(to))
    throw new DomainError('INVALID_TRANSITION', `执行不能从 ${from} 变为 ${to}`, 409);
}
export function assertRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw new DomainError('REVISION_CONFLICT', '内容已被更新，请刷新后重试', 409);
}
export function assertTaskChange(task: Task, next: TaskStatus) {
  if (task.status === 'cancelled' && next !== 'todo')
    throw new DomainError('INVALID_TRANSITION', '已取消的任务需要先重新打开', 409);
}
export function canReadTask(task: Task, actorId: string, spaceId: string) {
  return (
    task.spaceId === spaceId && (task.visibility === 'project' || task.ownerUserId === actorId)
  );
}
// Stable request fingerprints make idempotency independent of JSON property order.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => JSON.stringify(key) + ':' + canonicalJson(entry))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
