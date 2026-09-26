import type { Message, Result, Task } from '../../../packages/contracts/src/index.js';
import { Button, Empty, Icon, StatusBadge } from '../../../packages/ui/src/index.js';
import { Link, time, useApp, useLoad, canEditTask } from './state.js';
import { MessageComposer, MessageList } from './discussion.js';
import { OrderPreview } from './preview.js';
import { ResultCard } from './work-cards.js';
import './work-pages.css';

export function Results() {
  const { data } = useApp();
  return (
    <div className="work-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">来自任务中的真实记录</span>
          <h1>成果</h1>
          <p>查看已分享的进展，提出反馈并继续工作。</p>
        </div>
        <span className="badge neutral">{data.results.length} 项成果</span>
      </header>
      <div className="work-result-grid">
        {data.results.map((result) => (
          <ResultCard key={result.id} result={result} />
        ))}
      </div>
      {!data.results.length && (
        <Empty title="还没有分享成果" description="在任务中保存一份成果说明，就会出现在这里。" />
      )}
    </div>
  );
}
export function ResultPage({ id }: { id: string }) {
  const { value, error } = useLoad<{ result: Result; task: Task; messages: Message[] }>(
    `/results/${id}`,
  );
  const { data, changeStatus } = useApp();
  if (error) return <Empty title="无法打开成果" description={error} />;
  if (!value)
    return (
      <div className="work-page" role="status">
        正在打开成果…
      </div>
    );
  const { result, task, messages } = value;
  const editable = canEditTask(data, task);
  return (
    <div className="work-page result-workspace">
      <div className="eyebrow result-eyebrow">
        <Link to={`/tasks/${task.id}`}>
          {task.shortId} · {task.title}
        </Link>
        <StatusBadge status={task.status} />
      </div>
      <header className="work-page-heading">
        <div>
          <h1>{result.title} · 当前成果</h1>
          <p>
            v{result.revision} · {time(result.updatedAt)} 更新 ·{' '}
            {result.kind === 'demo-preview' ? '示例预览' : '已保存的文字成果'}
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
            onClick={() => void changeStatus(task, task.status === 'done' ? 'todo' : 'done')}
          >
            {task.status === 'done' ? '重新打开' : '标记完成'}
          </Button>
        </div>
      </header>
      <div className="result-workspace-grid">
        <section className="result-main-surface">
          <div className="result-section-title">
            <Icon name={result.kind === 'demo-preview' ? 'monitor' : 'file'} />
            <h2>{result.kind === 'demo-preview' ? '示例预览' : '成果说明'}</h2>
          </div>
          {result.kind === 'demo-preview' ? (
            <OrderPreview />
          ) : (
            <article className="written-result">
              <h2>{result.title}</h2>
              <p className="text-block">{result.body}</p>
            </article>
          )}
          <div className="result-source">
            {result.kind === 'demo-preview'
              ? '演示数据 · CSV 可按当前筛选导出'
              : '由成员分享，关联到原任务。'}
          </div>
        </section>
        <aside className="result-feedback-surface">
          <div className="result-feedback-summary">
            <h2>本次做了什么</h2>
            <p className="text-block">{result.body}</p>
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
            <MessageComposer taskId={task.id} resultId={result.id} />
          </div>
          <p className="result-source">反馈保存在原任务，不会自动发送给执行工具。</p>
        </aside>
      </div>
    </div>
  );
}
