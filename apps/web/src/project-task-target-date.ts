import type { TaskStatus } from '../../../packages/contracts/src/index.js';
import { isValidTaskTargetDate } from '../../../packages/contracts/src/task-target-date.js';

export type ProjectTaskTargetDate = 'present' | 'absent' | 'today' | 'overdue';

export type ProjectTaskTargetDateSelection =
  | { kind: 'default' }
  | { kind: 'targetDate'; targetDate: ProjectTaskTargetDate }
  | { kind: 'invalid' };

type DatedTask = { targetDate?: string | null; status: TaskStatus };

/** Calendar dates are compared as dates in the viewer's local calendar, never UTC instants. */
export function localCalendarDate(date: Date = new Date()): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Using local midnight preserves 23/25-hour days and month/year transitions. */
export function millisecondsUntilNextLocalDay(date: Date = new Date()): number {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return Math.max(1, next.getTime() - date.getTime());
}

export function isTaskTargetDateOverdue(task: DatedTask, today: string): boolean {
  return (
    (task.status === 'todo' || task.status === 'in_progress') &&
    isValidTaskTargetDate(task.targetDate) &&
    isValidTaskTargetDate(today) &&
    task.targetDate < today
  );
}

/** This selection only narrows the Tasks already visible in the current project. */
export function parseProjectTaskTargetDate(query: URLSearchParams): ProjectTaskTargetDateSelection {
  const values = query.getAll('targetDate');
  if (!values.length) return { kind: 'default' };
  if (values.length !== 1) return { kind: 'invalid' };
  const targetDate = values[0];
  if (
    targetDate === 'present' ||
    targetDate === 'absent' ||
    targetDate === 'today' ||
    targetDate === 'overdue'
  ) {
    return { kind: 'targetDate', targetDate };
  }
  return { kind: 'invalid' };
}

export function matchesProjectTaskTargetDate(
  task: DatedTask,
  selection: ProjectTaskTargetDateSelection,
  today: string,
): boolean {
  if (selection.kind === 'invalid') return false;
  if (selection.kind === 'default') return true;
  switch (selection.targetDate) {
    case 'present':
      return isValidTaskTargetDate(task.targetDate);
    case 'absent':
      return task.targetDate == null;
    case 'today':
      return isValidTaskTargetDate(task.targetDate) && task.targetDate === today;
    case 'overdue':
      return isTaskTargetDateOverdue(task, today);
  }
}
