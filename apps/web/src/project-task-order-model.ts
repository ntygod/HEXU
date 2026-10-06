import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  ProjectTaskMove,
  ProjectTaskMoveReceipt,
  ProjectTaskOrder,
} from '../../../packages/contracts/src/project-task-order.js';

const baselinePattern = /^[a-f0-9]{64}$/;
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

/** An absent, duplicate or foreign ID is not a usable current project order. */
export function isCurrentProjectTaskOrder(
  value: unknown,
  projectId: string,
  tasks: readonly Pick<Task, 'id' | 'projectId'>[],
): value is ProjectTaskOrder {
  if (!value || typeof value !== 'object') return false;
  const order = value as ProjectTaskOrder;
  const ids = new Set(tasks.map((task) => task.id));
  return (
    order.projectId === projectId &&
    revision(order.revision) &&
    typeof order.baseline === 'string' &&
    baselinePattern.test(order.baseline) &&
    Array.isArray(order.taskIds) &&
    tasks.length === ids.size &&
    order.taskIds.length === ids.size &&
    new Set(order.taskIds).size === ids.size &&
    tasks.every((task) => task.projectId === projectId) &&
    order.taskIds.every((id) => typeof id === 'string' && ids.has(id))
  );
}

export function isProjectTaskMoveReceipt(
  value: unknown,
  projectId: string,
  body: ProjectTaskMove,
): value is ProjectTaskMoveReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as ProjectTaskMoveReceipt;
  return (
    receipt.projectId === projectId &&
    receipt.taskId === body.taskId &&
    receipt.anchorTaskId === body.anchorTaskId &&
    receipt.placement === body.placement &&
    typeof receipt.changed === 'boolean' &&
    revision(receipt.revision) &&
    receipt.revision === body.expectedRevision + (receipt.changed ? 1 : 0) &&
    typeof receipt.baseline === 'string' &&
    baselinePattern.test(receipt.baseline) &&
    (receipt.changed || receipt.baseline === body.expectedBaseline)
  );
}

/** Only the project views consume this projection; the original Task array is untouched. */
export function orderedProjectTasks(tasks: readonly Task[], order: ProjectTaskOrder): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return order.taskIds.flatMap((id) => {
    const task = byId.get(id);
    return task ? [task] : [];
  });
}

export function projectMoveAnchors(tasks: readonly Task[], task: Task, view: string): Task[] {
  return tasks.filter(
    (candidate) =>
      candidate.id !== task.id &&
      candidate.projectId === task.projectId &&
      candidate.status !== 'cancelled' &&
      (view !== 'board' || candidate.status === task.status),
  );
}
