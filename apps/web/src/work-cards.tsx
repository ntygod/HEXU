import { TaskLabelChips } from './task-labels.js';
import type { Result, Task } from '../../../packages/contracts/src/index.js';
import { Avatar, Icon, RunBadge, StatusBadge } from '../../../packages/ui/src/index.js';
import { Link, time, useApp } from './state.js';
import type { TaskMatchSnippet } from './task-match-snippet.js';
import { TaskDescriptionMatch } from './task-match-snippet-view.js';
import type { TextMatchSnippet } from './text-match-snippet.js';

export function TaskRow({
  task,
  descriptionMatch,
}: {
  task: Task;
  descriptionMatch?: TaskMatchSnippet | null;
}) {
  const { data } = useApp();
  const run = data.runs
    .filter((item) => item.taskId === task.id && item.purpose !== 'assist')
    .at(-1);
  return (
    <Link
      to={`/tasks/${task.id}`}
      className={`work-task-row${descriptionMatch ? ' work-task-row-match' : ''}`}
    >
      <span className="work-task-id">{task.shortId}</span>
      <div className="grow">
        <strong>{task.title}</strong>
        <small>
          {task.attention ||
            data.projects.find((project) => project.id === task.projectId)?.name ||
            '个人工作'}
        </small>
        <TaskLabelChips labels={task.labelNames} />
        {descriptionMatch && <TaskDescriptionMatch snippet={descriptionMatch} />}
      </div>
      {run && (
        <span className="work-task-run">
          <RunBadge run={run} />
        </span>
      )}
      <Avatar user={data.members.find((member) => member.id === task.ownerUserId)} size="small" />
      <StatusBadge status={task.status} />
      <Icon name="chevron" size={14} />
    </Link>
  );
}

export function ResultCard({
  result,
  showContext = false,
  bodyMatch,
}: {
  result: Result;
  showContext?: boolean;
  bodyMatch?: TextMatchSnippet | null;
}) {
  const { data } = useApp();
  const task = data.tasks.find((item) => item.id === result.taskId);
  const project = showContext
    ? data.projects.find((item) => item.id === task?.projectId)
    : undefined;
  return (
    <Link to={`/results/${result.id}`} className="work-result-card spotlight">
      <div className="work-card-kicker">
        <Icon name={result.kind === 'demo-preview' ? 'monitor' : 'file'} />
        <span>{result.kind === 'demo-preview' ? '示例预览' : '文字成果'}</span>
        <span className="spacer" />
        <span>v{result.revision}</span>
      </div>
      <h3>{result.title}</h3>
      {showContext && (
        <div className="result-library-context">
          <span>
            {project
              ? `${project.name}${project.archivedAt ? ' · 已归档' : ''}`
              : task
                ? task.projectId
                  ? '项目当前不可见'
                  : '个人工作'
                : '关联任务当前不可见'}
          </span>
          {task && (
            <strong>
              {task.shortId} · {task.title}
            </strong>
          )}
        </div>
      )}
      {bodyMatch ? (
        <p className="result-library-body-match" aria-label="成果正文匹配片段">
          {bodyMatch.before}
          <mark>{bodyMatch.match}</mark>
          {bodyMatch.after}
        </p>
      ) : (
        <p>{result.body || '打开查看成果与反馈。'}</p>
      )}
      <div className="work-card-footer">
        <span>
          {task?.shortId ?? '关联任务'} · {time(result.updatedAt)}
        </span>
        <Icon name="arrow" size={16} />
      </div>
    </Link>
  );
}
