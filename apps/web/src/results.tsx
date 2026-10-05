import { useEffect, useRef, useState } from 'react';
import type { ResultDetail } from '../../../packages/contracts/src/results.js';
import { Button, Empty, Icon, Skeleton, StatusBadge } from '../../../packages/ui/src/index.js';
import { Link, time, useApp, canEditTask, go } from './state.js';
import { useAssistanceRead } from './assistance-common.js';
import { ResultSource } from './result-source.js';
import { ResultReferencePanel } from './result-references.js';
import { PrepareIntegration } from './integrations.js';
import { MessageComposer, MessageList } from './discussion.js';
import { OrderPreview } from './preview.js';
import { ResultCard } from './work-cards.js';
import {
  filterResultLibrary,
  parseResultLibraryFilters,
  RESULT_LIBRARY_QUERY_LIMIT,
  resultBodyMatchSnippet,
  resultLibraryUrl,
} from './result-library-filters.js';
import './work-pages.css';
import './result-library.css';

export function Results() {
  const { data } = useApp();
  const [search, setSearch] = useState(() => location.search);
  const queryInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const update = () => setSearch(location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  // Re-derive from current data so project availability and matches stay current.
  const filters = parseResultLibraryFilters(search, data.projects);
  const hasProjectFilter = new URLSearchParams(search).has('projectId');
  const project = data.projects.find((item) => item.id === filters.projectId);
  const results = filterResultLibrary(data.results, data.tasks, filters);
  const scopeResults = filterResultLibrary(data.results, data.tasks, { ...filters, q: '' });
  const tasksById = new Map(data.tasks.map((task) => [task.id, task]));
  const query = filters.q.trim();
  const scope = project
    ? `${project.name}${project.archivedAt ? ' · 已归档' : ''}`
    : '全部项目与个人工作';
  function update(changes: { q?: string; projectId?: string }, replace = false) {
    const url = resultLibraryUrl(location.href, changes);
    history[replace ? 'replaceState' : 'pushState'](history.state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  function clear() {
    update({ q: '', projectId: '' });
    queryInput.current?.focus();
  }
  return (
    <div className="work-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">来自任务中的真实记录</span>
          <h1>成果</h1>
          <p>按项目与关键词查找成果，查看已分享的进展并继续工作。</p>
        </div>
      </header>
      <section className="result-library-filters" aria-label="成果筛选">
        <div className="result-library-controls">
          <label className="result-library-project">
            项目
            <select
              aria-label="成果项目筛选"
              value={filters.projectId || (hasProjectFilter ? 'invalid' : '')}
              onChange={(event) => update({ projectId: event.target.value })}
            >
              <option value="">全部项目与个人工作</option>
              {hasProjectFilter && filters.error && !project && (
                <option value={filters.projectId || 'invalid'} disabled>
                  链接中的项目筛选无效
                </option>
              )}
              {data.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.archivedAt ? ' · 已归档' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="result-library-query">
            关键词
            <input
              ref={queryInput}
              type="search"
              aria-label="搜索成果"
              aria-describedby="result-library-search-help"
              value={filters.q}
              maxLength={RESULT_LIBRARY_QUERY_LIMIT}
              placeholder="成果标题、正文或任务标题、编号…"
              onChange={(event) => update({ q: event.target.value }, true)}
            />
          </label>
          {filters.active && <Button onClick={clear}>清除成果筛选</Button>}
        </div>
        <p className="result-library-help" id="result-library-search-help">
          搜索成果当前版本的标题、正文，以及关联任务的标题和编号；不包含历史版本。
        </p>
        <p className="result-library-count" role="status" aria-label="成果筛选计数">
          {filters.error
            ? '当前筛选无效 · 0 项成果'
            : query
              ? `${scope} · 匹配 ${results.length} / ${scopeResults.length} 项成果`
              : `${scope} · ${scopeResults.length} 项成果`}
        </p>
        {filters.error && <p role="alert">{filters.error}</p>}
      </section>
      <div className="work-result-grid stagger">
        {results.map((result) => (
          <ResultCard
            key={result.id}
            result={result}
            showContext
            bodyMatch={resultBodyMatchSnippet(result, tasksById.get(result.taskId), filters.q)}
          />
        ))}
      </div>
      {!results.length && (
        <Empty
          title={
            filters.error
              ? '无法应用成果筛选'
              : !scopeResults.length
                ? project
                  ? '这个项目还没有可见成果'
                  : '还没有分享成果'
                : '没有匹配的成果'
          }
          description={
            filters.error
              ? '请修改筛选条件或清除筛选后继续查找。'
              : !scopeResults.length
                ? project
                  ? '当前项目没有可查看的成果，可以选择其他项目或清除筛选。'
                  : '在任务中保存一份成果说明，就会出现在这里。'
                : `在“${scope}”中没有找到包含“${query}”的当前成果，试试其他关键词。`
          }
          action={
            !filters.active ? (
              <Link className="button soft" to="/projects">
                去看项目 <Icon name="arrow" size={15} />
              </Link>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
export function ResultPage({ id, revisionId }: { id: string; revisionId?: string }) {
  const [pinned, setPinned] = useState(revisionId);
  const read = useAssistanceRead<ResultDetail>(
    `/results/${id}${pinned ? `/versions/${pinned}` : ''}`,
  );
  const { value, error } = read;
  useEffect(() => {
    if (!pinned && value) setPinned(value.version.id);
  }, [pinned, value]);
  const { data, changeStatus } = useApp();
  if (read.denied) return <Empty title="无法打开成果" description={error} />;
  if (!value && error)
    return (
      <Empty
        title="无法打开成果"
        description={error}
        action={<Button onClick={read.retry}>重读成果</Button>}
      />
    );
  if (!value)
    return (
      <div className="work-page" role="status" aria-label="正在打开成果">
        <Skeleton lines={2} width="42%" />
        <Skeleton lines={3} />
        <Skeleton lines={1} width="68%" />
      </div>
    );
  const { result, task, version, messages, revisions, unversionedMessages } = value;
  const editable = canEditTask(data, task);
  return (
    <div className="work-page result-workspace">
      {error && (
        <p role="alert">
          {error}
          <Button onClick={read.retry}>重读成果</Button>
        </p>
      )}
      <div className="eyebrow result-eyebrow">
        <Link to={`/tasks/${task.id}`}>
          {task.shortId} · {task.title}
        </Link>
        <StatusBadge status={task.status} />
      </div>
      <header className="work-page-heading">
        <div>
          <h1>
            {version.title} ·{' '}
            {version.revision === result.revision ? '当前成果' : `版本 ${version.revision}`}
          </h1>
          <p>
            v{version.revision} · {time(version.createdAt)} 保存 ·{' '}
            {version.kind === 'demo-preview'
              ? '示例预览'
              : version.source.kind === 'work_branch' && version.source.code !== 'not_captured'
                ? '已保存说明与代码引用'
                : '已保存的文字成果'}
          </p>
        </div>
        <div className="flex-line">
          <Link className="button secondary" to={`/tasks/${task.id}`}>
            <Icon name="arrow" />
            继续处理
          </Link>
          <Button
            variant="primary"
            disabled={!editable}
            onClick={() =>
              void changeStatus(
                task,
                task.status === 'done' || task.status === 'cancelled' ? 'todo' : 'done',
              )
            }
          >
            {task.status === 'done' || task.status === 'cancelled' ? '重新打开' : '标记完成'}
          </Button>
        </div>
      </header>
      <div className="result-version-navigation">
        <label className="field result-version-picker">
          查看固定版本
          <select
            aria-label="查看固定版本"
            value={version.id}
            onChange={(e) => go(`/results/${id}/versions/${e.target.value}`)}
          >
            {revisions.map((v) => (
              <option value={v.id} key={v.id}>
                v{v.revision} · {v.title} · {time(v.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <div className="result-version-address">
          <Link className="button soft" to={`/results/${result.id}/versions/${version.id}`}>
            打开此版本固定链接
          </Link>
          <p>此地址始终打开当前查看的版本。</p>
        </div>
      </div>
      {version.revision !== result.revision && (
        <p className="work-branch-notice">
          正在查看历史版本 v{version.revision}，最新为 v{result.revision}
          ；反馈仍关联当前查看的版本。
        </p>
      )}
      <div className="result-workspace-grid">
        <section
          className={`result-main-surface${version.source.kind === 'work_branch' ? ' fixed-version-surface' : ''}`}
        >
          <div className="result-section-title">
            <Icon name={version.kind === 'demo-preview' ? 'monitor' : 'file'} />
            <h2>{version.kind === 'demo-preview' ? '示例预览' : '成果说明'}</h2>
          </div>
          {version.kind === 'demo-preview' ? (
            <OrderPreview />
          ) : (
            <article className="written-result">
              <h2>{version.title}</h2>
              <p className="text-block">{version.body}</p>
              {version.limitations && (
                <>
                  <h3>已知限制</h3>
                  <p className="text-block">{version.limitations}</p>
                </>
              )}
            </article>
          )}
          {version.source.kind === 'work_branch' && (
            <ResultSource source={version.source} evidence={value.code} revisionId={version.id} />
          )}
          <PrepareIntegration version={version} />
          <div className="result-source">
            {version.kind === 'demo-preview'
              ? '演示数据 · CSV 可按当前筛选导出'
              : version.source.kind === 'legacy'
                ? '历史成果，仅保留已知版本；原作者和更早版本未记录。'
                : `由 ${version.createdBy?.name ?? '成员'} 保存，关联到原任务。`}
          </div>
        </section>
        <aside className="result-feedback-surface">
          <div className="result-feedback-summary">
            <h2>此版本的反馈</h2>
            <p>v{version.revision} 的讨论会保留在这个版本，不随新成果迁移。</p>
          </div>
          <div className="result-section-title">
            <h2>反馈</h2>
            <span className="count">{messages.length}</span>
          </div>
          <div className="result-discussion">
            <MessageList messages={messages} />
            {!messages.length && (
              <p className="work-empty-text">写下你的反馈，或提出下一步修改。</p>
            )}
          </div>
          <div className="composer-wrap">
            <MessageComposer
              key={version.id}
              taskId={task.id}
              resultId={result.id}
              resultRevisionId={version.id}
            />
          </div>
          {!!unversionedMessages.length && (
            <details className="result-discussion">
              <summary>未指定版本的历史反馈（{unversionedMessages.length}）</summary>
              <MessageList messages={unversionedMessages} />
            </details>
          )}
          <p className="result-source">反馈保存在原任务，不会自动发送给执行工具。</p>
        </aside>
      </div>
      <ResultReferencePanel
        key={`${result.id}:${version.id}`}
        resultId={result.id}
        revisionId={version.id}
        revision={version.revision}
        editable={editable}
      />
    </div>
  );
}
