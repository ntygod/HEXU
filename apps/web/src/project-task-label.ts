import { DomainError } from '../../../packages/contracts/src/index.js';
import { parseTaskLabel } from '../../../packages/contracts/src/task-labels.js';

export type ProjectTaskLabelSelection =
  | { kind: 'default' }
  | { kind: 'label'; label: string }
  | { kind: 'invalid' };

/** Invalid label links must never silently broaden the current task list. */
export function parseProjectTaskLabel(query: URLSearchParams): ProjectTaskLabelSelection {
  const values = query.getAll('label');
  if (!values.length) return { kind: 'default' };
  if (values.length !== 1) return { kind: 'invalid' };
  try {
    return { kind: 'label', label: parseTaskLabel(values[0]) };
  } catch (cause) {
    if (cause instanceof DomainError) return { kind: 'invalid' };
    throw cause;
  }
}
