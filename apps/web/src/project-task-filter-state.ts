import {
  parseTaskPeopleFilters,
  type TaskPeopleFilters,
} from '../../../packages/contracts/src/task-participants.js';

export const projectTaskFilterKeys = [
  'q',
  'ownerUserId',
  'participantUserId',
  'status',
  'attention',
] as const;
export type ProjectTaskFilterKey = (typeof projectTaskFilterKeys)[number];
export type ProjectTaskFilterValues = Partial<Record<ProjectTaskFilterKey, string>>;
const routingKeys = ['view', 'tab', 'source', 'agreement', 'resultsCursor'];
const labels: Record<string, string> = {
  q: '搜索',
  ownerUserId: '负责人',
  participantUserId: '参与者',
  status: '状态',
  attention: '关注内容',
  view: '视图',
  tab: '项目页面',
  source: '项目资料',
  agreement: '项目约定',
  resultsCursor: '成果分页',
};

/** Keep raw URL selections visible; invalid input must never become a broader task query. */
export function readProjectTaskFilterState(search: string) {
  const query = new URLSearchParams(search);
  const values: ProjectTaskFilterValues = {};
  const input: Record<string, unknown> = {};
  const errors: string[] = [];
  const keys = new Set<string>();
  query.forEach((_, key) => keys.add(key));
  for (const key of keys) {
    if (!(projectTaskFilterKeys as readonly string[]).includes(key) && !routingKeys.includes(key))
      errors.push(`不支持的参数「${key}」`);
    else if (query.getAll(key).length > 1) errors.push(`${labels[key]}参数重复`);
  }
  for (const key of projectTaskFilterKeys) {
    const raw = query.get(key);
    if (raw !== null) {
      values[key] = raw;
      input[key] = raw;
    }
  }
  const view = query.get('view');
  if (view !== null && view !== 'board' && view !== 'list') errors.push('视图参数不受支持');
  let filters: TaskPeopleFilters | null = null;
  try {
    filters = parseTaskPeopleFilters(input);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : '筛选条件不受支持');
  }
  return {
    values,
    filters: errors.length ? null : filters,
    view: view === 'list' ? ('list' as const) : ('board' as const),
    error: errors.length ? errors.join('；') : null,
    hasFilters: Object.keys(values).length > 0 || errors.length > 0,
  };
}

/** Change one selection without losing other filters, routing parameters, or invalid input. */
export function updateProjectTaskFilterSearch(
  search: string,
  key: ProjectTaskFilterKey | 'view',
  value: string,
): string {
  const query = new URLSearchParams(search);
  if (!value || (key === 'view' && value === 'board')) query.delete(key);
  else query.set(key, value);
  return query.toString();
}

/** Explicit recovery removes filters/unknown keys and keeps supported project routing. */
export function clearProjectTaskFilterSearch(search: string): string {
  const query = new URLSearchParams(search);
  const result = new URLSearchParams();
  query.forEach((value, key) => {
    if (!routingKeys.includes(key) || result.has(key)) return;
    if (key === 'view' && value !== 'board' && value !== 'list') return;
    result.set(key, value);
  });
  return result.toString();
}
