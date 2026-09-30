import { codeFeedbackHref } from './result-code-feedback.js';
import { RequestAiAssistance } from './ai-assistance.js';
import { RequestAssistance } from './assistance-create.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FeedbackReplyAction, feedbackMessageHref } from './result-feedback-reply.js';
import { FeedbackNextInputAction } from './feedback-next-input.js';
import { FeedbackFollowups } from './feedback-followups.js';
import type { Message, Run } from '../../../packages/contracts/src/index.js';
import { request } from '../../../packages/client/src/index.js';
import { Avatar, Button, Icon, ToolMark } from '../../../packages/ui/src/index.js';
import { useApp, canEditTask, time, useTaskDraft, Link } from './state.js';
import './discussion.css';
import { PublishAgreement } from './agreement-create.js';
import { DraftFromMessage } from './ai-drafts.js';

export function MessageComposer({
  taskId,
  resultId,
  resultRevisionId,
  run,
}: {
  taskId: string;
  resultId?: string;
  resultRevisionId?: string;
  run?: Run;
}) {
  const { data, refresh, notice } = useApp();
  const [body, setBody] = useTaskDraft(
    taskId,
    resultId
      ? `feedback:${resultId}:${resultRevisionId ?? 'general'}`
      : run
        ? `reply:${run.id}`
        : 'discussion',
  );
  const [busy, setBusy] = useState(false);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await request(run ? `/runs/${run.id}/inputs` : `/tasks/${taskId}/messages`, {
        method: 'POST',
        body: run
          ? { body }
          : { body, resultId: resultId ?? null, ...(resultRevisionId ? { resultRevisionId } : {}) },
      });
      setBody('');
      await refresh();
    } catch (error) {
      notice((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const task = data.tasks.find((t) => t.id === taskId);
  if (task && !canEditTask(data, task))
    return <p className="team-readonly">你可以查看此项目，修改和回复需要编辑权限。</p>;
  return (
    <form className="composer" onSubmit={send}>
      <textarea
        aria-label={run ? '回复模拟执行' : resultId ? '成果反馈' : '任务评论'}
        placeholder={
          run
            ? '回答模拟执行的问题…'
            : resultId
              ? '写下反馈，或提出修改…'
              : '补充要求、记录决定，或与同事讨论…'
        }
        value={body}
        disabled={busy}
        maxLength={12000}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div>
        <span>⌘ / Ctrl + Enter 发送</span>
        <Button
          variant="primary"
          type="submit"
          busy={busy}
          disabled={!body.trim()}
          aria-label={run ? '发送执行回复' : resultId ? '发送反馈' : '发送评论'}
        >
          <Icon name="arrow" size={17} />
        </Button>
      </div>
    </form>
  );
}
export function MessageList({
  messages,
  focusMessageId,
}: {
  messages: Message[];
  focusMessageId?: string;
}) {
  const { data } = useApp();
  const focused = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusMessageId || !focused.current) return;
    const frame = requestAnimationFrame(() => {
      focused.current?.scrollIntoView({ block: 'center' });
      focused.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusMessageId]);
  return (
    <>
      {messages.map((message) => (
        <article
          className={`message${message.id === focusMessageId ? ' message-feedback-focus' : ''}`}
          key={message.id}
          data-message-id={message.id}
          ref={message.id === focusMessageId ? focused : undefined}
          tabIndex={message.id === focusMessageId ? -1 : undefined}
        >
          {message.actorType === 'human' ? (
            <Avatar
              user={data.members.find((member) =>
                message.createdByUserId
                  ? member.id === message.createdByUserId
                  : member.name === message.actorName,
              )}
            />
          ) : message.actorType === 'agent' ? (
            <ToolMark tool={message.actorName.startsWith('Claude') ? 'claude-code' : 'codex'} />
          ) : (
            <span className="system-avatar">
              <Icon name="spark" size={17} />
            </span>
          )}
          <div className="message-content">
            <div className="message-meta">
              <strong>{message.actorName}</strong>
              <time>{time(message.createdAt)}</time>
              {message.actorType === 'agent' && (
                <span className="badge neutral">
                  {message.actorName.endsWith('独立节点')
                    ? '节点'
                    : message.actorName.endsWith('原生')
                      ? '原生'
                      : '模拟'}
                </span>
              )}
            </div>
            {message.replyTo && message.resultId && message.resultRevisionId && (
              <section className="feedback-reply-source" aria-label="此回复对应的原反馈">
                <Link to={feedbackMessageHref(message, message.replyTo.messageId)}>
                  回复 {message.replyTo.actorName} · 查看原反馈
                </Link>
                <p>
                  {message.replyTo.bodyPreview}
                  {message.replyTo.bodyTruncated ? '…' : ''}
                </p>
              </section>
            )}
            {message.codeAnchor && message.resultId && message.resultRevisionId && (
              <p className="message-code-anchor">
                <Link to={codeFeedbackHref(message)}>
                  查看固定代码反馈位置：{message.codeAnchor.path} ·{' '}
                  {message.codeAnchor.side === 'before' ? '起点文件' : '所选文件'} ·{' '}
                  {message.codeAnchor.range
                    ? `第${message.codeAnchor.range.start}–${message.codeAnchor.range.end}行`
                    : '整个文件'}
                </Link>
              </p>
            )}
            <p>{message.body}</p>
            {message.actorType === 'human' && message.resultId && message.resultRevisionId && (
              <>
                <FeedbackReplyAction message={message} />
                <FeedbackNextInputAction message={message} />
                <FeedbackFollowups message={message} />
              </>
            )}
            <PublishAgreement message={message} />
            <DraftFromMessage message={message} />
            <RequestAssistance message={message} />
            <RequestAiAssistance message={message} />
          </div>
        </article>
      ))}
    </>
  );
}
