import type { BranchResultSource } from '../../../packages/contracts/src/results.js';
import { MemberResultVersions } from './member-result-versions.js';
import { CodeFeedbackEntry } from './result-code-feedback.js';
import { useEffect, useState } from 'react';
import type { ResultDetail } from '../../../packages/contracts/src/results.js';
import { Button, Empty, Icon, Skeleton, StatusBadge } from '../../../packages/ui/src/index.js';
import { Link, time, useApp, canEditTask, go } from './state.js';
import { useAssistanceRead } from './assistance-common.js';
import { ResultSource } from './result-source.js';
import { PrepareIntegration } from './integrations.js';
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
      <div className="work-result-grid stagger">
        {data.results.map((result) => (
          <ResultCard key={result.id} result={result} />
        ))}
      </div>
      {!data.results.length && (
        <Empty
          title="还没有分享成果"
          description="在任务中保存一份成果说明，就会出现在这里。"
          action={
            <Link className="button soft" to="/projects">
              去看项目 <Icon name="arrow" size={15} />
            </Link>
          }
        />
      )}
    </div>
  );
}
export function ResultPage({
  id,
  revisionId,
  feedbackId,
  messageId,
}: {
  id: string;
  revisionId?: string;
  feedbackId?: string;
  messageId?: string;
}) {
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
      {messageId && !messages.some((message) => message.id === messageId) && (
        <p className="form-error" role="alert">
          此固定版本没有该反馈消息，没有跳到最新版本或其他任务。
        </p>
      )}
      {feedbackId &&
        !messages.some((message) => message.id === feedbackId && message.codeAnchor) && (
          <p className="form-error" role="alert">
            此固定版本没有该代码反馈位置，没有跳到最新版本或读取其他文件。
          </p>
        )}
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
          <MemberResultVersions detail={value} />
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
            <CodeFeedbackEntry task={task} version={version} evidence={value.code}>
              {(onCodeFeedback) => (
                <ResultSource
                  source={version.source as BranchResultSource}
                  evidence={value.code}
                  revisionId={version.id}
                  onCodeFeedback={onCodeFeedback}
                  focusAnchor={messages.find((message) => message.id === feedbackId)?.codeAnchor}
                />
              )}
            </CodeFeedbackEntry>
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
            <MessageList messages={messages} focusMessageId={messageId} />
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
    </div>
  );
}
