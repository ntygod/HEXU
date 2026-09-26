import { useState } from 'react';
import type { TaskStatus } from '../../../packages/contracts/src/index.js';
import { Avatar, Button, Empty, Icon, StatusBadge } from '../../../packages/ui/src/index.js';
import { Link, useApp, canEditTask } from './state.js';
import { NewProject, NewTask } from './forms.js';
import { ProjectAccess } from './team.js';
import { ResultCard, TaskRow } from './work-cards.js';
import './work-pages.css';

export function Projects() {
  const { data } = useApp();
  const [creating, setCreating] = useState(false);
  return (
    <div className="work-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">共同的目标与工作记录</span>
          <h1>项目</h1>
          <p>进入项目，继续讨论、任务和成果。</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          新建项目
        </Button>
      </header>
      <div className="work-project-grid">
        {data.projects.map((project) => {
          const tasks = data.tasks.filter((task) => task.projectId === project.id);
          return (
            <Link to={`/projects/${project.id}`} className="work-project-card" key={project.id}>
              <div className="work-card-kicker">
                <Icon name="folder" />
                <span>
                  {data.mode === 'team-local'
                    ? project.access === 'view'
                      ? '只读项目'
                      : '可协作项目'
                    : '示例项目'}
                </span>
                <span className="spacer" />
                <Icon name="arrow" />
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || '从一项任务开始，逐步补充项目目标。'}</p>
              <div className="work-card-footer">
                <span>{tasks.filter((task) => task.status === 'in_progress').length} 项进行中</span>
                <span>{tasks.filter((task) => task.status === 'done').length} 项已完成</span>
              </div>
            </Link>
          );
        })}
      </div>
      {!data.projects.length && (
        <Empty title="还没有项目" description="创建项目后即可整理任务，不必先连接代码目录。" />
      )}
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </div>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const { data, changeStatus } = useApp();
  const [tab, setTab] = useState('tasks');
  const [view, setView] = useState('board');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const project = data.projects.find((item) => item.id === id);
  if (!project)
    return (
      <Empty title="项目不存在或当前无权访问">
        <Link className="button secondary" to="/projects">
          返回项目
        </Link>
      </Empty>
    );
  const members =
    data.mode === 'team-local'
      ? data.members.filter((member) => project.memberIds?.includes(member.id))
      : data.members;
  const allTasks = data.tasks.filter(
    (task) => task.projectId === id && task.status !== 'cancelled',
  );
  const tasks = allTasks.filter((task) =>
    task.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  const results = data.results.filter((result) =>
    allTasks.some((task) => task.id === result.taskId),
  );
  const editable = project.access !== 'view';
  return (
    <div className="work-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">项目工作区</span>
          <h1>{project.name}</h1>
          <p>{project.description || '从一项任务开始，逐步明确要完成的工作。'}</p>
        </div>
        <Button variant="primary" disabled={!editable} onClick={() => setCreating(true)}>
          <Icon name="plus" />
          新建任务
        </Button>
      </header>
      {data.mode === 'team-local' && <ProjectAccess project={project} />}
      <div className="work-tabs">
        {[
          ['tasks', '需求与任务'],
          ['overview', '总览'],
          ['results', '项目成果'],
        ].map(([key, label]) => (
          <button key={key} aria-pressed={tab === key} onClick={() => setTab(key!)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'results' ? (
        <div className="work-result-grid">
          {results.map((result) => (
            <ResultCard key={result.id} result={result} />
          ))}
          {!results.length && (
            <Empty
              title="这个项目还没有成果"
              description="在任务中分享当前进展，反馈会留在原任务。"
            />
          )}
        </div>
      ) : tab === 'overview' ? (
        <div className="project-overview">
          <section className="work-section">
            <h2>目标与进度</h2>
            <p className="text-block">{project.description || '项目尚未补充说明。'}</p>
            <div className="project-status-counts">
              {(['todo', 'in_progress', 'done'] as const).map((status) => (
                <div key={status}>
                  <strong>{allTasks.filter((task) => task.status === status).length}</strong>
                  <StatusBadge status={status} />
                </div>
              ))}
            </div>
          </section>
          <section className="work-section">
            <h2>项目成员{data.mode === 'local-preview' ? ' · 示例资料' : ''}</h2>
            <div className="project-member-list">
              {members.map((member) => (
                <div key={member.id}>
                  <Avatar user={member} />
                  <strong>{member.name}</strong>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <>
          <div className="project-toolbar">
            <div className="work-view-switch" aria-label="任务视图">
              <button aria-pressed={view === 'board'} onClick={() => setView('board')}>
                <Icon name="board" size={15} />
                看板
              </button>
              <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
                <Icon name="list" size={15} />
                列表
              </button>
            </div>
            <label className="work-filter">
              <Icon name="search" size={15} />
              <input
                aria-label="筛选项目任务"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="按标题筛选任务…"
              />
            </label>
            <span className="muted">{tasks.length} 项任务</span>
          </div>
          {view === 'board' ? (
            <div className="project-board">
              {(['todo', 'in_progress', 'done'] as const).map((status) => (
                <section className="project-column" key={status}>
                  <header>
                    <StatusBadge status={status} />
                    <span>{tasks.filter((task) => task.status === status).length}</span>
                  </header>
                  {tasks
                    .filter((task) => task.status === status)
                    .map((task) => (
                      <article className="project-task-card" key={task.id}>
                        <Link to={`/tasks/${task.id}`}>
                          <span className="work-task-id">{task.shortId}</span>
                          <h3>{task.title}</h3>
                          <p>{task.description || '打开任务查看讨论与成果。'}</p>
                          {task.attention && <span className="badge amber">{task.attention}</span>}
                        </Link>
                        <footer>
                          <Avatar
                            user={data.members.find((member) => member.id === task.ownerUserId)}
                            size="small"
                          />
                          <select
                            aria-label={`${task.shortId} 状态`}
                            value={task.status}
                            disabled={!canEditTask(data, task)}
                            onChange={(event) =>
                              void changeStatus(task, event.target.value as TaskStatus)
                            }
                          >
                            <option value="todo">待处理</option>
                            <option value="in_progress">进行中</option>
                            <option value="done">已完成</option>
                          </select>
                        </footer>
                      </article>
                    ))}
                  {!tasks.some((task) => task.status === status) && (
                    <p className="work-empty-text">暂无任务</p>
                  )}
                </section>
              ))}
            </div>
          ) : (
            <div className="work-task-list task-list">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
              {!tasks.length && (
                <Empty title="没有匹配的任务" description="试试其他关键词，或新建任务。" />
              )}
            </div>
          )}
        </>
      )}
      {creating && <NewTask projectId={id} onClose={() => setCreating(false)} />}
    </div>
  );
}
