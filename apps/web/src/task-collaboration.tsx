import { useState } from 'react';
import type {
  TaskAgentCollaboration,
  TaskAgentCollaborationList,
} from '../../../packages/contracts/src/task-agent-collaborations.js';
import { taskAgentCollaborationsPath } from '../../../packages/client/src/task-agent-collaborations.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useAssistanceRead } from './assistance-common.js';
import { time } from './state.js';
import { useTaskAssistanceLocation } from './task-assistance-location.js';
import {
  collaborationStatus,
  collaborationDelivery,
  collaborationConfirmationSource,
} from './task-collaboration-status.js';
import './task-collaboration.css';

/** Main timeline shows one row per Assistance, never individual transport calls. */
export function TaskCollaboration({ taskId }: { taskId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const read = useAssistanceRead<TaskAgentCollaborationList>(
    taskAgentCollaborationsPath(taskId, cursor),
    5000,
  );
  const location = useTaskAssistanceLocation(taskId);
  return (
    <section className="task-collaboration" aria-label="任务内 Agent 协作">
      <header>
        <h3>Agent 协作</h3>
        <Button type="button" variant="ghost" onClick={() => location.open('all')}>
          全部协助
        </Button>
      </header>
      {read.error && (
        <p role="alert">
          {read.denied
            ? '当前协作访问权限已变化，先前记录已隐藏。'
            : '暂时无法刷新，下面保留上次确认的记录。'}{' '}
          <Button type="button" onClick={read.retry}>
            重读协作状态
          </Button>
        </p>
      )}
      {!read.value && !read.error && <p role="status">正在核对协作状态…</p>}
      {read.value?.items.length === 0 && (
        <p className="hint">
          还没有 Agent 协作。从一条讨论选择“请 Agent 协助”，先预览要分享的有限材料。
        </p>
      )}
      <ul>
        {read.value?.items.map((item) => {
          const status = collaborationStatus(item);
          return (
            <li key={item.assistanceId}>
              <button
                type="button"
                className="task-collaboration-row"
                onClick={() => location.open(item.assistanceId)}
                aria-label={`查看协作：${item.purpose}`}
              >
                <span className="task-collaboration-parties">
                  {item.requester.name} → {item.recipient.name}
                </span>
                <strong>{item.purpose}</strong>
                <span className={status.attention ? 'badge waiting' : 'badge neutral'}>
                  {status.label}
                </span>
                <span className="task-collaboration-detail">{status.detail}</span>
                <small>
                  {collaborationConfirmationSource[item.latestConfirmation.source]} ·{' '}
                  {time(item.latestConfirmation.at)}
                </small>
              </button>
            </li>
          );
        })}
      </ul>
      {(cursor || read.value?.nextCursor) && (
        <div className="assistance-actions">
          {cursor && (
            <Button type="button" onClick={() => setCursor(null)}>
              最新协作
            </Button>
          )}
          {read.value?.nextCursor && (
            <Button type="button" onClick={() => setCursor(read.value!.nextCursor)}>
              更早协作
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function CollaborationObservations({
  taskId,
  assistanceId,
}: {
  taskId: string;
  assistanceId: string;
}) {
  const read = useAssistanceRead<TaskAgentCollaboration>(
    `${taskAgentCollaborationsPath(taskId)}/${encodeURIComponent(assistanceId)}`,
    5000,
  );
  const item = read.value;
  return (
    <section className="collaboration-observations" aria-label="协作来源与送达观测">
      <h3>协作进展</h3>
      {read.error && (
        <p role="alert">
          {read.denied
            ? '当前无权读取任务协作观测。'
            : '暂时无法核对最新状态，保留上次确认的观测。'}{' '}
          <Button type="button" onClick={read.retry}>
            重读协作观测
          </Button>
        </p>
      )}
      {!item && !read.error && <p role="status">正在核对协作观测…</p>}
      {item && (
        <>
          <p>
            <strong>{collaborationStatus(item).label}</strong> · {collaborationStatus(item).detail}
          </p>
          <p className="hint">
            {item.requester.name}（{item.requester.owner.name}） → {item.recipient.name}（
            {item.recipient.owner.name}）
          </p>
          <p className="hint">
            发起来源：{item.initiatedBy.kind === 'agent' ? 'Agent 接入' : '真人操作'} ·{' '}
            {item.initiatedBy.name}
          </p>
          <p>{collaborationDelivery(item)}</p>
          <p className="hint">
            最近确认：{collaborationConfirmationSource[item.latestConfirmation.source]} ·{' '}
            {time(item.latestConfirmation.at)}
          </p>
          <details>
            <summary>查看状态依据</summary>
            <p>
              输入修订 {item.currentInputRevision} · 授权修订 {item.accessRevision}
            </p>
            <p>
              通知依据：{item.delivery.source}，输入修订 {item.delivery.inputRevision}
              。回调确认时间未记录；不以事件产生时间代替送达时间。
            </p>
            <p>
              原工作关联由接入端报告（host_reported）；成果领取不是使用确认，继续报告属于
              external_self_report。
            </p>
          </details>
        </>
      )}
    </section>
  );
}
