import { DomainError, record, revision, type Project, type Run } from './index.js';

export type ProjectLifecycleInput =
  | { action: 'archive'; expectedRevision: number; activeRunAction: 'keep' | 'stop' }
  | { action: 'restore'; expectedRevision: number };
export interface ProjectActivity {
  project: Project;
  activeRuns: Run[];
  pendingContinuations: number;
}
export function parseProjectLifecycle(value: unknown): ProjectLifecycleInput {
  const body = record(value);
  if (
    Object.keys(body).some(
      (key) => !['action', 'expectedRevision', 'activeRunAction'].includes(key),
    )
  )
    throw new DomainError('INVALID_INPUT', '项目状态只接受动作、修订号及明确的运行处理方式');
  const expectedRevision = revision(body.expectedRevision);
  if (
    body.action === 'archive' &&
    (body.activeRunAction === 'keep' || body.activeRunAction === 'stop')
  )
    return {
      action: 'archive',
      expectedRevision,
      activeRunAction: body.activeRunAction as 'keep' | 'stop',
    };
  if (body.action === 'restore' && body.activeRunAction === undefined)
    return { action: 'restore', expectedRevision };
  throw new DomainError('INVALID_INPUT', '归档需明确保留运行或请求停止；恢复项目不会重启执行');
}
