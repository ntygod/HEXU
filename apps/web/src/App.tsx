import { TaskPage } from './task-workspace.js';
import { MessageComposer, MessageList } from './discussion.js';
import { AppShell } from './shell.js';
import { useAppearance } from './appearance.js';
import { TeamSettings, ProjectAccess } from './team.js';
import { NativeResources } from './native.js';
import { useEffect, useState } from 'react';
import type { Message, Result, Task, TaskStatus } from '../../../packages/contracts/src/index.js';
import { request } from '../../../packages/client/src/index.js';
import {
  Avatar,
  Button,
  Dialog,
  Empty,
  Icon,
  RunBadge,
  StatusBadge,
  ToolMark,
} from '../../../packages/ui/src/index.js';
import { Link, go, time, useApp, useLoad, usePath } from './state.js';
import { NewProject, NewTask } from './forms.js';
import { OrderPreview } from './preview.js';

export function App() {
  const path = usePath();
  const [searchOpen, setSearchOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.repeat) {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const segment = path.split('/').filter(Boolean);
  const active = segment[0] ?? 'workbench';
  return (
    <>
      <AppShell onSearch={() => setSearchOpen(true)}>
        {active === 'workbench' ? (
          <Workbench />
        ) : active === 'projects' ? (
          segment[1] ? (
            <ProjectPage id={segment[1]} key={segment[1]} />
          ) : (
            <Projects />
          )
        ) : active === 'tasks' && segment[1] ? (
          <TaskPage id={segment[1]} key={segment[1]} />
        ) : active === 'results' ? (
          segment[1] ? (
            <ResultPage id={segment[1]} key={segment[1]} />
          ) : (
            <Results />
          )
        ) : active === 'settings' ? (
          <Settings />
        ) : (
          <Empty title="没有找到这个页面">
            <Link to="/" className="button primary">
              返回工作台
            </Link>
          </Empty>
        )}
      </AppShell>
      {searchOpen && (
        <Search
          onClose={() => setSearchOpen(false)}
          onNewTask={() => {
            setSearchOpen(false);
            setNewTaskOpen(true);
          }}
        />
      )}
      {newTaskOpen && <NewTask onClose={() => setNewTaskOpen(false)} />}
    </>
  );
}
function PreviewThumb() {
  return (
    <div className="preview-thumb" aria-hidden="true">
      <div>
        <span />
        <b />
      </div>
      {[0, 1, 2].map((row) => (
        <div className="thumb-row" key={row}>
          <i />
          <i />
          <i />
          <em />
        </div>
      ))}
    </div>
  );
}
function ResultCard({ result }: { result: Result }) {
  const { data } = useApp();
  const task = data.tasks.find((task) => task.id === result.taskId);
  return (
    <Link to={`/results/${result.id}`} className="result-card">
      <PreviewThumb />
      <div>
        <strong>
          {result.title}
          <Icon name="external" size={15} />
        </strong>
        <p>
          {task?.shortId} · {result.kind === 'demo-preview' ? '示例预览' : '文字成果'} · v
          {result.revision}
        </p>
      </div>
    </Link>
  );
}
function TaskRow({ task }: { task: Task }) {
  const { data } = useApp();
  const owner = data.members.find((user) => user.id === task.ownerUserId);
  return (
    <Link to={`/tasks/${task.id}`} className="task-row">
      <span className={`task-circle ${task.status === 'done' ? 'complete' : ''}`}>
        {task.status === 'done' && <Icon name="check" size={11} />}
      </span>
      <div className="grow">
        <strong>{task.title}</strong>
        <small>
          {task.shortId} ·{' '}
          {data.projects.find((project) => project.id === task.projectId)?.name ?? '个人工作'}
        </small>
      </div>
      <Avatar user={owner} size="small" />
      <StatusBadge status={task.status} />
    </Link>
  );
}
function Workbench() {
  const { data } = useApp();
  const [tab, setTab] = useState('mine'),
    [newTask, setNewTask] = useState(false);
  const working = data.tasks.filter(
    (task) =>
      task.status === 'in_progress' && (tab === 'team' || task.ownerUserId === data.user.id),
  );
  const current = working.find((task) => task.id === 'task-24') ?? working[0];
  const others = working.filter((task) => task.id !== current?.id);
  const waiting = data.tasks.filter(
    (task) => task.attention && task.status !== 'done' && task.status !== 'cancelled',
  );
  const latest = current ? data.runs.filter((run) => run.taskId === current.id).at(-1) : undefined;
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>{tab === 'mine' ? '我的工作' : '团队概览'}</h1>
          <p>继续手头的任务，让协作自然发生。</p>
        </div>
        <Button variant="primary" onClick={() => setNewTask(true)}>
          <Icon name="plus" />
          新建任务
        </Button>
      </div>
      <div className="tabs page-tabs">
        <button className={tab === 'mine' ? 'selected' : ''} onClick={() => setTab('mine')}>
          我的工作
        </button>
        <button className={tab === 'team' ? 'selected' : ''} onClick={() => setTab('team')}>
          团队概览
        </button>
        <span className="tab-summary">
          {working.length} 项进行中 <span>｜</span> {waiting.length} 项需关注
        </span>
      </div>
      <div className="workbench-grid">
        <section>
          <div className="hero-card">
            {current ? (
              <>
                <span className="muted flex-line">
                  <Icon name="folder" size={15} />
                  {data.projects.find((project) => project.id === current.projectId)?.name ??
                    '个人工作'}
                  <span className="spacer" />
                  <StatusBadge status={current.status} />
                </span>
                <h2>{current.title}</h2>
                <p>{current.description || '从当前工作继续，相关讨论和成果都在同一个任务中。'}</p>
                <div className="hero-tags">
                  <span>任务与执行在一起</span>
                  <span>记录自动保留</span>
                </div>
                <div className="hero-bottom">
                  <span className="flex-line">
                    <ToolMark tool={latest?.requestedTool ?? 'claude-code'} />
                    <RunBadge run={latest} />
                  </span>
                  <Link to={`/tasks/${current.id}`} className="button primary">
                    <Icon name="arrow" />
                    继续任务
                  </Link>
                </div>
              </>
            ) : (
              <Empty
                title="从一项工作开始"
                description="一个想法、一个问题，或一段需要继续的工作。"
              >
                <Button variant="primary" onClick={() => setNewTask(true)}>
                  新建任务
                </Button>
              </Empty>
            )}
          </div>
          <div className="panel other-tasks">
            <div className="section-heading">
              <h3>其他正在推进的工作</h3>
              <Link to="/projects">
                查看项目 <Icon name="chevron" size={14} />
              </Link>
            </div>
            {others.length ? (
              others.slice(0, 4).map((task) => <TaskRow task={task} key={task.id} />)
            ) : (
              <p className="muted compact-empty">当前没有其他进行中的任务。</p>
            )}
          </div>
        </section>
        <section className="workbench-side">
          <div className="panel">
            <div className="section-heading">
              <h3>
                需要你关注 <span className="count">{waiting.length}</span>
              </h3>
              <Icon name="chat" size={17} />
            </div>
            {waiting.length ? (
              waiting.slice(0, 3).map((task) => (
                <div className="reply-item" key={task.id}>
                  <Avatar
                    user={data.members.find((member) => member.id === task.ownerUserId)}
                    size="small"
                  />
                  <div className="grow">
                    <strong>{task.attention}</strong>
                    <p>{task.title}</p>
                    <div className="reply-bottom">
                      <small>{task.shortId}</small>
                      <Link className="button soft small" to={`/tasks/${task.id}`}>
                        <Icon name="arrow" size={14} />
                        查看任务
                      </Link>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted compact-empty">暂时没有待处理事项。</p>
            )}
          </div>
          <div className="panel context-summary">
            <div className="section-heading">
              <h3>现在可以做什么</h3>
              <span className="badge neutral">开发预览</span>
            </div>
            <p>
              <span className="color-dot violet" />
              创建任务、保存讨论、分享文字成果。
            </p>
            <p>
              <span className="color-dot teal" />
              {data.mode === 'team-local'
                ? '连接独立节点、分享授权目录状态。'
                : '体验模拟执行的等待、回复和停止。'}
            </p>
            <Link to="/settings" className="text-link">
              查看能力边界 <Icon name="arrow" size={14} />
            </Link>
          </div>
        </section>
      </div>
      <section className="results-section">
        <div className="section-heading">
          <h3>最近成果</h3>
          <Link to="/results">
            浏览全部成果 <Icon name="chevron" size={14} />
          </Link>
        </div>
        <div className="result-grid">
          {data.results.slice(0, 3).map((result) => (
            <ResultCard key={result.id} result={result} />
          ))}
          {!data.results.length && (
            <Empty title="成果会出现在这里" description="在任务中分享进展，不必先标记完成。" />
          )}
        </div>
      </section>
      {newTask && <NewTask onClose={() => setNewTask(false)} />}
    </div>
  );
}
function Projects() {
  const { data } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>项目</h1>
          <p>把相关的工作放在一起，让目标和进展都清楚。</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Icon name="plus" />
          新建项目
        </Button>
      </div>
      <div className="project-grid">
        {data.projects.map((project) => (
          <Link to={`/projects/${project.id}`} className="panel project-card" key={project.id}>
            <span className={`project-icon ${project.color}`}>
              <Icon name="folder" size={25} />
            </span>
            <h2>{project.name}</h2>
            <p>{project.description}</p>
            <div>
              <span>
                {
                  data.tasks.filter(
                    (task) => task.projectId === project.id && task.status === 'in_progress',
                  ).length
                }{' '}
                项进行中
              </span>
              <Icon name="arrow" />
            </div>
          </Link>
        ))}
      </div>
      {open && <NewProject onClose={() => setOpen(false)} />}
    </div>
  );
}
function ProjectPage({ id }: { id: string }) {
  const { data, changeStatus } = useApp();
  const [tab, setTab] = useState('tasks'),
    [view, setView] = useState('board'),
    [open, setOpen] = useState(false),
    [filter, setFilter] = useState('');
  const project = data.projects.find((project) => project.id === id);
  if (!project)
    return (
      <Empty title="项目不存在">
        <Link to="/projects">返回项目</Link>
      </Empty>
    );
  const members =
    data.mode === 'team-local'
      ? data.members.filter((m) => project.memberIds?.includes(m.id))
      : data.members;
  const tasks = data.tasks.filter(
    (task) =>
      task.projectId === id &&
      task.status !== 'cancelled' &&
      task.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  const results = data.results.filter(
    (result) => data.tasks.find((task) => task.id === result.taskId)?.projectId === id,
  );
  return (
    <div className="page">
      <div className="page-heading">
        <div className="project-heading">
          <span className={`project-icon ${project.color}`}>
            <Icon name="folder" size={25} />
          </span>
          <div>
            <h1>{project.name}</h1>
            <p>{project.description || '记录目标，从一项工作开始。'}</p>
          </div>
        </div>
        <div className="flex-line">
          <div className="avatar-stack">
            {members.map((member) => (
              <Avatar key={member.id} user={member} />
            ))}
          </div>
          <Button
            variant="primary"
            disabled={project.access === 'view'}
            onClick={() => setOpen(true)}
          >
            <Icon name="plus" />
            新建任务
          </Button>
        </div>
      </div>
      {data.mode === 'team-local' && <ProjectAccess project={project} />}
      <div className="tabs page-tabs">
        {[
          ['overview', '总览'],
          ['tasks', '需求与任务'],
          ['results', '项目成果'],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key!)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'results' ? (
        <div className="result-grid">
          {results.map((result) => (
            <ResultCard key={result.id} result={result} />
          ))}
          {!results.length && (
            <Empty title="这个项目还没有成果" description="打开一个任务即可分享当前进展。" />
          )}
        </div>
      ) : tab === 'overview' ? (
        <div className="overview-layout">
          <section className="panel">
            <span className="eyebrow">项目目标</span>
            <h2>{project.description || project.name}</h2>
            <p className="muted">这是任务与成果的共享视图，不需要另外维护汇报数据。</p>
            <div className="overview-counts">
              {(['todo', 'in_progress', 'done'] as const).map((status) => (
                <div key={status}>
                  <strong>{tasks.filter((task) => task.status === status).length}</strong>
                  <StatusBadge status={status} />
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <h3>项目成员{data.mode === 'local-preview' ? ' · 示例资料' : ''}</h3>
            {members.map((member) => (
              <div className="member-line" key={member.id}>
                <Avatar user={member} />
                <strong>{member.name}</strong>
                <span className="muted">
                  {tasks.filter((task) => task.ownerUserId === member.id).length} 项相关工作
                </span>
              </div>
            ))}
          </section>
        </div>
      ) : (
        <>
          <div className="goal-strip">
            <span>当前目标</span>
            <strong>{project.description || '从任务开始，持续推进项目。'}</strong>
            <span className="spacer" />
            <small>{data.mode === 'team-local' ? '按项目权限协作' : '本地开发预览'}</small>
          </div>
          <div className="board-toolbar">
            <div className="segmented">
              <button
                className={view === 'board' ? 'selected' : ''}
                onClick={() => setView('board')}
              >
                <Icon name="board" size={15} />
                看板
              </button>
              <button className={view === 'list' ? 'selected' : ''} onClick={() => setView('list')}>
                <Icon name="list" size={15} />
                列表
              </button>
            </div>
            <label className="filter-input">
              <Icon name="search" size={15} />
              <input
                aria-label="筛选项目任务"
                placeholder="筛选任务…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
          </div>
          {view === 'board' ? (
            <div className="board">
              {(['todo', 'in_progress', 'done'] as const).map((status) => (
                <section className="board-column" key={status}>
                  <div className="column-heading">
                    <StatusBadge status={status} />
                    <span>{tasks.filter((task) => task.status === status).length}</span>
                    <button
                      className="icon-button"
                      aria-label="添加任务"
                      onClick={() => setOpen(true)}
                    >
                      <Icon name="plus" size={15} />
                    </button>
                  </div>
                  {tasks
                    .filter((task) => task.status === status)
                    .map((task) => (
                      <article
                        className={`task-card ${task.id === 'task-24' ? 'highlight' : ''}`}
                        key={task.id}
                      >
                        <Link to={`/tasks/${task.id}`}>
                          <small>{task.shortId}</small>
                          <h3>{task.title}</h3>
                          <p>{task.description || '打开任务，继续讨论和推进。'}</p>
                          {task.attention && <span className="badge amber">{task.attention}</span>}
                        </Link>
                        <div className="task-card-footer">
                          <Avatar
                            user={data.members.find((member) => member.id === task.ownerUserId)}
                            size="small"
                          />
                          <span>
                            {data.members.find((member) => member.id === task.ownerUserId)?.name ??
                              '我'}
                          </span>
                          <select
                            aria-label={`${task.shortId} 状态`}
                            value={task.status}
                            onChange={(e) => void changeStatus(task, e.target.value as TaskStatus)}
                          >
                            <option value="todo">待处理</option>
                            <option value="in_progress">进行中</option>
                            <option value="done">已完成</option>
                          </select>
                        </div>
                      </article>
                    ))}
                  <button className="add-inline" onClick={() => setOpen(true)}>
                    <Icon name="plus" size={15} />
                    添加任务
                  </button>
                </section>
              ))}
            </div>
          ) : (
            <div className="panel task-list">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
              {!tasks.length && (
                <Empty title="没有匹配的任务" description="试试其他搜索词，或新建任务。" />
              )}
            </div>
          )}
          <p className="hint board-hint">
            <Icon name="chat" size={15} />
            等待原因显示在任务中，不增加额外审批流程。状态菜单支持直接移动任务。
          </p>
        </>
      )}
      {open && <NewTask projectId={id} onClose={() => setOpen(false)} />}
    </div>
  );
}
function Results() {
  const { data } = useApp();
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>成果</h1>
          <p>看见做了什么，在同一个地方反馈和继续。</p>
        </div>
        <span className="badge neutral">{data.results.length} 项成果</span>
      </div>
      <div className="result-grid">
        {data.results.map((result) => (
          <ResultCard key={result.id} result={result} />
        ))}
        {!data.results.length && (
          <Empty title="还没有成果" description="进入任意任务，即可分享当前进展。" />
        )}
      </div>
    </div>
  );
}
function ResultPage({ id }: { id: string }) {
  const { value, error } = useLoad<{ result: Result; task: Task; messages: Message[] }>(
    `/results/${id}`,
  );
  const { changeStatus } = useApp();
  if (error) return <Empty title="无法打开成果" description={error} />;
  if (!value) return <div className="page">正在打开成果…</div>;
  const { result, task, messages } = value;
  return (
    <div className="page result-page">
      <div className="eyebrow result-eyebrow">
        {task.shortId} · <Link to={`/tasks/${task.id}`}>{task.title}</Link>{' '}
        <StatusBadge status={task.status} />
      </div>
      <div className="page-heading">
        <div>
          <h1>{result.title} · 当前成果</h1>
          <p>
            成果 v{result.revision} · {time(result.updatedAt)} 更新 ·{' '}
            {result.kind === 'demo-preview' ? '示例预览' : '已保存的文字成果'}
          </p>
        </div>
        <div className="flex-line">
          <Link to={`/tasks/${task.id}`} className="button secondary">
            <Icon name="arrow" />
            继续处理
          </Link>
          {task.status === 'done' ? (
            <Button onClick={() => void changeStatus(task, 'todo')}>重新打开</Button>
          ) : (
            <Button variant="primary" onClick={() => void changeStatus(task, 'done')}>
              <Icon name="check" />
              标记完成
            </Button>
          )}
        </div>
      </div>
      <div className="result-layout">
        <section className="panel result-preview">
          <div className="tabs panel-tabs">
            <span className="selected">
              {result.kind === 'demo-preview' ? '功能预览' : '成果说明'}
            </span>
            <span className="tab-summary">v{result.revision}</span>
          </div>
          {result.kind === 'demo-preview' ? (
            <OrderPreview />
          ) : (
            <div className="written-result">
              <span className="eyebrow">工作成果</span>
              <h2>{result.title}</h2>
              <p className="text-block">{result.body}</p>
            </div>
          )}
          <div className="result-caption">
            <Icon name="file" />
            <span>
              {result.kind === 'demo-preview'
                ? '演示数据 · CSV 可按当前筛选导出'
                : '这份成果与原任务关联，内容已保存在本地。'}
            </span>
          </div>
        </section>
        <aside className="panel feedback-panel">
          <div className="feedback-summary">
            <h3>本次做了什么</h3>
            <p className="text-block">{result.body}</p>
            <small>
              来源：{result.kind === 'demo-preview' ? '界面演示资料' : '成员分享'} · 非平台验收结论
            </small>
          </div>
          <div className="tabs panel-tabs">
            <span className="selected">
              反馈 <span className="count">{messages.length}</span>
            </span>
          </div>
          <div className="feedback-messages">
            <MessageList messages={messages} />
            {!messages.length && (
              <p className="muted compact-empty">写下你的想法，或提出下一步修改。</p>
            )}
          </div>
          <div className="composer-wrap">
            <MessageComposer taskId={task.id} resultId={result.id} />
          </div>
          <div className="optional-note">
            <Icon name="link" size={15} />
            内部评估、测试和发布由团队自行安排。
          </div>
        </aside>
      </div>
    </div>
  );
}
function Settings() {
  const { theme, density, toggleTheme, toggleDensity } = useAppearance();
  const { data, connected } = useApp();
  if (data.mode === 'team-local') return <TeamSettings />;
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>资源与设置</h1>
          <p>明确工具、模型与执行位置，不把不同能力混在一起。</p>
        </div>
        <span className="badge neutral">E2c1 · 本机预览</span>
      </div>
      <div className="notice-box">
        <Icon name="monitor" />
        <div>
          <strong>当前使用示例身份，数据仅保存在本机。</strong>
          <p>
            真实账号在独立的 team-local
            模式中启用。当前仍未接入远程节点；两种模式都不能通过代理开放到公网。
          </p>
        </div>
      </div>
      <NativeResources />
      <div className="panel settings-line">
        <div className="flex-line">
          <span className="system-avatar">
            <Icon name="spark" />
          </span>
          <div>
            <strong>模拟适配器</strong>
            <p>正常结束、等待回复、等待授权、失败与停止。不调用模型。</p>
          </div>
        </div>
        <span className="badge status-done">已启用</span>
      </div>
      <h3 className="settings-heading">本地环境</h3>
      <div className="panel settings-table">
        <div>
          <span>当前身份</span>
          <strong>{data.user.name} · 示例用户</strong>
        </div>
        <div>
          <span>数据保存</span>
          <strong>本地 SQLite · .hexu/preview.sqlite</strong>
        </div>
        <div>
          <span>事件连接</span>
          <strong>{connected ? '已连接' : '暂时断开，正在自动重连'}</strong>
        </div>
        <div>
          <span>模型费用</span>
          <strong>模拟不计费；原生费用以工具输出与提供方账单为准</strong>
        </div>
        <div>
          <span>外观</span>
          <Button onClick={toggleTheme}>
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} />
            {theme === 'light' ? '使用深色主题' : '使用浅色主题'}
          </Button>
        </div>
        <div>
          <span>信息密度</span>
          <Button onClick={toggleDensity}>
            <Icon name="density" size={16} />
            {density === 'compact' ? '使用舒适密度' : '使用紧凑密度'}
          </Button>
        </div>
      </div>
      <p className="settings-doc-link">
        <a
          href="https://github.com/ntygod/HEXU/tree/main/docs/development"
          target="_blank"
          rel="noreferrer"
        >
          查看仓库开发计划 <Icon name="external" size={14} />
        </a>
      </p>
    </div>
  );
}
function Search({ onClose, onNewTask }: { onClose(): void; onNewTask(): void }) {
  const { data } = useApp();
  const commands = [
    { name: '新建任务', icon: 'plus', action: onNewTask },
    {
      name: '打开工作台',
      icon: 'home',
      action: () => {
        go('/');
        onClose();
      },
    },
    {
      name: '查看项目',
      icon: 'folder',
      action: () => {
        go('/projects');
        onClose();
      },
    },
    {
      name: '查看成果',
      icon: 'box',
      action: () => {
        go('/results');
        onClose();
      },
    },
    {
      name: data.mode === 'team-local' ? '空间与账号' : '资源与设置',
      icon: 'settings',
      action: () => {
        go('/settings');
        onClose();
      },
    },
  ];
  const [q, setQ] = useState(''),
    [items, setItems] = useState<Task[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    if (!q.trim()) {
      setItems([]);
      setBusy(false);
      setError('');
      return () => controller.abort();
    }
    setBusy(true);
    setError('');
    const timer = setTimeout(
      () =>
        request<{ items: Task[] }>(`/search?q=${encodeURIComponent(q.trim())}`, {
          signal: controller.signal,
        })
          .then((result) => {
            setItems(result.items);
            setError('');
          })
          .catch((error) => {
            if (error.name !== 'AbortError') setError(error.message);
          })
          .finally(() => {
            if (!controller.signal.aborted) setBusy(false);
          }),
      150,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);
  return (
    <Dialog title="搜索与快捷操作" onClose={onClose} wide>
      <div className="dialog-body">
        <label className="search-field">
          <Icon name="search" />
          <input
            autoFocus
            aria-label="全局搜索"
            maxLength={160}
            placeholder="任务标题、编号，或新建、项目、设置…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>ESC</kbd>
        </label>
        {error && <p role="alert">{error}</p>}
        {commands.some((command) => command.name.includes(q.trim())) && (
          <div className="command-actions" aria-label="快捷操作">
            <span className="command-section-label">快捷操作</span>
            {commands
              .filter((command) => command.name.includes(q.trim()))
              .map((command) => (
                <button key={command.name} onClick={command.action}>
                  <Icon name={command.icon} size={17} />
                  <span>{command.name}</span>
                  <Icon name="arrow" size={14} />
                </button>
              ))}
          </div>
        )}
        <div className="search-results">
          {items.length > 0 && <span className="command-section-label">当前可见任务</span>}
          {items.map((task) => (
            <button
              key={task.id}
              onClick={() => {
                go(`/tasks/${task.id}`);
                onClose();
              }}
            >
              <Icon name="file" />
              <div>
                <strong>{task.title}</strong>
                <small>{task.shortId}</small>
              </div>
              <StatusBadge status={task.status} />
              <Icon name="arrow" size={15} />
            </button>
          ))}
          {!items.length && (
            <p className="muted compact-empty">
              {!q.trim()
                ? '输入关键词，搜索当前可见的任务。'
                : busy
                  ? '正在搜索…'
                  : '没有找到匹配的任务。'}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
