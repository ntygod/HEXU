import { useEffect, useState } from 'react';
import type { ProjectTaskPeople } from '../../../packages/contracts/src/task-participants.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { useApp, useLoad } from './state.js';
import {
  clearProjectTaskFilterSearch,
  readProjectTaskFilterState,
  updateProjectTaskFilterSearch,
  type ProjectTaskFilterKey,
  type ProjectTaskFilterValues,
} from './project-task-filter-state.js';
import './project-task-filters.css';

/** The URL is the single selection source for both project task views. */
export function useProjectTaskFilters() {
  const readFilters = () => readProjectTaskFilterState(location.search);
  const [selection, setSelection] = useState(readFilters);
  useEffect(() => {
    const update = () => setSelection(readFilters());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  function update(search: string, replace = false) {
    const url = new URL(location.href);
    url.search = search;
    history[replace ? 'replaceState' : 'pushState'](history.state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  return {
    ...selection,
    setView: (view: string) => update(updateProjectTaskFilterSearch(location.search, 'view', view)),
    setFilter: (key: ProjectTaskFilterKey, value: string) =>
      update(updateProjectTaskFilterSearch(location.search, key, value), key === 'q'),
    clear: () => update(clearProjectTaskFilterSearch(location.search)),
  };
}
const ownerLabels = { available: '', read_only: ' · 当前只读', removed: ' · 已退出项目' };
export function ProjectTaskFilters({
  projectId,
  values,
  validationError,
  hasFilters,
  setFilter,
  clear,
}: {
  projectId: string;
  values: ProjectTaskFilterValues;
  validationError: string | null;
  hasFilters: boolean;
  setFilter(key: ProjectTaskFilterKey, value: string): void;
  clear(): void;
}) {
  const { refresh } = useApp();
  const { value, error } = useLoad<ProjectTaskPeople>(`/projects/${projectId}/task-people`);
  const invalidStatus =
    values.status !== undefined &&
    !['todo', 'in_progress', 'done', 'cancelled'].includes(values.status);
  const invalidAttention =
    values.attention !== undefined && !['present', 'absent'].includes(values.attention);
  return (
    <>
      <div className="project-people-filters">
        <label>
          状态
          <select
            aria-label="状态筛选"
            value={invalidStatus ? values.status || '__invalid_status__' : (values.status ?? '')}
            aria-invalid={invalidStatus || undefined}
            onChange={(event) => setFilter('status', event.target.value)}
          >
            {invalidStatus && (
              <option value={values.status || '__invalid_status__'} disabled>
                链接中的状态（无效：{values.status || '空值'}）
              </option>
            )}
            <option value="">不含已取消</option>
            <option value="todo">待处理</option>
            <option value="in_progress">进行中</option>
            <option value="done">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
        <label>
          关注内容
          <select
            aria-label="关注内容筛选"
            value={
              invalidAttention
                ? values.attention || '__invalid_attention__'
                : (values.attention ?? '')
            }
            aria-invalid={invalidAttention || undefined}
            onChange={(event) => setFilter('attention', event.target.value)}
          >
            {invalidAttention && (
              <option value={values.attention || '__invalid_attention__'} disabled>
                链接中的关注内容（无效：{values.attention || '空值'}）
              </option>
            )}
            <option value="">全部关注情况</option>
            <option value="present">有关注内容</option>
            <option value="absent">无关注内容</option>
          </select>
        </label>
        <label>
          负责人
          <select
            aria-label="负责人筛选"
            value={values.ownerUserId ?? ''}
            onChange={(event) => setFilter('ownerUserId', event.target.value)}
          >
            <option value="">全部负责人</option>
            {values.ownerUserId &&
              !value?.owners.some((person) => person.id === values.ownerUserId) && (
                <option value={values.ownerUserId}>链接中的负责人（当前不可用）</option>
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
            value={values.participantUserId ?? ''}
            onChange={(event) => setFilter('participantUserId', event.target.value)}
          >
            <option value="">全部参与者</option>
            {values.participantUserId &&
              !value?.participants.some((person) => person.id === values.participantUserId) && (
                <option value={values.participantUserId}>链接中的参与者（当前不可用）</option>
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
          value={values.q ?? ''}
          maxLength={160}
          onChange={(event) => setFilter('q', event.target.value)}
          placeholder="标题、编号或说明…"
        />
      </label>
      {hasFilters && <Button onClick={clear}>清除筛选</Button>}
      {validationError && (
        <span className="project-filter-error" role="alert">
          筛选链接无效：{validationError}。请修改筛选条件或清除筛选后重试。
        </span>
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
