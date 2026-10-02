import type { TaskCompletionHistory } from '../../contracts/src/task-completion-history.js';
import { request } from './index.js';

export const taskCompletionHistory = (
  id: string,
  before?: string,
  signal?: AbortSignal,
  limit = 10,
) =>
  request<TaskCompletionHistory>(
    `/tasks/${encodeURIComponent(id)}/completion-history?limit=${limit}${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`,
    { signal },
  );
