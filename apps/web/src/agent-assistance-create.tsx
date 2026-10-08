import { useEffect, useRef, useState } from 'react';
import type { Message, Task } from '../../../packages/contracts/src/index.js';
import type {
  AssistanceDetail,
  AssistancePreview,
  AssistanceRange,
} from '../../../packages/contracts/src/assistance.js';
import { selectedAssistanceText } from '../../../packages/contracts/src/assistance.js';
import type {
  AgentAssistanceInputSelection,
  AgentAssistancePreview,
  AgentAssistanceTarget,
} from '../../../packages/contracts/src/agent-assistance.js';
import type {
  AgentCapabilityListing,
  AgentParticipantView,
} from '../../../packages/contracts/src/agent-capabilities.js';
import type { SourcePage } from '../../../packages/contracts/src/project-sources.js';
import { agentAssistancePreview } from '../../../packages/client/src/agent-assistance.js';
import { ApiError } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useApp, canEditTask } from './state.js';
import { savedDraftRange, moveDraftSelection } from './draft-selection.js';
import { useAssistanceRead } from './assistance-common.js';
import { AssistanceThread } from './assistance.js';
import { AgentAssistanceFeedback, useAgentAssistanceCommand } from './agent-assistance-state.js';
const zeroHash = '0'.repeat(64);
export const agentTarget = (item: AgentCapabilityListing): AgentAssistanceTarget => ({
  participantId: item.participantId,
  capabilityId: item.capabilityId,
  capabilityVersion: item.capabilityVersion,
  endpointRevision: item.endpointRevision,
  grantId: item.grantId,
  grantRevision: item.grantRevision,
});
export function RequestAgentAssistance({ message }: { message: Message }) {
  const { data } = useApp();
  const task = data.tasks.find((t) => t.id === message.taskId);
  const allowed =
    data.mode === 'team-local' &&
    !!task &&
    task.visibility === 'project' &&
    !!task.projectId &&
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
        请 Agent 协助
      </Button>
      {open && (
        <Dialog title="有限 Agent 协助" drawer onClose={() => !busy && setOpen(false)}>
          <div className="assistance-drawer">
            {created ? (
              <AssistanceThread id={created} onBusy={setBusy} />
            ) : (
              <AgentAssistanceEditor
                task={task}
                messageId={message.id}
                onSaved={setCreated}
                onBusy={setBusy}
              />
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
export function AgentAssistanceEditor({
  task,
  messageId,
  existing,
  onSaved,
  onBusy,
}: {
  task: Task;
  messageId: string;
  existing?: AssistanceDetail;
  onSaved(id: string): void;
  onBusy?(busy: boolean): void;
}) {
  const source = useAssistanceRead<AssistancePreview>(
    `/tasks/${encodeURIComponent(task.id)}/messages/${encodeURIComponent(messageId)}/assistance-preview`,
  );
  const capabilities = useAssistanceRead<{ items: AgentCapabilityListing[] }>(
    `/projects/${encodeURIComponent(task.projectId!)}/agent-capabilities`,
  );
  const own = useAssistanceRead<{ items: AgentParticipantView[] }>('/agent-participants');
  const [cursor, setCursor] = useState<string | null>(null);
  const sources = useAssistanceRead<SourcePage>(
    `/projects/${encodeURIComponent(task.projectId!)}/sources?state=active${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
  );
  const command = useAgentAssistanceCommand<AssistanceDetail>(
    existing ? `input:${existing.assistance.id}` : `create:${task.id}:${messageId}`,
    (next) => onSaved(next.assistance.id),
  );
  useEffect(() => {
    if (source.denied || capabilities.denied || sources.denied) command.revoke();
  }, [source.denied, capabilities.denied, sources.denied]);
  if (command.denied || source.denied || capabilities.denied || sources.denied)
    return <p role="alert">当前分享权限已撤销，未保存内容已清除。</p>;
  if (!existing && command.receiptId)
    return (
      <div className="dialog-body assistance-content">
        <p>本条消息的 Agent 协助请求已保存，刷新只读取已有记录。</p>
        <Button type="button" onClick={() => onSaved(command.receiptId!)}>
          打开已保存 Agent 协助
        </Button>
        <Button type="button" onClick={command.forgetReceipt}>
          明确新建另一个协助问题
        </Button>
      </div>
    );
  if (!source.value || !capabilities.value || !sources.value)
    return (
      <div className="dialog-body assistance-content">
        <p>
          {source.error || capabilities.error || sources.error || '正在读取当前可请求能力和来源…'}
        </p>
        <Button
          type="button"
          onClick={() => {
            source.retry();
            capabilities.retry();
            sources.retry();
          }}
        >
          重新读取分享入口
        </Button>
      </div>
    );
  return (
    <AgentInputForm
      task={task}
      initial={source.value}
      latest={source.value}
      listings={capabilities.value.items}
      own={own.value?.items ?? []}
      sources={sources.value}
      existing={existing}
      command={command}
      readError={source.error || capabilities.error || sources.error}
      onBusy={onBusy}
      nextSources={setCursor}
    />
  );
}
function AgentInputForm({
  task,
  initial,
  latest,
  listings,
  own,
  sources,
  existing,
  command,
  readError,
  onBusy,
  nextSources,
}: {
  task: Task;
  initial: AssistancePreview;
  latest: AssistancePreview;
  listings: AgentCapabilityListing[];
  own: AgentParticipantView[];
  sources: SourcePage;
  existing?: AssistanceDetail;
  command: ReturnType<typeof useAgentAssistanceCommand<AssistanceDetail>>;
  readError: string;
  onBusy?(busy: boolean): void;
  nextSources(cursor: string | null): void;
}) {
  const old = existing?.assistance.agent;
  const [base, setBase] = useState(initial),
    [baseline] = useState(existing?.assistance),
    [question, setQuestion] = useState(old?.editInput?.question ?? ''),
    [clarification, setClarification] = useState('');
  const [target, setTarget] = useState<AgentAssistanceTarget | null>(
    old
      ? {
          participantId: old.recipientParticipantId,
          capabilityId: old.capabilityId,
          capabilityVersion: old.capabilityVersion,
          endpointRevision: old.endpointRevision,
          grantId: old.grantId,
          grantRevision: old.grantRevision,
        }
      : null,
  );
  const [requester, setRequester] = useState(old?.requesterParticipantId ?? ''),
    [range, setRange] = useState<AssistanceRange | null>(
      old?.editInput?.message.expectedSourceHash === initial.sourceHash
        ? old.editInput.message.range
        : null,
    ),
    [pendingRange, setPendingRange] = useState<AssistanceRange | null>(null);
  const [texts, setTexts] = useState<AgentAssistanceInputSelection['projectTexts']['items']>(
    old?.editInput?.projectTexts.items ?? [],
  );
  const [preview, setPreview] = useState<AgentAssistancePreview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [previewBusy, setPreviewBusy] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0),
    previewGuard = useRef(false);
  const locked = command.busy || !!command.pending || previewBusy;
  const changed =
    base.sourceHash !== latest.sourceHash || base.taskRevision !== latest.taskRevision;
  const conflict = !!baseline && baseline.revision !== existing?.assistance.revision;
  useEffect(() => {
    onBusy?.(command.busy || previewBusy);
    return () => onBusy?.(false);
  }, [command.busy, previewBusy, onBusy]);
  useEffect(() => {
    generation.current++;
    setPreview(null);
    setConfirmed(false);
  }, [question, clarification, target, requester, range, texts, changed, conflict]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function select(field: HTMLTextAreaElement) {
    setPendingRange(
      field.selectionEnd > field.selectionStart
        ? savedDraftRange(base.content, field.selectionStart, field.selectionEnd)
        : null,
    );
  }
  async function prepare() {
    if (locked || previewGuard.current || !target || !range || changed || conflict || readError)
      return;
    previewGuard.current = true;
    setPreviewBusy(true);
    setError('');
    const current = ++generation.current;
    try {
      const value = await agentAssistancePreview(task.id, {
        target,
        requesterParticipantId: requester || null,
        input: {
          question,
          clarification: existing && clarification.trim() ? clarification : null,
          message: { sourceMessageId: base.messageId, expectedSourceHash: base.sourceHash, range },
          projectTexts: { items: texts, expectedHash: zeroHash },
        },
      });
      if (current === generation.current) {
        setPreview(value);
        setConfirmed(false);
      }
    } catch (cause) {
      if (current === generation.current) {
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) command.revoke();
        else setError(cause instanceof Error ? cause.message : '预览失败');
      }
    } finally {
      previewGuard.current = false;
      setPreviewBusy(false);
    }
  }
  const currentListing = listings.find(
    (v) => v.capabilityId === target?.capabilityId && v.grantId === target.grantId,
  );
  const targetChanged =
    !existing &&
    !!target &&
    (!currentListing ||
      JSON.stringify(agentTarget(currentListing)) !== JSON.stringify(target) ||
      !currentListing.canRequest);
  return (
    <form
      className="drawer-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          locked ||
          changed ||
          conflict ||
          targetChanged ||
          readError ||
          !preview ||
          !confirmed ||
          !target
        )
          return;
        if (existing && baseline?.agent)
          void command.send(`/assistances/${existing.assistance.id}/input-revisions`, {
            expectedRevision: baseline.revision,
            expectedInputRevision: baseline.agent.currentInputRevision,
            expectedAccessRevision: baseline.agent.accessRevision,
            expectedTaskRevision: preview.expectedTaskRevision,
            causeResponseId: baseline.agent.pendingResponseId,
            input: preview.input,
            expectedInputHash: preview.inputHash,
            shareConfirmed: true,
          });
        else
          void command.send(`/tasks/${task.id}/agent-assistances`, {
            target,
            requesterParticipantId: requester || null,
            input: preview.input,
            expectedTaskRevision: preview.expectedTaskRevision,
            expectedInputHash: preview.inputHash,
            shareConfirmed: true,
          });
      }}
    >
      <div className="dialog-body assistance-content">
        <p>
          仅保存有限文本协助。能力适配 not_integrated · callable=false；保存或接受不代表真实 Agent
          收件、模型运行或收费执行。
        </p>
        {!existing && (
          <>
            <label className="field">
              当前可请求能力
              <select
                aria-label="当前可请求能力"
                value={target ? target.capabilityId + ':' + target.grantId : ''}
                disabled={locked}
                onChange={(e) => {
                  const value = listings.find(
                    (v) => v.capabilityId + ':' + v.grantId === e.target.value,
                  );
                  setTarget(value ? agentTarget(value) : null);
                }}
              >
                <option value="">选择能力与固定授权</option>
                {listings
                  .filter((v) => v.canRequest)
                  .map((v) => (
                    <option
                      key={v.capabilityId + ':' + v.grantId}
                      value={v.capabilityId + ':' + v.grantId}
                    >
                      {v.participantName} · {v.title}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              关联本人 Agent（可选）
              <select
                aria-label="关联本人 Agent"
                value={requester}
                disabled={locked}
                onChange={(e) => setRequester(e.target.value)}
              >
                <option value="">本人直接发起</option>
                {own
                  .filter((v) => !v.revokedAt && v.id !== target?.participantId)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="hint">
              浏览器操作来源始终是真人；同一所有者的不同 Agent 可协助，同一参与身份不能自求助。
            </p>
          </>
        )}
        <label className="field">
          协助问题
          <textarea
            aria-label="Agent 协助问题"
            rows={3}
            maxLength={2000}
            value={question}
            disabled={locked}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        {existing && (
          <label className="field">
            本轮补充或范围确认
            <textarea
              aria-label="本轮补充或范围确认"
              rows={3}
              maxLength={6000}
              value={clarification}
              disabled={locked}
              onChange={(e) => setClarification(e.target.value)}
            />
          </label>
        )}
        <label className="field">
          选择固定消息摘录
          <textarea
            aria-label="Agent 消息选区"
            rows={7}
            readOnly
            value={base.content}
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
              if (next) {
                event.preventDefault();
                field.setSelectionRange(next.start, next.end, next.direction);
                select(field);
              }
            }}
          />
        </label>
        <Button
          type="button"
          disabled={locked || changed || !pendingRange}
          onClick={() => {
            if (!pendingRange) return;
            try {
              selectedAssistanceText(base.content, pendingRange);
              setRange(pendingRange);
              setError('');
            } catch (cause) {
              setError((cause as Error).message);
            }
          }}
        >
          使用 Agent 分享选区
        </Button>
        {range && <pre>{selectedAssistanceText(base.content, range)}</pre>}
        {changed && (
          <section className="assistance-warning" aria-label="Agent 来源版本冲突">
            <p>来源已变化。原问题、选区和资料版本仍保留；请比较后明确重新选择。</p>
            <pre>{latest.content}</pre>
            <Button
              type="button"
              disabled={locked}
              onClick={() => {
                setBase(latest);
                setRange(null);
                setPendingRange(null);
              }}
            >
              比较后重新选择当前消息
            </Button>
          </section>
        )}
        {(conflict || command.conflict) && (
          <p role="alert">
            请求版本冲突。请比较协助中的最新修订；当前输入不会自动切换基线或提交。返回后重新打开补充编辑。
          </p>
        )}
        {targetChanged && <p role="alert">能力或授权版本变化，请重新选择当前能力。</p>}
        <fieldset disabled={locked}>
          <legend>可选项目纯文本资料</legend>
          <p className="hint">只分享勾选的固定版本，不导入链接、文件、diff、约定或整段原生会话。</p>
          {sources.items
            .filter((v) => v.kind === 'text' && !v.deletedAt)
            .map((v) => (
              <label className="assistance-consent" key={v.id}>
                <input
                  type="checkbox"
                  checked={texts.some((t) => t.id === v.id)}
                  onChange={(e) =>
                    setTexts((items) =>
                      e.target.checked
                        ? [
                            ...items,
                            {
                              id: v.id,
                              revision: v.revision,
                              contentHash: v.contentHash,
                              maxChars: 8000,
                            },
                          ]
                        : items.filter((t) => t.id !== v.id),
                    )
                  }
                />
                {v.title} · 修订 {v.revision}
              </label>
            ))}
          {texts.length > 0 && (
            <>
              <p>已选择 {texts.length} 项固定文本</p>
              <Button type="button" onClick={() => setTexts([])}>
                清除所选项目文本
              </Button>
            </>
          )}
          <Button type="button" onClick={() => nextSources(null)}>
            资料首页
          </Button>
          {sources.nextCursor && (
            <Button type="button" onClick={() => nextSources(sources.nextCursor)}>
              更多纯文本候选
            </Button>
          )}
        </fieldset>
        <Button
          type="button"
          disabled={
            locked ||
            changed ||
            conflict ||
            targetChanged ||
            !!readError ||
            !target ||
            !range ||
            !question.trim() ||
            requester === target.participantId
          }
          onClick={() => void prepare()}
        >
          预览完整分享内容
        </Button>
        {preview && (
          <section className="assistance-snapshot" aria-label="Agent 完整分享预览">
            <h3>
              本轮输入 · 发送给{' '}
              {currentListing?.participantName ?? existing?.assistance.recipient.name}
            </h3>
            <p>{preview.input.question}</p>
            {preview.input.clarification && <p>{preview.input.clarification}</p>}
            {preview.materials.map((material) => (
              <div key={material.id}>
                <strong>{material.label}</strong>
                <pre>{material.text}</pre>
              </div>
            ))}
            <p className="hint">
              接收者仅获准这些文本及回应，不获取父任务或项目访问权。不会自动采用返回答案或继续任务。
            </p>
            <label className="assistance-consent">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={locked}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已核对双方、完整文本和本轮分享范围
            </label>
          </section>
        )}
        {(error || readError) && (
          <p role="alert" className="form-error">
            {error || readError}；编辑内容和固定版本已保留。
          </p>
        )}
        <AgentAssistanceFeedback command={command} />
      </div>
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={
            locked || !confirmed || !preview || changed || conflict || targetChanged || !!readError
          }
        >
          {existing ? '确认新输入修订' : '保存 Agent 协助请求'}
        </Button>
      </div>
    </form>
  );
}
