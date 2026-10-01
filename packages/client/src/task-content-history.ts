import type { TaskContentHistory } from '../../contracts/src/task-content-history.js';
import { request } from './index.js';

export const taskContentHistory = (id: string, before?: number, signal?: AbortSignal, limit = 10) =>
  request<TaskContentHistory>(
    `/tasks/${encodeURIComponent(id)}/content-history?limit=${limit}${before === undefined ? '' : `&before=${before}`}`,
    { signal },
  );
