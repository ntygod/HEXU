import { DomainError, record, revision } from './index.js';

export const TASK_LABEL_LIMIT = 16;
export const TASK_LABEL_LENGTH = 32;
export interface TaskLabelsChange {
  expectedRevision: number;
  labels: string[];
}
export interface TaskLabelsReceipt {
  taskId: string;
  revision: number;
  labels: string[];
}
export interface TaskLabelsView extends TaskLabelsReceipt {
  canEdit: boolean;
}
/** Label identity is case-sensitive, trimmed NFC text. No project-wide rename semantics. */
export function parseTaskLabel(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > TASK_LABEL_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new DomainError('INVALID_INPUT', '标签需为不含控制字符的 1–32 字文本');
  const label = value.trim().normalize('NFC');
  if (!label || label.length > TASK_LABEL_LENGTH)
    throw new DomainError('INVALID_INPUT', '标签需为 1–32 字文本');
  return label;
}
export function parseTaskLabelsChange(value: unknown): TaskLabelsChange {
  const body = record(value);
  if (Object.keys(body).some((key) => !['expectedRevision', 'labels'].includes(key)))
    throw new DomainError('INVALID_INPUT', '标签只接受标签集合和标签修订号');
  if (!Array.isArray(body.labels) || body.labels.length > TASK_LABEL_LIMIT)
    throw new DomainError('INVALID_INPUT', '每项任务最多保存 16 个标签');
  const labels = body.labels.map(parseTaskLabel).sort();
  if (new Set(labels).size !== labels.length)
    throw new DomainError('INVALID_INPUT', '同一任务不能重复保存相同标签');
  return { expectedRevision: revision(body.expectedRevision), labels };
}
