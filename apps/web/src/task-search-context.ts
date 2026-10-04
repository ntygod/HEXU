import type { Project, Task } from '../../../packages/contracts/src/index.js';
import type { TaskSearchScope } from '../../../packages/contracts/src/task-search.js';
import { textMatchSnippet } from './text-match-snippet.js';

type SearchProject = Pick<Project, 'id' | 'name' | 'archivedAt'>;

export function taskSearchProjectLabel(project: SearchProject): string {
  return `${project.name}${project.archivedAt ? '（已归档）' : ''}`;
}

/** Resolve only from the current visible project projection, never a saved name. */
export function taskSearchScopeContext(
  selection: TaskSearchScope,
  projects: readonly SearchProject[],
) {
  if (selection.scope === 'all') return { available: true, label: '全部当前可见任务' };
  if (selection.scope === 'personal') return { available: true, label: '无项目个人任务' };
  const project = projects.find((item) => item.id === selection.projectId);
  return {
    available: !!project,
    label: project ? taskSearchProjectLabel(project) : '项目不可用',
  };
}

/** Presentation only: cross-field matches remain rows even without a body snippet. */
export function taskSearchResultContext(
  task: Pick<Task, 'projectId' | 'title' | 'shortId' | 'description'>,
  projects: readonly SearchProject[],
  query: string,
) {
  const project = projects.find((item) => item.id === task.projectId);
  const needle = query.trim().toLocaleLowerCase();
  const visibleFieldMatch =
    !!needle &&
    (task.title.toLocaleLowerCase().includes(needle) ||
      task.shortId.toLocaleLowerCase().includes(needle));
  return {
    sourceLabel:
      task.projectId === null
        ? '个人任务'
        : project
          ? taskSearchProjectLabel(project)
          : '项目不可用',
    descriptionMatch: visibleFieldMatch ? null : textMatchSnippet(task.description, query),
  };
}
