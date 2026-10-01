import type { Run } from '../../contracts/src/index.js';
import { isActiveRun } from './index.js';

export const RESULT_TASK_ACTIVITY_PAGE_SIZE = 5;

/** Current Task activity, independent of an immutable result or its source Run. */
export function summarizeResultTaskActivity(
  taskId: string,
  runs: readonly Run[],
  requestedPage = 1,
) {
  // Match the Workbench predicate exactly. Missing legacy termination metadata
  // does not mean that observation is unknown.
  const activity = runs
    .filter(
      (run) => run.taskId === taskId && (isActiveRun(run.state) || run.observation === 'unknown'),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  let unknown = 0;
  let stopping = 0;
  let otherActive = 0;
  for (const run of activity) {
    // Unknown takes precedence, just as it does in the shared RunBadge.
    if (run.observation === 'unknown') unknown += 1;
    else if (run.state === 'stopping') stopping += 1;
    else otherActive += 1;
  }
  const total = activity.length;
  const pageCount = Math.max(1, Math.ceil(total / RESULT_TASK_ACTIVITY_PAGE_SIZE));
  const page = Math.max(
    1,
    Math.min(pageCount, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1),
  );
  return {
    total,
    unknown,
    stopping,
    otherActive,
    page,
    pageCount,
    rows: activity.slice(
      (page - 1) * RESULT_TASK_ACTIVITY_PAGE_SIZE,
      page * RESULT_TASK_ACTIVITY_PAGE_SIZE,
    ),
  };
}
