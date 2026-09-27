import { useEffect, useState } from 'react';
import type { Message, Task } from '../../../packages/contracts/src/index.js';
import {
  selectedAssistanceText,
  type AssistanceDetail,
  type AssistancePreview,
  type AssistanceRange,
  type AssistanceRecipients,
} from '../../../packages/contracts/src/assistance.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useApp, canEditTask, time } from './state.js';
import { moveDraftSelection, savedDraftRange } from './draft-selection.js';
import {
  useAssistanceRead,
  useAssistanceCommand,
  AssistanceFeedback,
} from './assistance-common.js';
import { AssistanceThread } from './assistance.js';
import './assistance.css';

export function RequestAssistance({ message }: { message: Message }) {
  const { data } = useApp();
  const task = data.tasks.find((t) => t.id === message.taskId);
  const allowed =
    data.mode === 'team-local' &&
    !!task &&
    canEditTask(data, task) &&
    message.actorType !== 'system';
  const [open, setOpen] = useState(false),
    [created, setCreated] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!allowed) {
      setOpen(false);
      setCreated(null);
    }
  }, [allowed]);
  if (!allowed || !task) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="assistance-message-action"
        onClick={() => {
          setCreated(null);
          setOpen(true);
        }}
      >
        请同事协助
      </Button>
      {open && (
        <Dialog title="请同事协助" drawer onClose={() => !busy && setOpen(false)}>
          <div className="assistance-drawer">
            {created ? (
              <AssistanceThread id={created} onBusy={setBusy} />
            ) : (
              <AssistanceSource
                task={task}
                message={message}
                onBusy={setBusy}
                onCreated={setCreated}
              />
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
function AssistanceSource({
  task,
  message,
  onCreated,
  onBusy,
}: {
  task: Task;
  message: Message;
  onCreated(id: string): void;
  onBusy(v: boolean): void;
}) {
  const read = useAssistanceRead<AssistancePreview>(
    `/tasks/${task.id}/messages/${message.id}/assistance-preview`,
  );
  if (!read.value || read.denied)
    return (
      <div className="dialog-body assistance-content">
        <p role={read.error ? 'alert' : 'status'}>{read.error || '正在读取可分享的消息…'}</p>
        {read.error && (
          <Button type="button" onClick={read.retry}>
            重新读取来源
          </Button>
        )}
      </div>
    );
  return (
    <AssistanceCreate
      task={task}
      preview={read.value}
      error={read.error}
      retry={read.retry}
      onCreated={onCreated}
      onBusy={onBusy}
    />
  );
}
function AssistanceCreate({
  task,
  preview,
  error,
  retry,
  onCreated,
  onBusy,
}: {
  task: Task;
  preview: AssistancePreview;
  error: string;
  retry(): void;
  onCreated(id: string): void;
  onBusy(v: boolean): void;
}) {
  const [base, setBase] = useState(preview),
    [question, setQuestion] = useState(''),
    [recipient, setRecipient] = useState<{ id: string; name: string } | null>(null),
    [range, setRange] = useState<AssistanceRange | null>(null),
    [pendingRange, setPendingRange] = useState<AssistanceRange | null>(null),
    [selectionError, setSelectionError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [q, setQ] = useState(''),
    [cursor, setCursor] = useState<string | null>(null);
  const recipients = useAssistanceRead<AssistanceRecipients>(
    `/tasks/${task.id}/assistance-recipients?q=${encodeURIComponent(q)}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    0,
  );
  const command = useAssistanceCommand<AssistanceDetail>((value) => onCreated(value.assistance.id));
  const locked = command.busy || !!command.uncertain;
  const changed =
    base.sourceHash !== preview.sourceHash || base.taskRevision !== preview.taskRevision;
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  useEffect(() => {
    setConfirmed(false);
  }, [question, recipient, range, changed]);
  function select(field: HTMLTextAreaElement) {
    setPendingRange(
      field.selectionEnd > field.selectionStart
        ? savedDraftRange(base.content, field.selectionStart, field.selectionEnd)
        : null,
    );
  }
  let excerpt = '';
  if (range) excerpt = selectedAssistanceText(base.content, range);
  if (command.denied)
    return (
      <div className="dialog-body assistance-content">
        <AssistanceFeedback command={command} />
        <p>权限已变化，未保存的协助内容已关闭。</p>
      </div>
    );
  return (
    <form
      className="drawer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          locked ||
          changed ||
          error ||
          recipients.error ||
          !range ||
          !recipient ||
          !question.trim() ||
          !confirmed
        )
          return;
        void command.send(`/tasks/${task.id}/assistances`, {
          sourceMessageId: base.messageId,
          expectedSourceHash: base.sourceHash,
          expectedTaskRevision: base.taskRevision,
          range,
          recipientId: recipient.id,
          question,
          shareConfirmed: true,
        });
      }}
    >
      <div className="dialog-body assistance-content">
        <p>针对一个具体问题请同事帮忙。只分享下面选中的片段和问题，不改变负责人，也不启动 AI。</p>
        <label className="field">
          协助问题
          <textarea
            aria-label="协助问题"
            value={question}
            rows={3}
            maxLength={2000}
            disabled={locked}
            placeholder="需要同事帮你判断什么？"
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <label className="field">
          选择协助片段
          <textarea
            aria-label="选择协助片段"
            value={base.content}
            rows={7}
            readOnly
            disabled={locked || changed}
            onSelect={(e) => select(e.currentTarget)}
            onKeyDown={(event) => {
              if (locked || changed) return;
              const field = event.currentTarget;
              const next = moveDraftSelection(
                field.value,
                {
                  start: field.selectionStart,
                  end: field.selectionEnd,
                  direction: field.selectionDirection,
                },
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  altKey: event.altKey,
                  isComposing: event.nativeEvent.isComposing,
                },
              );
              if (!next) return;
              event.preventDefault();
              field.setSelectionRange(next.start, next.end, next.direction);
              select(field);
            }}
          />
        </label>
        <p className="hint">
          鼠标拖选，或用方向键与 Shift 选择一段文字，最多 6000
          字符。原消息只读；其他消息、任务说明与原生历史不会加入。
        </p>
        {base.truncated && (
          <p className="hint">消息较长，这里显示前 12000 字符，后面的内容未分享。</p>
        )}
        <div className="assistance-actions">
          <Button
            type="button"
            disabled={locked || changed || !pendingRange}
            onClick={() => {
              if (!pendingRange) return;
              try {
                selectedAssistanceText(base.content, pendingRange);
                setRange(pendingRange);
                setSelectionError('');
              } catch (cause) {
                setSelectionError((cause as Error).message);
              }
            }}
          >
            使用所选片段
          </Button>
          {range && (
            <Button type="button" disabled={locked} onClick={() => setRange(null)}>
              移除分享片段
            </Button>
          )}
        </div>
        {selectionError && (
          <p role="alert" className="form-error">
            {selectionError}
          </p>
        )}
        {changed && (
          <section className="assistance-warning" aria-label="协助来源冲突">
            <strong>来源消息或任务版本已变化</strong>
            <p>问题和原片段已保留。请核对当前来源后重新选择；不会自动分享新内容。</p>
            <pre>{preview.content}</pre>
            <Button
              type="button"
              disabled={locked}
              onClick={() => {
                setBase(preview);
                setRange(null);
                setPendingRange(null);
                setSelectionError('');
              }}
            >
              核对最新来源并重新选择
            </Button>
          </section>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}；草稿已保留。
            <Button type="button" onClick={retry}>
              重新读取来源
            </Button>
          </p>
        )}
        <label className="field">
          查找同事
          <input
            aria-label="查找同事"
            value={q}
            disabled={locked}
            maxLength={100}
            placeholder="同空间成员姓名…"
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(null);
            }}
          />
        </label>
        <label className="field">
          协助接收者
          <select
            aria-label="协助接收者"
            value={recipient?.id ?? ''}
            disabled={locked}
            onChange={(e) => {
              setRecipient(recipients.value?.items.find((v) => v.id === e.target.value) ?? null);
            }}
          >
            <option value="">选择一位同事</option>
            {recipient && !recipients.value?.items.some((v) => v.id === recipient.id) && (
              <option value={recipient.id}>{recipient.name}（已选择）</option>
            )}
            {recipients.value?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="assistance-actions">
          {cursor && (
            <Button type="button" disabled={locked} onClick={() => setCursor(null)}>
              同事列表首页
            </Button>
          )}
          {recipients.value?.nextCursor && (
            <Button
              type="button"
              disabled={locked}
              onClick={() => setCursor(recipients.value!.nextCursor)}
            >
              更多同事
            </Button>
          )}
        </div>
        {recipients.error && (
          <p className="form-error" role="alert">
            {recipients.error}
            <Button type="button" onClick={recipients.retry}>
              重读同事列表
            </Button>
          </p>
        )}
        {recipients.value?.items.length === 0 && (
          <p className="hint">
            没有匹配的其他空间成员。可以先在“资源与设置”邀请同事，不要求加入当前项目。
          </p>
        )}
        <section className="assistance-snapshot" aria-label="协助分享预览">
          <span className="eyebrow">本次明确分享</span>
          <h3>{recipient ? `发送给 ${recipient.name}` : '尚未选择接收者'}</h3>
          <p>{question || '尚未填写问题'}</p>
          <pre>{excerpt || '尚未选择消息片段'}</pre>
          <p className="hint">
            {base.actorName} · {time(base.createdAt)} · {excerpt.length} / 6000 字符
          </p>
          <p className="hint">
            接收者及原任务有访问权的成员可查看本次问题、片段、来源作者/时间与协助回复。
            {task.visibility === 'private'
              ? '这会明确分享私有消息的所选部分，但不会公开整个私有任务。'
              : '不会授予完整任务、项目、目录或执行权限。'}
          </p>
        </section>
        <label className="assistance-consent">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={locked || changed || !range || !recipient}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我已核对接收者与本次分享内容
        </label>
        <AssistanceFeedback command={command} />
      </div>
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={
            locked ||
            changed ||
            !!error ||
            !!recipients.error ||
            !range ||
            !recipient ||
            !question.trim() ||
            !confirmed
          }
        >
          发送协助请求
        </Button>
      </div>
    </form>
  );
}
