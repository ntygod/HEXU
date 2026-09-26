import { useEffect, useState } from 'react';
import type {
  ProjectTaskPeople,
  TaskPeopleFilters,
} from '../../../packages/contracts/src/task-participants.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { useApp, useLoad } from './state.js';
import './project-task-filters.css';

function readFilters() {
  const query = new URLSearchParams(location.search);
  return {
    filters: {
      q: query.get('q') ?? '',
      ownerUserId: query.get('ownerUserId')?.trim() ?? '',
      participantUserId: query.get('participantUserId')?.trim() ?? '',
    },
    view: query.get('view') === 'list' ? 'list' : 'board',
  };
}
/** The URL is the single selection source for both project task views. */
export function useProjectTaskFilters() {
  const [selection, setSelection] = useState(readFilters);
  useEffect(() => {
    const update = () => setSelection(readFilters());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  function update(values: Record<string, string>, replace = false) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history[replace ? 'replaceState' : 'pushState']({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  return {
    ...selection,
    setView: (view: string) => update({ view: view === 'board' ? '' : view }),
    setFilter: (key: keyof TaskPeopleFilters, value: string) =>
      update({ [key]: value }, key === 'q'),
    clear: () => update({ q: '', ownerUserId: '', participantUserId: '' }),
  };
}
const ownerLabels = { available: '', read_only: ' · 当前只读', removed: ' · 已退出项目' };
export function ProjectTaskFilters({
  projectId,
  filters,
  setFilter,
  clear,
}: {
  projectId: string;
  filters: TaskPeopleFilters;
  setFilter(key: keyof TaskPeopleFilters, value: string): void;
  clear(): void;
}) {
  const { refresh } = useApp();
  const { value, error } = useLoad<ProjectTaskPeople>(`/projects/${projectId}/task-people`);
  return (
    <>
      <div className="project-people-filters">
        <label>
          负责人
          <select
            aria-label="负责人筛选"
            value={filters.ownerUserId ?? ''}
            onChange={(event) => setFilter('ownerUserId', event.target.value)}
          >
            <option value="">全部负责人</option>
            {filters.ownerUserId &&
              !value?.owners.some((person) => person.id === filters.ownerUserId) && (
                <option value={filters.ownerUserId}>链接中的负责人（当前不可用）</option>
              )}
            {value?.owners.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {ownerLabels[person.availability]}
              </option>
            ))}
          </select>
        </label>
        <label>
          参与者
          <select
            aria-label="参与者筛选"
            value={filters.participantUserId ?? ''}
            onChange={(event) => setFilter('participantUserId', event.target.value)}
          >
            <option value="">全部参与者</option>
            {filters.participantUserId &&
              !value?.participants.some((person) => person.id === filters.participantUserId) && (
                <option value={filters.participantUserId}>链接中的参与者（当前不可用）</option>
              )}
            {value?.participants.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.role === 'view' ? ' · 当前只读' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="work-filter">
        <Icon name="search" size={15} />
        <input
          aria-label="筛选项目任务"
          value={filters.q ?? ''}
          maxLength={160}
          onChange={(event) => setFilter('q', event.target.value)}
          placeholder="标题、编号或说明…"
        />
      </label>
      {(filters.q || filters.ownerUserId || filters.participantUserId) && (
        <Button onClick={clear}>清除筛选</Button>
      )}
      {error && (
        <span className="project-filter-error" role="alert">
          成员筛选信息读取失败{' '}
          <Button title={error} onClick={() => void refresh()}>
            重试筛选信息
          </Button>
        </span>
      )}
    </>
  );
}
