import { AssistanceWorkbench } from './assistance.js';
import { useState } from 'react';
import {
  Button,
  Empty,
  Icon,
  RunBadge,
  StatusBadge,
  ToolMark,
} from '../../../packages/ui/src/index.js';
import { isActiveRun } from '../../../packages/domain/src/index.js';
import { Link, useApp } from './state.js';
import { NewTask } from './forms.js';
import { ResultCard } from './work-cards.js';
import { WorkbenchTaskList } from './workbench-task-list.js';
import { matchesWorkbenchTaskScope, type WorkbenchTaskScope } from './workbench-task-scope.js';
import './work-pages.css';

const workbenchScopeLabels: Record<WorkbenchTaskScope, string> = {
  mine: '我的工作',
  participating: '我参与的',
  team: '团队概览',
};

export function Workbench() {
  const { data } = useApp();
  const [tab, setTab] = useState<WorkbenchTaskScope>('mine');
  const [creating, setCreating] = useState(false);
  const scopedTasks = data.tasks.filter((task) =>
    matchesWorkbenchTaskScope(task, tab, data.user.id),
  );
  const tasks = scopedTasks.filter(
    (task) =>
      task.status !== 'cancelled' ||
      data.runs.some(
        (run) =>
          run.taskId === task.id && (isActiveRun(run.state) || run.observation === 'unknown'),
      ),
  );
  const active = tasks.filter(
    (task) =>
      task.status === 'in_progress' ||
      data.runs.some(
        (run) =>
          run.taskId === task.id && (isActiveRun(run.state) || run.observation === 'unknown'),
      ),
  );
  const current = active[0] ?? tasks.find((task) => task.status === 'todo');
  const latest = data.runs
    .filter((run) => run.taskId === current?.id && run.purpose !== 'assist')
    .at(-1);
  const attention = tasks.filter((task) => !!task.attention && task.status !== 'done');
  const recent = data.results
    .filter((result) => tasks.some((task) => task.id === result.taskId))
    .slice(0, 3);
  return (
    <div className="work-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">{data.space?.name ?? '本地开发预览'}</span>
          <h1>{workbenchScopeLabels[tab]}</h1>
          <p>继续一项任务，或把下一个想法记录下来。</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          新建任务
        </Button>
      </header>
      <div className="work-tabs">
        <button aria-pressed={tab === 'mine'} onClick={() => setTab('mine')}>
          我的工作
        </button>
        <button aria-pressed={tab === 'participating'} onClick={() => setTab('participating')}>
          我参与的
        </button>
        <button aria-pressed={tab === 'team'} onClick={() => setTab('team')}>
          团队概览
        </button>
        <Link to="/workbench/members" className="member-work-entry">
          成员工作
        </Link>
        <span className="spacer" />
        <span className="muted">
          {tasks.filter((task) => task.status === 'in_progress').length} 项进行中 ·{' '}
          {attention.length} 项需关注
        </span>
      </div>
      <div className="home-columns">
        <div className="home-main">
          <section className="resume-work">
            {current ? (
              <>
                <div className="work-card-kicker">
                  <Icon name="folder" />
                  <span>
                    {data.projects.find((project) => project.id === current.projectId)?.name ??
                      '个人工作'}
                  </span>
                  <span className="spacer" />
                  <StatusBadge status={current.status} />
                </div>
                <h2>{current.title}</h2>
                <p>{current.description || '说明、讨论与成果都在这个任务中。'}</p>
                <div className="resume-work-actions">
                  <span className="flex-line">
                    {latest && <ToolMark tool={latest.requestedTool} />}
                    <RunBadge run={latest} />
                  </span>
                  <Link className="button primary" to={`/tasks/${current.id}`}>
                    继续任务 <Icon name="arrow" />
                  </Link>
                </div>
              </>
            ) : tab === 'participating' ? (
              <Empty
                title={scopedTasks.length ? '暂无可继续的参与任务' : '还没有参与的任务'}
                description={
                  tasks.length
                    ? '已参与的任务仍可在下方查看。'
                    : scopedTasks.length
                      ? '可在下方勾选「包括已取消任务」查看。'
                      : '可在项目任务详情的「参与者」中加入。'
                }
              />
            ) : (
              <Empty
                title="从一项工作开始"
                description="只需一个标题，就能保存想法和展开讨论。"
                action={
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    新建任务 <Icon name="plus" size={16} />
                  </Button>
                }
              />
            )}
          </section>
          <WorkbenchTaskList
            key={tab}
            tasks={tasks}
            tasksIncludingCancelled={scopedTasks}
            emptyDescription={
              tab === 'participating'
                ? '还没有参与的任务。可在项目任务详情的「参与者」中加入。'
                : undefined
            }
          />
        </div>
        <aside className="home-attention">
          <div className="work-section-heading">
            <h2>需要关注</h2>
            <span className="count">{attention.length}</span>
          </div>
          {attention.map((task) => (
            <Link className="attention-row" key={task.id} to={`/tasks/${task.id}`}>
              <span className="attention-indicator" />
              <div>
                <strong>{task.attention}</strong>
                <p>{task.title}</p>
                <small>{task.shortId}</small>
              </div>
              <Icon name="arrow" size={15} />
            </Link>
          ))}
          {!attention.length && <p className="work-empty-text">没有等待回复的事项。</p>}
          <AssistanceWorkbench />
          <div className="home-resource-link">
            <Icon name="monitor" />
            <div>
              <strong>工具与运行位置</strong>
              <p>
                {data.mode === 'team-local'
                  ? '在本人授权的节点上执行，项目可见不等于节点控制权。'
                  : '当前为本机预览。原生工具的可用性取决于本机配置。'}
              </p>
              <Link to="/settings">
                查看资源与设置 <Icon name="chevron" size={14} />
              </Link>
            </div>
          </div>
        </aside>
      </div>
      <section className="work-section">
        <div className="work-section-heading">
          <h2>最近成果</h2>
          <Link to="/results">
            全部成果 <Icon name="chevron" size={14} />
          </Link>
        </div>
        <div className="work-result-grid stagger">
          {recent.map((result) => (
            <ResultCard key={result.id} result={result} />
          ))}
          {!recent.length && (
            <p className="work-empty-text">成果可以在任务进行中分享，无需先标记完成。</p>
          )}
        </div>
      </section>
      {creating && <NewTask onClose={() => setCreating(false)} />}
    </div>
  );
}
