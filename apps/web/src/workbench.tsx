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
import { ResultCard, TaskRow } from './work-cards.js';
import './work-pages.css';

export function Workbench() {
  const { data } = useApp();
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [creating, setCreating] = useState(false);
  const tasks = data.tasks.filter(
    (task) =>
      (task.status !== 'cancelled' ||
        data.runs.some(
          (run) =>
            run.taskId === task.id && (isActiveRun(run.state) || run.observation === 'unknown'),
        )) &&
      (tab === 'mine' ? task.ownerUserId === data.user.id : task.visibility === 'project'),
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
  const latest = data.runs.filter((run) => run.taskId === current?.id).at(-1);
  const attention = tasks.filter((task) => !!task.attention && task.status !== 'done');
  const recent = data.results
    .filter((result) => tasks.some((task) => task.id === result.taskId))
    .slice(0, 3);
  return (
    <div className="work-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">{data.space?.name ?? '本地开发预览'}</span>
          <h1>{tab === 'mine' ? '我的工作' : '团队概览'}</h1>
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
        <button aria-pressed={tab === 'team'} onClick={() => setTab('team')}>
          团队概览
        </button>
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
            ) : (
              <Empty title="从一项工作开始" description="只需一个标题，就能保存想法和展开讨论。" />
            )}
          </section>
          <section className="work-section">
            <div className="work-section-heading">
              <h2>最近任务</h2>
              <Link to="/projects">
                查看项目 <Icon name="chevron" size={14} />
              </Link>
            </div>
            <div className="work-task-list">
              {tasks.slice(0, 8).map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
              {!tasks.length && (
                <p className="work-empty-text">还没有任务。创建后，工作记录会留在这里。</p>
              )}
            </div>
          </section>
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
        <div className="work-result-grid">
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
