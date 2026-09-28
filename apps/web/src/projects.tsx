import { useEffect, useState } from 'react';
import { ProjectSettings } from './project-settings.js';
import { ProjectSources } from './project-sources.js';
import { ProjectAgreements } from './project-agreements.js';
import { ProjectTaskFilters, useProjectTaskFilters } from './project-task-filters.js';
import { matchesTaskPeopleFilters } from '../../../packages/domain/src/index.js';
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
  const [archived, setArchived] = useState(false);
  const projects = data.projects.filter((project) => !!project.archivedAt === archived);
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
      <div className="tabs" aria-label="项目状态筛选">
        <button aria-pressed={!archived} onClick={() => setArchived(false)}>
          当前项目
        </button>
        <button aria-pressed={archived} onClick={() => setArchived(true)}>
          已归档
        </button>
      </div>
      <div className="work-project-grid stagger">
        {projects.map((project) => {
          const tasks = data.tasks.filter((task) => task.projectId === project.id);
          return (
            <Link
              to={`/projects/${project.id}`}
              className="work-project-card spotlight"
              key={project.id}
            >
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
              {project.archivedAt && <span className="hint">已归档 · 仍可查看任务与成果</span>}
              <p>{project.description || '从一项任务开始，逐步补充项目目标。'}</p>
              <div className="work-card-footer">
                <span>{tasks.filter((task) => task.status === 'in_progress').length} 项进行中</span>
                <span>{tasks.filter((task) => task.status === 'done').length} 项已完成</span>
              </div>
            </Link>
          );
        })}
      </div>
      {!projects.length && (
        <Empty
          icon={archived ? 'box' : 'folder'}
          title={archived ? '没有已归档项目' : '还没有当前项目'}
          description={
            archived
              ? '归档的项目会留在这里，随时可以恢复。'
              : '新建一个项目，把任务与成果归拢到同一处。'
          }
          action={
            archived ? (
              <Button onClick={() => setArchived(false)}>查看当前项目</Button>
            ) : (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} />
                新建项目
              </Button>
            )
          }
        />
      )}
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </div>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const { data, changeStatus } = useApp();
  const readLocation = () => {
    const query = new URLSearchParams(location.search);
    return {
      tab: ['overview', 'results', 'sources', 'agreements'].includes(query.get('tab') ?? '')
        ? query.get('tab')!
        : 'tasks',
      sourceId: query.get('source') ?? '',
      agreementId: query.get('agreement') ?? '',
    };
  };
  const [projectLocation, setProjectLocation] = useState(readLocation);
  const { tab, sourceId, agreementId } = projectLocation;
  useEffect(() => {
    const update = () => setProjectLocation(readLocation());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  function setTab(tab: string, source = '') {
    const url = new URL(location.href);
    if (tab === 'tasks') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    url.searchParams.delete('source');
    url.searchParams.delete('agreement');
    if (source && tab === 'sources') url.searchParams.set('source', source);
    if (source && tab === 'agreements') url.searchParams.set('agreement', source);
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  const { view, setView, filters, setFilter, clear } = useProjectTaskFilters();
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const project = data.projects.find((item) => item.id === id);
  const manageable = !!project && (data.mode === 'local-preview' || project.access === 'manage');
  useEffect(() => {
    if (!manageable) setSettingsOpen(false);
  }, [manageable]);
  if (!project)
    return (
      <Empty
        icon="folder"
        title="项目不存在或当前无权访问"
        description="链接可能已失效，或当前账号没有这个项目的权限。"
        action={
          <Link className="button secondary" to="/projects">
            返回项目列表
          </Link>
        }
      />
    );
  const members =
    data.mode === 'team-local'
      ? data.members.filter((member) => project.memberIds?.includes(member.id))
      : data.members;
  const allTasks = data.tasks.filter(
    (task) => task.projectId === id && task.status !== 'cancelled',
  );
  const tasks = allTasks.filter((task) => matchesTaskPeopleFilters(task, filters));
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
        <div className="project-settings-actions">
          <Button
            disabled={!manageable}
            title={manageable ? '修改项目基本信息' : '需要项目管理权限'}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" />
            项目设置
          </Button>
          <Button variant="primary" disabled={!editable} onClick={() => setCreating(true)}>
            <Icon name="plus" />
            新建任务
          </Button>
        </div>
      </header>
      {settingsOpen && manageable && (
        <ProjectSettings project={project} onClose={() => setSettingsOpen(false)} />
      )}
      {project.archivedAt && (
        <div className="project-archive-banner" role="status">
          <strong>项目已归档。</strong>{' '}
          历史与讨论保留，新执行已暂停。已有运行仍需实际结束；恢复项目不会自动重启旧安排。
        </div>
      )}
      {data.mode === 'team-local' && <ProjectAccess project={project} />}
      <div className="tabs" role="tablist" aria-label="项目视图">
        {[
          ['tasks', '需求与任务'],
          ['overview', '总览'],
          ['sources', '项目资料'],
          ['agreements', '项目约定'],
          ['results', '项目成果'],
        ].map(([key, label]) => (
          <button key={key} aria-pressed={tab === key} onClick={() => setTab(key!)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'agreements' ? (
        <ProjectAgreements
          key={id}
          project={project}
          agreementId={agreementId}
          onSelect={(agreement) => setTab('agreements', agreement)}
        />
      ) : tab === 'sources' ? (
        <ProjectSources
          key={id}
          project={project}
          sourceId={sourceId}
          onSelect={(source) => setTab('sources', source)}
        />
      ) : tab === 'results' ? (
        <div className="work-result-grid stagger">
          {results.map((result) => (
            <ResultCard key={result.id} result={result} />
          ))}
          {!results.length && (
            <Empty
              icon="box"
              title="这个项目还没有成果"
              description="在任务里把进展分享出来，反馈会留在原任务上。"
              action={
                <Button
                  variant="primary"
                  disabled={!editable}
                  onClick={() => {
                    setTab('tasks');
                  }}
                >
                  去任务里推进
                </Button>
              }
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
            <div className="project-member-list stagger">
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
            <ProjectTaskFilters
              projectId={id}
              filters={filters}
              setFilter={setFilter}
              clear={clear}
            />
            <span className="muted">{tasks.length} 项任务</span>
          </div>
          {view === 'board' ? (
            <div className="project-board stagger">
              {(['todo', 'in_progress', 'done'] as const).map((status) => (
                <section className="project-column" key={status}>
                  <header>
                    <StatusBadge status={status} />
                    <span>{tasks.filter((task) => task.status === status).length}</span>
                  </header>
                  {tasks
                    .filter((task) => task.status === status)
                    .map((task) => (
                      <article className="project-task-card spotlight" key={task.id}>
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
                <Empty
                  icon="list"
                  title="没有匹配的任务"
                  description="换一个筛选条件，或者直接新建一项任务。"
                  action={
                    <Button
                      variant="primary"
                      disabled={!editable}
                      onClick={() => setCreating(true)}
                    >
                      <Icon name="plus" size={16} />
                      新建任务
                    </Button>
                  }
                />
              )}
            </div>
          )}
        </>
      )}
      {creating && <NewTask projectId={id} onClose={() => setCreating(false)} />}
    </div>
  );
}
