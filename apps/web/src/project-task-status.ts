import type { TaskStatus } from '../../../packages/contracts/src/index.js';

export type ProjectTaskStatusSelection =
  | { kind: 'default' }
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'invalid' };

const defaultStatuses = ['todo', 'in_progress', 'done'] as const;

/** This UI selection only narrows Tasks already visible in the project. */
export function parseProjectTaskStatus(query: URLSearchParams): ProjectTaskStatusSelection {
  const values = query.getAll('status');
  if (!values.length) return { kind: 'default' };
  if (values.length !== 1) return { kind: 'invalid' };
  const status = values[0];
  if (
    status === 'todo' ||
    status === 'in_progress' ||
    status === 'done' ||
    status === 'cancelled'
  ) {
    return { kind: 'status', status };
  }
  return { kind: 'invalid' };
}

export function matchesProjectTaskStatus(
  task: { status: TaskStatus },
  selection: ProjectTaskStatusSelection,
): boolean {
  if (selection.kind === 'invalid') return false;
  if (selection.kind === 'default') return task.status !== 'cancelled';
  return task.status === selection.status;
}

export function projectTaskStatusColumns(
  selection: ProjectTaskStatusSelection,
): readonly TaskStatus[] {
  if (selection.kind === 'invalid') return [];
  if (selection.kind === 'default') return defaultStatuses;
  return [selection.status];
}
