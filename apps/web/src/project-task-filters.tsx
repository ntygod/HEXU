import { useEffect, useState } from 'react';
import type {
  ProjectTaskPeople,
  TaskPeopleFilters,
} from '../../../packages/contracts/src/task-participants.js';
import type { TaskStatus } from '../../../packages/contracts/src/index.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { parseProjectTaskStatus, type ProjectTaskStatusSelection } from './project-task-status.js';
import {
  parseProjectTaskAttention,
  type ProjectTaskAttention,
  type ProjectTaskAttentionSelection,
} from './project-task-attention.js';
import { parseProjectTaskLabel, type ProjectTaskLabelSelection } from './project-task-label.js';
import {
  parseProjectTaskTargetDate,
  type ProjectTaskTargetDate,
  type ProjectTaskTargetDateSelection,
} from './project-task-target-date.js';
import { useApp, useLoad } from './state.js';
import './project-task-filters.css';

function readFilters() {
  const query = new URLSearchParams(location.search);
  const label = parseProjectTaskLabel(query);
  return {
    label,
    filters: {
      ...(label.kind === 'label' ? { label: label.label } : {}),
      q: query.get('q') ?? '',
      ownerUserId: query.get('ownerUserId')?.trim() ?? '',
      participantUserId: query.get('participantUserId')?.trim() ?? '',
    },
    status: parseProjectTaskStatus(query),
    attention: parseProjectTaskAttention(query),
    targetDate: parseProjectTaskTargetDate(query),
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
    setStatus: (status: TaskStatus | '') => update({ status }),
    setLabel: (label: string) => update({ label }),
    setAttention: (attention: ProjectTaskAttention | '') => update({ attention }),
    setTargetDate: (targetDate: ProjectTaskTargetDate | '') => update({ targetDate }),
    clear: () =>
      update({
        q: '',
        ownerUserId: '',
        participantUserId: '',
        status: '',
        attention: '',
        label: '',
        targetDate: '',
      }),
  };
}
const ownerLabels = {
  available: '',
  read_only: ' · 当前只读',
  removed: ' · 已退出项目',
};
// This placeholder exceeds the maximum label length, so a real label cannot collide.
const invalidLabelValue = '__invalid_label_query_placeholder__';
export function ProjectTaskFilters({
  projectId,
  filters,
  setFilter,
  status,
  setStatus,
  attention,
  setAttention,
  label,
  setLabel,
  targetDate,
  setTargetDate,
  clear,
}: {
  projectId: string;
  filters: TaskPeopleFilters;
  setFilter(key: keyof TaskPeopleFilters, value: string): void;
  status: ProjectTaskStatusSelection;
  setStatus(status: TaskStatus | ''): void;
  label: ProjectTaskLabelSelection;
  setLabel(label: string): void;
  attention: ProjectTaskAttentionSelection;
  setAttention(attention: ProjectTaskAttention | ''): void;
  targetDate: ProjectTaskTargetDateSelection;
  setTargetDate(targetDate: ProjectTaskTargetDate | ''): void;
  clear(): void;
}) {
  const { data, refresh } = useApp();
  const labelOptions = [
    ...new Set(
      data.tasks
        .filter((task) => task.projectId === projectId && task.visibility === 'project')
        .flatMap((task) => task.labelNames ?? []),
    ),
  ].sort();
  const { value, error } = useLoad<ProjectTaskPeople>(`/projects/${projectId}/task-people`);
  return (
    <>
      <div className="project-people-filters">
        <label>
          状态
          <select
            aria-label="任务状态筛选"
            value={
              status.kind === 'status' ? status.status : status.kind === 'invalid' ? 'invalid' : ''
            }
            onChange={(event) => setStatus(event.target.value as TaskStatus | '')}
          >
            <option value="">默认状态（不含已取消）</option>
            {status.kind === 'invalid' && (
              <option value="invalid" disabled>
                链接中的状态无效
              </option>
            )}
            <option value="todo">待处理</option>
            <option value="in_progress">进行中</option>
            <option value="done">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
        <label>
          关注
          <select
            aria-label="关注内容筛选"
            value={
              attention.kind === 'attention'
                ? attention.attention
                : attention.kind === 'invalid'
                  ? 'invalid'
                  : ''
            }
            onChange={(event) => setAttention(event.target.value as ProjectTaskAttention | '')}
          >
            <option value="">全部关注情况</option>
            {attention.kind === 'invalid' && (
              <option value="invalid" disabled>
                链接中的关注筛选无效
              </option>
            )}
            <option value="present">有关注内容</option>
            <option value="absent">无关注内容</option>
          </select>
        </label>
        <label>
          目标日期
          <select
            aria-label="目标日期筛选"
            value={
              targetDate.kind === 'targetDate'
                ? targetDate.targetDate
                : targetDate.kind === 'invalid'
                  ? 'invalid'
                  : ''
            }
            onChange={(event) => setTargetDate(event.target.value as ProjectTaskTargetDate | '')}
          >
            <option value="">全部目标日期</option>
            {targetDate.kind === 'invalid' && (
              <option value="invalid" disabled>
                链接中的目标日期筛选无效
              </option>
            )}
            <option value="present">已设目标日期</option>
            <option value="absent">未设目标日期</option>
            <option value="today">今天（本地日期）</option>
            <option value="overdue">逾期（待处理、进行中）</option>
          </select>
        </label>
        <label>
          标签
          <select
            aria-label="标签筛选"
            value={
              label.kind === 'label'
                ? label.label
                : label.kind === 'invalid'
                  ? invalidLabelValue
                  : ''
            }
            onChange={(event) => setLabel(event.target.value)}
          >
            <option value="">全部标签</option>
            {label.kind === 'invalid' && (
              <option value={invalidLabelValue} disabled>
                链接中的标签无效
              </option>
            )}
            {label.kind === 'label' && !labelOptions.includes(label.label) && (
              <option value={label.label}>链接中的标签：{label.label}</option>
            )}
            {labelOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
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
      {(filters.q ||
        filters.ownerUserId ||
        filters.participantUserId ||
        label.kind !== 'default' ||
        status.kind !== 'default' ||
        attention.kind !== 'default' ||
        targetDate.kind !== 'default') && <Button onClick={clear}>清除筛选</Button>}
      {targetDate.kind === 'targetDate' &&
        (targetDate.targetDate === 'today' || targetDate.targetDate === 'overdue') && (
          <span className="hint">
            今天按浏览器本地日期判断；逾期只包括目标日期早于今天的待处理、进行中任务。
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
