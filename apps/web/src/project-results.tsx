import type {
  ProjectResultPage,
  ProjectResultSummary,
} from '../../../packages/contracts/src/project-results.js';
import { Button, Empty, Icon, StatusBadge } from '../../../packages/ui/src/index.js';
import { useAssistanceRead } from './assistance-common.js';
import { Link, time } from './state.js';
import './project-results.css';

function resultPageUrl(projectId: string, cursor = '') {
  const query = new URLSearchParams(location.search);
  query.set('tab', 'results');
  query.delete('source');
  query.delete('agreement');
  if (cursor) query.set('resultsCursor', cursor);
  else query.delete('resultsCursor');
  return `/projects/${encodeURIComponent(projectId)}?${query}`;
}

function ProjectResultRow({ item }: { item: ProjectResultSummary }) {
  return (
    <article className="project-result-row" data-result-id={item.id} aria-label={item.title}>
      <div className="project-result-content">
        <div className="project-result-meta">
          <Icon name={item.kind === 'demo-preview' ? 'monitor' : 'file'} size={16} />
          <span>{item.kind === 'demo-preview' ? '示例预览' : '文字成果'}</span>
          <span className="badge neutral">当前 v{item.revision}</span>
          <span>
            此版本保存于 <time dateTime={item.savedAt}>{time(item.savedAt)}</time>
          </span>
        </div>
        <h3>{item.title}</h3>
        <p className="project-result-excerpt">{item.excerpt || '此版本没有文字说明。'}</p>
        {item.excerptTruncated && (
          <p className="project-result-truncated">摘要已截取，完整内容见此版本</p>
        )}
        <div className="project-result-task">
          <span className="project-result-task-title">
            {item.task.shortId} · {item.task.title}
          </span>
          <span className="project-result-task-status">
            任务当前状态 <StatusBadge status={item.task.status} />
          </span>
        </div>
      </div>
      <div className="project-result-actions">
        <Link
          className="button soft"
          to={`/results/${encodeURIComponent(item.id)}/versions/${encodeURIComponent(item.revisionId)}`}
          title={`查看 ${item.title} 的固定版本 v${item.revision}`}
        >
          查看此版本 <Icon name="arrow" size={15} />
        </Link>
        <Link className="button secondary" to={`/tasks/${encodeURIComponent(item.task.id)}`}>
          打开任务
        </Link>
      </div>
    </article>
  );
}

export function ProjectResults({ projectId, cursor }: { projectId: string; cursor: string }) {
  const read = useAssistanceRead<ProjectResultPage>(
    `/projects/${encodeURIComponent(projectId)}/results${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  return (
    <section className="project-results" aria-label="项目成果汇总">
      <header className="project-results-heading">
        <div>
          <h2>项目成果</h2>
          <p>按首次分享时间从新到旧；每项显示最近读取的当前版本，打开后固定到此版本。</p>
        </div>
        {read.value && <span className="badge neutral">本页 {read.value.items.length} 项</span>}
      </header>
      {read.error && (
        <div className="project-results-error" role="alert">
          <strong>{read.denied ? '无法访问此页成果' : '项目成果读取失败'}</strong>
          <p>{read.error}</p>
          {read.value && <p>下面保留上次读取的摘要，版本与任务状态可能已变化。</p>}
          {read.denied && <p>此页摘要已清空，请核对当前权限或分页链接。</p>}
          <Button onClick={read.retry}>重读项目成果</Button>
        </div>
      )}
      {!read.value && !read.error && <p role="status">正在读取项目成果…</p>}
      {read.value && !read.value.items.length && (
        <Empty
          icon="box"
          title={cursor ? '此页没有更多可见成果' : '这个项目还没有可见成果'}
          description={
            cursor
              ? '可以返回第一页查看当前有权访问的成果。'
              : '任务中已分享的成果会出现在这里，已取消任务的历史成果也会保留。'
          }
        />
      )}
      {!!read.value?.items.length && (
        <div className="project-result-list">
          {read.value.items.map((item) => (
            <ProjectResultRow key={item.id} item={item} />
          ))}
        </div>
      )}
      {(cursor || read.value?.nextCursor) && (
        <nav className="project-results-pagination" aria-label="项目成果分页">
          {cursor ? (
            <Link className="button secondary" to={resultPageUrl(projectId)}>
              返回第一页
            </Link>
          ) : (
            <span className="hint">第一页</span>
          )}
          {read.value?.nextCursor ? (
            <Link className="button secondary" to={resultPageUrl(projectId, read.value.nextCursor)}>
              较早成果 <Icon name="arrow" size={15} />
            </Link>
          ) : (
            read.value && <span className="hint">已到本次读取的最后一页</span>
          )}
        </nav>
      )}
    </section>
  );
}
