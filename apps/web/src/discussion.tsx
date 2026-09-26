import { useState, type FormEvent } from 'react';
import type { Message, Run } from '../../../packages/contracts/src/index.js';
import { request } from '../../../packages/client/src/index.js';
import { Avatar, Button, Icon, ToolMark } from '../../../packages/ui/src/index.js';
import { useApp, canEditTask, time, useTaskDraft } from './state.js';
import './discussion.css';

export function MessageComposer({
  taskId,
  resultId,
  run,
}: {
  taskId: string;
  resultId?: string;
  run?: Run;
}) {
  const { data, refresh, notice } = useApp();
  const [body, setBody] = useTaskDraft(
    taskId,
    resultId ? `feedback:${resultId}` : run ? `reply:${run.id}` : 'discussion',
  );
  const [busy, setBusy] = useState(false);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await request(run ? `/runs/${run.id}/inputs` : `/tasks/${taskId}/messages`, {
        method: 'POST',
        body: run ? { body } : { body, resultId: resultId ?? null },
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
export function MessageList({ messages }: { messages: Message[] }) {
  const { data } = useApp();
  return (
    <>
      {messages.map((message) => (
        <article className="message" key={message.id}>
          {message.actorType === 'human' ? (
            <Avatar user={data.members.find((member) => member.name === message.actorName)} />
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
            <p>{message.body}</p>
          </div>
        </article>
      ))}
    </>
  );
}
