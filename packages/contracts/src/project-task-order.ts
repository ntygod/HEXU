import { DomainError, enumValue, record, revision, text } from './index.js';

export interface ProjectTaskOrder {
  projectId: string;
  /** Independent ordering revision; an untouched project has virtual revision 1. */
  revision: number;
  /** Opaque baseline of the current readable IDs, their order and status. */
  baseline: string;
  taskIds: string[];
}

export interface ProjectTaskMove {
  taskId: string;
  anchorTaskId: string;
  placement: 'before' | 'after';
  expectedRevision: number;
  expectedBaseline: string;
}

/** The original mutation acknowledgement, never a historical list of readable tasks. */
export interface ProjectTaskMoveReceipt {
  projectId: string;
  taskId: string;
  anchorTaskId: string;
  placement: 'before' | 'after';
  revision: number;
  baseline: string;
  changed: boolean;
}

export function parseProjectTaskMove(value: unknown): ProjectTaskMove {
  const body = record(value);
  if (
    Object.keys(body).some(
      (key) =>
        !['taskId', 'anchorTaskId', 'placement', 'expectedRevision', 'expectedBaseline'].includes(
          key,
        ),
    )
  )
    throw new DomainError('INVALID_INPUT', '排序只接受任务、参照任务、前后位置与原排序基线');
  const taskId = text(body.taskId, '任务', 150);
  const anchorTaskId = text(body.anchorTaskId, '参照任务', 150);
  if (taskId === anchorTaskId)
    throw new DomainError('INVALID_INPUT', '请选择另一个任务作为排序参照');
  if (typeof body.expectedBaseline !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedBaseline))
    throw new DomainError('INVALID_INPUT', '需要有效的原排序基线');
  return {
    taskId,
    anchorTaskId,
    placement: enumValue(body.placement, ['before', 'after'] as const, '排序位置'),
    expectedRevision: revision(body.expectedRevision),
    expectedBaseline: body.expectedBaseline,
  };
}

export function parseProjectTaskOrderQuery(value: unknown): void {
  if (Object.keys(record(value)).length)
    throw new DomainError('INVALID_INPUT', '排序读取不接受筛选或分页参数');
}
