import type { Task } from '../../../packages/contracts/src/index.js';

export type WorkbenchTaskScope = 'mine' | 'participating' | 'team';

export function matchesWorkbenchTaskScope(
  task: Pick<Task, 'ownerUserId' | 'participantUserIds' | 'visibility'>,
  scope: WorkbenchTaskScope,
  userId: string,
): boolean {
  if (scope === 'mine') return task.ownerUserId === userId;
  if (scope === 'participating') return task.participantUserIds?.includes(userId) ?? false;
  return task.visibility === 'project';
}
