import type { Result, Task } from '../../../packages/contracts/src/index.js';
import { Avatar, Icon, RunBadge, StatusBadge } from '../../../packages/ui/src/index.js';
import { Link, time, useApp } from './state.js';

export function TaskRow({ task }: { task: Task }) {
  const { data } = useApp();
  const run = data.runs.filter((item) => item.taskId === task.id).at(-1);
  return (
    <Link to={`/tasks/${task.id}`} className="work-task-row">
      <span className="work-task-id">{task.shortId}</span>
      <div className="grow">
        <strong>{task.title}</strong>
        <small>
          {task.attention ||
            data.projects.find((project) => project.id === task.projectId)?.name ||
            '个人工作'}
        </small>
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

export function ResultCard({ result }: { result: Result }) {
  const { data } = useApp();
  const task = data.tasks.find((item) => item.id === result.taskId);
  return (
    <Link to={`/results/${result.id}`} className="work-result-card">
      <div className="work-card-kicker">
        <Icon name={result.kind === 'demo-preview' ? 'monitor' : 'file'} />
        <span>{result.kind === 'demo-preview' ? '示例预览' : '文字成果'}</span>
        <span className="spacer" />
        <span>v{result.revision}</span>
      </div>
      <h3>{result.title}</h3>
      <p>{result.body || '打开查看成果与反馈。'}</p>
      <div className="work-card-footer">
        <span>
          {task?.shortId ?? '关联任务'} · {time(result.updatedAt)}
        </span>
        <Icon name="arrow" size={16} />
      </div>
    </Link>
  );
}
