import type { Project, Result, Task } from '../../../packages/contracts/src/index.js';
import type { TaskSearchScope } from '../../../packages/contracts/src/task-search.js';
import { resultBodyMatchSnippet } from './result-library-filters.js';
import { taskSearchProjectLabel, taskSearchScopeContext } from './task-search-context.js';

type SearchProject = Pick<Project, 'id' | 'name' | 'archivedAt'>;

export function resultSearchScopeContext(
  selection: TaskSearchScope,
  projects: readonly SearchProject[],
) {
  if (selection.scope === 'all') return { available: true, label: '全部当前可见成果' };
  if (selection.scope === 'personal') return { available: true, label: '无项目个人成果' };
  return taskSearchScopeContext(selection, projects);
}

/** Display current source facts; absent parent context never means personal. */
export function resultSearchResultContext(
  result: Pick<Result, 'title' | 'body' | 'kind'>,
  task: Pick<Task, 'title' | 'shortId' | 'projectId'> | undefined,
  projects: readonly SearchProject[],
  query: string,
) {
  const project = projects.find((item) => item.id === task?.projectId);
  return {
    sourceLabel: !task
      ? '任务不可用'
      : task.projectId === null
        ? '个人任务'
        : project
          ? taskSearchProjectLabel(project)
          : '项目不可用',
    kindLabel: result.kind === 'demo-preview' ? '示例预览' : '成果说明',
    bodyMatch: resultBodyMatchSnippet(result, task, query),
  };
}
