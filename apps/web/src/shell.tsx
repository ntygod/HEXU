import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar, Brand, Icon } from '../../../packages/ui/src/index.js';
import { SpaceSwitcher } from './identity.js';
import { Link, useApp, usePath } from './state.js';
import { useAppearance } from './appearance.js';
import './shell.css';

export function AppShell({ children, onSearch }: { children: ReactNode; onSearch(): void }) {
  const { data, connected } = useApp();
  const { theme, density, toggleTheme, toggleDensity } = useAppearance();
  const path = usePath();
  const [section, id] = path.split('/').filter(Boolean);
  const active = section ?? 'workbench';
  const task = active === 'tasks' ? data.tasks.find((item) => item.id === id) : undefined;
  const result = active === 'results' ? data.results.find((item) => item.id === id) : undefined;
  const sourceTask =
    task ?? (result ? data.tasks.find((item) => item.id === result.taskId) : undefined);
  const project = data.projects.find(
    (item) => item.id === (sourceTask?.projectId ?? (active === 'projects' ? id : undefined)),
  );
  const preferenceKey = `hexu-guide:${data.mode}:${data.user.id}:${data.space?.id ?? 'preview'}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(preferenceKey) === 'collapsed';
    } catch {
      return false;
    }
  });
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1024px)').matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const guideRef = useRef<HTMLElement>(null);
  const guideToggle = useRef<HTMLButtonElement>(null);
  const guideOpen = narrow ? mobileOpen : !collapsed;
  useEffect(() => {
    const media = matchMedia('(max-width: 1024px)');
    const change = () => {
      setNarrow(media.matches);
      setMobileOpen(false);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    setMobileOpen(false);
  }, [path]);
  useEffect(() => {
    if (!mobileOpen) return;
    guideRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        guideToggle.current?.focus();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [mobileOpen]);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(preferenceKey) === 'collapsed');
    } catch {
      setCollapsed(false);
    }
  }, [preferenceKey]);
  function toggleGuide() {
    if (narrow) {
      if (mobileOpen) guideToggle.current?.focus();
      setMobileOpen((value) => !value);
    } else {
      const next = !collapsed;
      setCollapsed(next);
      try {
        localStorage.setItem(preferenceKey, next ? 'collapsed' : 'expanded');
      } catch {}
    }
  }
  const tasks = data.tasks
    .filter((item) => (project ? item.projectId === project.id : true))
    .slice(0, 8);
  const results = data.results
    .filter((item) =>
      sourceTask
        ? item.taskId === sourceTask.id
        : project
          ? data.tasks.some((t) => t.id === item.taskId && t.projectId === project.id)
          : true,
    )
    .slice(0, 3);
  const navigation = [
    { to: '/', icon: 'home', label: '工作台', key: 'workbench' },
    { to: '/projects', icon: 'folder', label: '项目', key: 'projects' },
    { to: '/results', icon: 'box', label: '成果', key: 'results' },
    { to: '/settings', icon: 'settings', label: '资源与设置', key: 'settings' },
  ];
  return (
    <div className="app-shell" data-guide={guideOpen ? 'open' : 'closed'}>
      <header className="workbench-topbar">
        <Link to="/" className="workbench-brand" title="HEXU 工作台">
          <Brand />
        </Link>
        <SpaceSwitcher />
        <button className="command-trigger" onClick={onSearch} aria-label="搜索与快捷操作">
          <Icon name="search" size={16} />
          <span>搜索任务或执行操作…</span>
          <kbd>Ctrl / ⌘ K</kbd>
        </button>
        <span
          className="workbench-connection"
          title={connected ? '任务事件已连接' : '任务事件暂时断开，正在重连'}
        >
          <span className={`connection-dot ${connected ? 'online' : ''}`} />
          <span>{connected ? '事件已连接' : '正在重连'}</span>
        </span>
        <button
          className="icon-button"
          onClick={toggleDensity}
          aria-label={density === 'compact' ? '切换舒适密度' : '切换紧凑密度'}
          title={density === 'compact' ? '切换舒适密度' : '切换紧凑密度'}
        >
          <Icon name="density" size={17} />
        </button>
        <button
          className="icon-button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
          title={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
        <Link to="/settings" className="workbench-profile" title={data.user.name}>
          <Avatar user={data.user} />
        </Link>
      </header>
      <div className="workbench-frame">
        <nav className="navigation-rail" aria-label="主导航">
          {navigation.map((item) => {
            const current = active === item.key || (item.key === 'projects' && active === 'tasks');
            return (
              <Link
                key={item.key}
                to={item.to}
                title={item.label}
                aria-current={current ? 'page' : undefined}
                className={`rail-link ${current ? 'active' : ''}`}
              >
                <Icon name={item.icon} size={19} />
                <span className="visually-hidden">{item.label}</span>
              </Link>
            );
          })}
          <button
            className="rail-link rail-command"
            onClick={onSearch}
            aria-label="打开命令面板"
            title="搜索与快捷操作"
          >
            <Icon name="search" size={18} />
          </button>
        </nav>
        {narrow && guideOpen && (
          <button
            className="guide-backdrop"
            aria-label="关闭项目导引栏"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          className="context-guide"
          ref={guideRef}
          id="project-guide"
          hidden={!guideOpen}
          aria-label="项目导引栏"
        >
          <div className="context-guide-heading">
            <strong>{project?.name ?? '项目与工作'}</strong>
            <button className="icon-button" onClick={toggleGuide} aria-label="收起项目导引栏">
              <Icon name="panel" size={16} />
            </button>
          </div>
          <div className="context-guide-content">
            <div className="context-group">
              <span className="context-label">当前可见项目</span>
              {data.projects.map((item) => (
                <Link
                  key={item.id}
                  to={`/projects/${item.id}`}
                  className={`context-link ${project?.id === item.id ? 'selected' : ''}`}
                  title={item.name}
                >
                  <Icon name="folder" size={15} />
                  <span>{item.name}</span>
                </Link>
              ))}
              {!data.projects.length && <p className="context-empty">还没有可访问的项目</p>}
              <Link to="/projects" className="context-link context-more">
                <Icon name="plus" size={15} />
                <span>查看与新建项目</span>
              </Link>
            </div>
            <div className="context-group">
              <span className="context-label">{project ? '项目任务' : '最近任务'}</span>
              {tasks.map((item) => (
                <Link
                  key={item.id}
                  to={`/tasks/${item.id}`}
                  className={`context-task ${sourceTask?.id === item.id ? 'selected' : ''}`}
                  title={item.title}
                >
                  <span className="context-task-meta">
                    <span>{item.shortId}</span>
                    <span>
                      {item.status === 'done'
                        ? '已完成'
                        : item.status === 'in_progress'
                          ? '进行中'
                          : item.status === 'cancelled'
                            ? '已取消'
                            : '待处理'}
                    </span>
                  </span>
                  <strong>{item.title}</strong>
                </Link>
              ))}
              {!tasks.length && <p className="context-empty">从一个问题开始新的工作</p>}
            </div>
            {results.length > 0 && (
              <div className="context-group">
                <span className="context-label">{sourceTask ? '任务成果' : '近期成果'}</span>
                {results.map((item) => (
                  <Link
                    key={item.id}
                    to={`/results/${item.id}`}
                    className={`context-link ${result?.id === item.id ? 'selected' : ''}`}
                    title={item.title}
                  >
                    <Icon name="box" size={15} />
                    <span>{item.title}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div className="context-guide-footer">
            <Avatar user={data.user} size="small" />
            <div>
              <strong>{data.user.name}</strong>
              <small>
                {data.mode === 'team-local'
                  ? '真实账号 · ' + (data.space?.kind === 'personal' ? '个人空间' : '团队空间')
                  : '示例身份 · 本机预览'}
              </small>
            </div>
          </div>
        </aside>
        <div className="workbench-main">
          <div className="workbench-location">
            <button
              className="icon-button"
              ref={guideToggle}
              onClick={toggleGuide}
              aria-label={guideOpen ? '收起项目导航' : '展开项目导航'}
              aria-expanded={guideOpen}
              aria-controls="project-guide"
            >
              <Icon name="panel" size={17} />
            </button>
            <div className="workbench-breadcrumbs">
              <Link
                to={
                  project
                    ? '/projects'
                    : active === 'results'
                      ? '/results'
                      : active === 'settings'
                        ? '/settings'
                        : '/'
                }
              >
                {project
                  ? '项目'
                  : active === 'results'
                    ? '成果'
                    : active === 'settings'
                      ? '资源与设置'
                      : '工作台'}
              </Link>
              {project && (
                <>
                  <span>/</span>
                  <Link to={`/projects/${project.id}`} title={project.name}>
                    {project.name}
                  </Link>
                </>
              )}
              {sourceTask && (
                <>
                  <span>/</span>
                  <Link to={`/tasks/${sourceTask.id}`}>{sourceTask.shortId}</Link>
                </>
              )}
            </div>
            <span className="preview-label">
              {data.mode === 'team-local'
                ? '本机团队模式 · 本人授权节点执行'
                : '本地开发预览 · 执行模式明确标识'}
            </span>
          </div>
          <main id="main-content">{children}</main>
          <footer className="workbench-footer">
            <span>HEXU · 让人和 AI，一起交付。</span>
            <span>{data.mode === 'team-local' ? '本机团队模式' : '示例数据 · 本地预览'}</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
