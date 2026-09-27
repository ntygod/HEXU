import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  AssistanceDetail,
  AssistanceList,
  AssistanceState,
} from '../../../packages/contracts/src/assistance.js';
import { Button, Dialog, Icon } from '../../../packages/ui/src/index.js';
import { Link, time, useApp } from './state.js';
import {
  assistancePath,
  useAssistanceRead,
  useAssistanceCommand,
  AssistanceFeedback,
} from './assistance-common.js';
import './assistance.css';
const states: Record<AssistanceState, string> = {
  open: '等待同事回复',
  responded: '同事已回复',
  closed: '已结束',
  cancelled: '已撤销分享',
};
export function TaskAssistances({ task }: { task: Task }) {
  const { data } = useApp();
  const [open, setOpen] = useState(false),
    [id, setId] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  if (data.mode !== 'team-local') return null;
  return (
    <>
      <button
        className="text-button"
        onClick={() => {
          setId(null);
          setOpen(true);
        }}
      >
        协助记录
      </button>
      {open && (
        <Dialog title="任务协助" drawer onClose={() => !busy && setOpen(false)}>
          <div className="assistance-drawer">
            {id ? (
              <>
                <div className="assistance-tabs">
                  <Button type="button" disabled={busy} onClick={() => setId(null)}>
                    返回协助记录
                  </Button>
                </div>
                <AssistanceThread id={id} onBusy={setBusy} />
              </>
            ) : (
              <AssistanceItems taskId={task.id} onSelect={setId} />
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
export function AssistanceWorkbench() {
  const { data } = useApp();
  if (data.mode !== 'team-local') return null;
  return (
    <section className="assistance-entry">
      <Icon name="chat" />
      <div>
        <strong>同事协助</strong>
        <p>查看收到的片段和回复，或继续你发起的问题。</p>
        <Link to="/assistances">
          打开我的协助 <Icon name="arrow" size={14} />
        </Link>
      </div>
    </section>
  );
}
export function AssistancePage({ id }: { id?: string }) {
  const { data } = useApp();
  return (
    <div className="work-page assistance-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">{data.space?.name}</span>
          <h1>{id ? '协助详情' : '我的协助'}</h1>
          <p>只围绕明确分享的材料讨论，回复留在原任务关联的协助记录。</p>
        </div>
        <Link to={id ? '/assistances' : '/'} className="button secondary">
          {id ? '返回我的协助' : '返回工作台'}
        </Link>
      </header>
      {data.mode !== 'team-local' ? (
        <p>真人协助需要真实账号与同空间成员。当前是示例预览，不会模拟同事回复。</p>
      ) : id ? (
        <AssistanceThread id={id} />
      ) : (
        <AssistanceItems />
      )}
    </div>
  );
}
function AssistanceItems({ taskId, onSelect }: { taskId?: string; onSelect?(id: string): void }) {
  const [box, setBox] = useState('received'),
    [all, setAll] = useState(!!taskId),
    [cursor, setCursor] = useState<string | null>(null);
  const read = useAssistanceRead<AssistanceList>(
    `${taskId ? '/tasks/' + taskId : ''}/assistances?box=${box}&state=${all ? 'all' : 'active'}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    5000,
  );
  return (
    <>
      <div className="assistance-tabs">
        {!taskId && (
          <>
            <Button
              type="button"
              aria-pressed={box === 'received'}
              onClick={() => {
                setBox('received');
                setCursor(null);
              }}
            >
              收到的协助
            </Button>
            <Button
              type="button"
              aria-pressed={box === 'sent'}
              onClick={() => {
                setBox('sent');
                setCursor(null);
              }}
            >
              我发起的协助
            </Button>
          </>
        )}
        <label className="assistance-consent">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              setAll(e.target.checked);
              setCursor(null);
            }}
          />
          包含已结束
        </label>
      </div>
      <div className="dialog-body assistance-content">
        {read.error && (
          <p className="form-error" role="alert">
            {read.error}
            <Button type="button" onClick={read.retry}>
              重读协助列表
            </Button>
          </p>
        )}
        {read.value?.items.map((item) => {
          const content = (
            <>
              <span className="assistance-card-meta">
                {item.requester.name} → {item.recipient.name}
                <span className="badge neutral">{states[item.state]}</span>
              </span>
              <strong>{item.question}</strong>
              <small>
                {time(item.updatedAt)}
                {item.taskLink ? ' · ' + item.taskLink.shortId : ' · 仅分享片段'}
              </small>
            </>
          );
          return onSelect ? (
            <button
              className="assistance-list-item"
              key={item.id}
              onClick={() => onSelect(item.id)}
            >
              {content}
            </button>
          ) : (
            <Link className="assistance-list-item" key={item.id} to={`/assistances/${item.id}`}>
              {content}
            </Link>
          );
        })}
        {read.value?.items.length === 0 && (
          <p className="work-empty-text">
            这里还没有协助记录。可以在任务的一条讨论下选择“请同事协助”。
          </p>
        )}
        {!read.value && !read.error && <p role="status">正在读取协助记录…</p>}
        <div className="assistance-actions">
          {cursor && (
            <Button type="button" onClick={() => setCursor(null)}>
              返回协助首页
            </Button>
          )}
          {read.value?.nextCursor && (
            <Button type="button" onClick={() => setCursor(read.value!.nextCursor)}>
              更多协助
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
export function AssistanceThread({ id, onBusy }: { id: string; onBusy?(busy: boolean): void }) {
  const [before, setBefore] = useState<number | null>(null);
  const read = useAssistanceRead<AssistanceDetail>(assistancePath(id));
  const history = useAssistanceRead<AssistanceDetail>(
    before ? assistancePath(id) + '?before=' + before : null,
    0,
  );
  if (!read.value || read.denied || history.denied)
    return (
      <div className="dialog-body assistance-content">
        <p role={read.error ? 'alert' : 'status'}>
          {read.error || history.error || '正在读取协助…'}
        </p>
        {(read.denied || history.denied) && (
          <p>协助链接不授予访问权。请核对当前账号与空间；已撤销的内容和未发送回复已清除。</p>
        )}
        {read.error && (
          <Button type="button" onClick={read.retry}>
            重读协助
          </Button>
        )}
      </div>
    );
  return (
    <ThreadContent
      key={id}
      value={read.value}
      readError={read.error}
      onRetry={read.retry}
      before={before}
      setBefore={setBefore}
      history={history}
      onBusy={onBusy}
    />
  );
}
function ThreadContent({
  value,
  readError,
  onRetry,
  before,
  setBefore,
  history,
  onBusy,
}: {
  value: AssistanceDetail;
  readError: string;
  onRetry(): void;
  before: number | null;
  setBefore(v: number | null): void;
  history: ReturnType<typeof useAssistanceRead<AssistanceDetail>>;
  onBusy?(v: boolean): void;
}) {
  const item = value.assistance;
  const replies = before ? history.value : value;
  const [body, setBody] = useState(''),
    [baseRevision, setBaseRevision] = useState(item.revision),
    [action, setAction] = useState<'close' | 'cancel' | null>(null);
  const command = useAssistanceCommand<AssistanceDetail>((next) => {
    setBody('');
    setAction(null);
    setBaseRevision(next.assistance.revision);
    setBefore(null);
    onRetry();
  });
  const locked = command.busy || !!command.uncertain,
    conflict = baseRevision !== item.revision;
  useEffect(() => {
    onBusy?.(command.busy);
    return () => onBusy?.(false);
  }, [command.busy, onBusy]);
  useEffect(() => {
    if (!body && !action && !locked) setBaseRevision(item.revision);
  }, [item.revision, body, action, locked]);
  useEffect(() => {
    // Losing reply/manage authority clears unsaved edits without dropping the receipt
    // of an already-sent close/cancel request when its status arrives before its reply.
    if (!item.canReply) setBody('');
    if (!item.canManage || !item.canReply) setAction(null);
  }, [item.canReply, item.canManage]);
  if (command.denied)
    return (
      <div className="dialog-body assistance-content">
        <AssistanceFeedback command={command} />
        <p>协助访问或回复权限已变化，未发送内容已关闭。</p>
      </div>
    );
  return (
    <div className="dialog-body assistance-content">
      <div className="assistance-card-meta">
        <span>
          {item.requester.name} → {item.recipient.name}
        </span>
        <span className="badge neutral">{states[item.state]}</span>
      </div>
      <h2 className="assistance-question">{item.question}</h2>
      <section className="assistance-snapshot" aria-label="已分享的固定片段">
        <span className="eyebrow">固定分享片段</span>
        <pre>{item.snapshot.text}</pre>
        <p className="hint">
          {item.snapshot.actorName} · {time(item.snapshot.createdAt)}
        </p>
        <p className="hint">只包含发起时选择的内容；后续消息和原生会话不会自动加入。</p>
        <details>
          <summary>来源版本</summary>
          <code>{item.snapshotHash}</code>
        </details>
      </section>
      {item.sourceChanged && (
        <p className="assistance-warning">
          来源消息已变化，本协助仍使用发起时的片段，不会自动扩大分享。
        </p>
      )}
      {item.taskLink ? (
        <Link to={`/tasks/${item.taskLink.id}`}>
          回到任务：{item.taskLink.shortId} · {item.taskLink.title}
        </Link>
      ) : (
        <p className="hint">你仅获准查看本次片段和协助回复，不能访问完整任务或项目。</p>
      )}
      <p className="hint">分享协助链接不会扩大权限；接收者需登录对应账号并切换到本次空间。</p>
      <Link to={`/assistances/${item.id}`} className="text-button">
        打开协助独立链接
      </Link>
      {readError && (
        <p className="form-error" role="alert">
          {readError}；未发送回复已保留。
          <Button type="button" onClick={onRetry}>
            重读协助
          </Button>
        </p>
      )}
      <section aria-label="协助回复记录" className="assistance-replies">
        <h3>围绕这段材料讨论</h3>
        <div className="assistance-actions">
          {replies?.nextBefore && (
            <Button type="button" disabled={locked} onClick={() => setBefore(replies.nextBefore)}>
              查看更早回复
            </Button>
          )}
          {before && (
            <Button type="button" disabled={locked} onClick={() => setBefore(null)}>
              返回最新回复
            </Button>
          )}
        </div>
        {before && history.error && (
          <p className="form-error" role="alert">
            {history.error}；未发送回复已保留。
            <Button type="button" disabled={locked} onClick={history.retry}>
              重读更早回复
            </Button>
          </p>
        )}
        {before && !history.value && !history.error && <p role="status">正在读取更早回复…</p>}
        {replies?.replies.map((r) => (
          <article key={r.id} className="assistance-reply">
            <div className="assistance-card-meta">
              <strong>{r.author.name}</strong>
              <time>{time(r.createdAt)}</time>
            </div>
            <pre>{r.body}</pre>
          </article>
        ))}
        {replies?.replies.length === 0 && (
          <p className="hint">还没有回复。协助请求不会自动发给 AI。</p>
        )}
      </section>
      {item.canReply && (
        <form
          className="assistance-reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (locked || conflict || readError || !body.trim()) return;
            void command.send(assistancePath(item.id) + '/replies', {
              body,
              expectedRevision: baseRevision,
            });
          }}
        >
          <label className="field">
            协助回复
            <textarea
              aria-label="协助回复"
              rows={4}
              value={body}
              disabled={locked}
              maxLength={6000}
              placeholder="给出建议，或继续追问…"
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <p className="hint">
            回复会被发起者、接收者和原任务可见成员看到，不会修改任务说明或发送给正在运行的模型。
          </p>
          <Button
            type="submit"
            variant="primary"
            busy={command.busy}
            disabled={locked || conflict || !!readError || !body.trim()}
          >
            发送协助回复
          </Button>
        </form>
      )}
      {conflict && (body || action) && !command.uncertain && (
        <section className="assistance-warning" aria-label="协助版本冲突">
          <p>协助已更新，请先查看新回复或状态。你的输入已保留，不会自动发送。</p>
          {before ? (
            <Button type="button" disabled={locked} onClick={() => setBefore(null)}>
              查看最新回复并保留输入
            </Button>
          ) : (
            <Button type="button" disabled={locked} onClick={() => setBaseRevision(item.revision)}>
              已查看更新，保留我的输入
            </Button>
          )}
        </section>
      )}
      {item.canManage && item.state !== 'cancelled' && (
        <div className="assistance-actions">
          {item.state !== 'closed' && (
            <Button
              type="button"
              disabled={locked || !!readError}
              onClick={() => {
                setBaseRevision(item.revision);
                setAction('close');
              }}
            >
              结束协助
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={locked || !!readError}
            onClick={() => {
              setBaseRevision(item.revision);
              setAction('cancel');
            }}
          >
            撤销分享
          </Button>
        </div>
      )}
      {action && (
        <section className="assistance-warning" aria-label="协助状态确认">
          <p>
            {action === 'close'
              ? '结束后不再接受回复，接收者仍可查看已有片段和历史。任务和执行状态保持不变。'
              : '撤销后接收者不能继续读取或回复；原任务仍保留历史。无法收回对方已经看过或复制的内容。'}
          </p>
          <div className="assistance-actions">
            <Button
              type="button"
              variant={action === 'cancel' ? 'danger' : 'primary'}
              disabled={locked || conflict || !!readError}
              onClick={() =>
                void command.send(assistancePath(item.id) + '/state', {
                  action,
                  expectedRevision: baseRevision,
                })
              }
            >
              {action === 'close' ? '确认结束协助' : '确认撤销分享'}
            </Button>
            <Button type="button" disabled={locked} onClick={() => setAction(null)}>
              暂不操作
            </Button>
          </div>
        </section>
      )}
      <AssistanceFeedback command={command} />
    </div>
  );
}
