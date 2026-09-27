import { useEffect, useState } from 'react';
import type { Message, Task } from '../../../packages/contracts/src/index.js';
import type { NodeExecutionOption } from '../../../packages/contracts/src/node-execution.js';
import { renderAiAssistance } from '../../../packages/contracts/src/ai-assistance.js';
import {
  selectedAssistanceText,
  type AssistanceDetail,
  type AssistancePreview,
  type AssistanceRange,
} from '../../../packages/contracts/src/assistance.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useApp, canEditTask } from './state.js';
import { moveDraftSelection, savedDraftRange } from './draft-selection.js';
import {
  useAssistanceRead,
  useAssistanceCommand,
  AssistanceFeedback,
} from './assistance-common.js';
import { AssistanceThread } from './assistance.js';
import './assistance.css';
type Options = { items: Omit<NodeExecutionOption, 'workspaces'>[] };

export function RequestAiAssistance({ message }: { message: Message }) {
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
        请 AI 分析片段
      </Button>
      {open && (
        <Dialog title="AI 文本协助" drawer onClose={() => !busy && setOpen(false)}>
          <div className="assistance-drawer">
            {created ? (
              <AssistanceThread id={created} onBusy={setBusy} />
            ) : !task.projectId || task.visibility !== 'project' ? (
              <div className="dialog-body assistance-content">
                <p>
                  本批 AI
                  协助需要项目任务及同项目本人授权节点。私有任务仍可明确分享片段给同事，不会自动公开到项目。
                </p>
              </div>
            ) : (
              <AiSource task={task} message={message} onCreated={setCreated} onBusy={setBusy} />
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
function AiSource({
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
  const source = useAssistanceRead<AssistancePreview>(
    `/tasks/${task.id}/messages/${message.id}/assistance-preview`,
  );
  const options = useAssistanceRead<Options>(`/tasks/${task.id}/ai-assistance-options`);
  if (!source.value || source.denied || options.denied)
    return (
      <div className="dialog-body assistance-content">
        <p role="status">{source.error || options.error || '正在读取来源与本机授权…'}</p>
        <Button
          type="button"
          onClick={() => {
            source.retry();
            options.retry();
          }}
        >
          重读 AI 协助配置
        </Button>
      </div>
    );
  return (
    <AiForm
      task={task}
      preview={source.value}
      options={options}
      sourceError={source.error}
      onRetry={source.retry}
      onCreated={onCreated}
      onBusy={onBusy}
    />
  );
}
function AiForm({
  task,
  preview,
  options,
  sourceError,
  onRetry,
  onCreated,
  onBusy,
}: {
  task: Task;
  preview: AssistancePreview;
  options: ReturnType<typeof useAssistanceRead<Options>>;
  sourceError: string;
  onRetry(): void;
  onCreated(id: string): void;
  onBusy(v: boolean): void;
}) {
  const [base, setBase] = useState(preview),
    [question, setQuestion] = useState('');
  const [pending, setPending] = useState<AssistanceRange | null>(null),
    [range, setRange] = useState<AssistanceRange | null>(null);
  const [selected, setSelected] = useState<Options['items'][number] | null>(null),
    [error, setError] = useState('');
  const [material, setMaterial] = useState(false),
    [cost, setCost] = useState(false);
  const command = useAssistanceCommand<AssistanceDetail>((v) => onCreated(v.assistance.id));
  const locked = command.busy || !!command.uncertain;
  const sourceChanged =
    base.sourceHash !== preview.sourceHash || base.taskRevision !== preview.taskRevision;
  const current = options.value?.items.find((n) => n.nodeId === selected?.nodeId);
  const policyChanged = !!selected && current?.policyHash !== selected.policyHash;
  const unavailable = !current?.available || policyChanged;
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  useEffect(() => {
    setMaterial(false);
    setCost(false);
  }, [question, range, selected, sourceChanged, policyChanged]);
  function select(field: HTMLTextAreaElement) {
    setPending(
      field.selectionEnd > field.selectionStart
        ? savedDraftRange(base.content, field.selectionStart, field.selectionEnd)
        : null,
    );
  }
  const excerpt = range ? selectedAssistanceText(base.content, range) : '';
  const input = excerpt && question.trim() ? renderAiAssistance(question, excerpt) : '';
  const ready =
    !locked &&
    !sourceChanged &&
    !unavailable &&
    !sourceError &&
    !options.error &&
    !!input &&
    material &&
    cost;
  if (command.denied)
    return (
      <div className="dialog-body assistance-content">
        <AssistanceFeedback command={command} />
        <p>权限已变化，未保存材料已关闭。</p>
      </div>
    );
  return (
    <form
      className="drawer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !range || !selected) return;
        void command.send(`/tasks/${task.id}/ai-assistances`, {
          sourceMessageId: base.messageId,
          expectedSourceHash: base.sourceHash,
          expectedTaskRevision: base.taskRevision,
          range,
          question,
          nodeId: selected.nodeId,
          policyHash: selected.policyHash,
          confirmMaterial: true,
          confirmExecution: true,
        });
      }}
    >
      <div className="dialog-body assistance-content">
        <p>
          只让 AI 分析你选择的片段。与主编程执行分开，结果回到任务的协助记录，不修改任务说明或代码。
        </p>
        <label className="field">
          AI 协助问题
          <textarea
            aria-label="AI 协助问题"
            rows={3}
            maxLength={2000}
            disabled={locked}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="需要 AI 判断什么？"
          />
        </label>
        <label className="field">
          选择 AI 协助片段
          <textarea
            aria-label="选择 AI 协助片段"
            readOnly
            rows={7}
            value={base.content}
            disabled={locked || sourceChanged}
            onSelect={(e) => select(e.currentTarget)}
            onKeyDown={(e) => {
              const f = e.currentTarget,
                next = moveDraftSelection(
                  f.value,
                  { start: f.selectionStart, end: f.selectionEnd, direction: f.selectionDirection },
                  {
                    key: e.key,
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    metaKey: e.metaKey,
                    altKey: e.altKey,
                    isComposing: e.nativeEvent.isComposing,
                  },
                );
              if (next) {
                e.preventDefault();
                f.setSelectionRange(next.start, next.end, next.direction);
                select(f);
              }
            }}
          />
        </label>
        {base.truncated && (
          <p className="hint">
            仅预览消息前 12000 字符；本次最多选择 6000 字符，不会附带未选择内容。
          </p>
        )}
        <Button
          type="button"
          disabled={locked || sourceChanged || !pending}
          onClick={() => {
            try {
              if (pending) {
                selectedAssistanceText(base.content, pending);
                setRange(pending);
                setError('');
              }
            } catch (cause) {
              setError((cause as Error).message);
            }
          }}
        >
          使用 AI 所选片段
        </Button>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {sourceChanged && (
          <section className="assistance-warning" aria-label="AI 来源版本变化">
            <p>来源或任务已更新，问题和原片段保留。请核对当前来源后重新选材。</p>
            <pre>{preview.content}</pre>
            <Button
              type="button"
              disabled={locked}
              onClick={() => {
                setBase(preview);
                setRange(null);
                setPending(null);
              }}
            >
              核对新来源，重新选材
            </Button>
          </section>
        )}
        <label className="field">
          AI 执行节点
          <select
            aria-label="AI 执行节点"
            value={selected?.nodeId ?? ''}
            disabled={locked}
            onChange={(e) =>
              setSelected(options.value?.items.find((n) => n.nodeId === e.target.value) ?? null)
            }
          >
            <option value="">选择本人单独授权的节点</option>
            {selected && !options.value?.items.some((n) => n.nodeId === selected.nodeId) && (
              <option value={selected.nodeId}>{selected.name}（原选择已失效）</option>
            )}
            {options.value?.items.map((n) => (
              <option key={n.nodeId} value={n.nodeId}>
                {n.name} · Claude Code{n.available ? '' : ' · 暂不可用'}
              </option>
            ))}
          </select>
        </label>
        {options.value?.items.length === 0 && (
          <section className="assistance-warning">
            <p>
              没有已授权的纯文本节点。在同项目的本人 Runner 配置中明确设置{' '}
              <code>textAssistance: true</code>，重新运行 enable-execution
              并在本机确认，再启动节点。
            </p>
            <p>仅支持 Claude Code；普通目录执行授权、真人分享同意都不能代替本次模型授权。</p>
          </section>
        )}
        {selected && (
          <section className="assistance-snapshot" aria-label="AI 账户与范围">
            <strong>
              Claude Code · {selected.policy.model ?? '本机 CLI 默认模型（未预先解析）'}
            </strong>
            <p>
              节点本机 API 账户；每次预算参数 USD {selected.policy.maxBudgetUsd}，最多{' '}
              {selected.policy.maxTurns} 轮，超时 {selected.policy.timeoutSeconds} 秒。
            </p>
            <p>
              空临时目录，禁用全部工具，无项目目录、网页读取或历史会话。节点当前串行执行；已授权不等于模型账户验证通过。
            </p>
            <p className="hint">工具限制不是操作系统沙箱；实际费用及提供方接收状态尚未核实。</p>
          </section>
        )}
        {current && !current.available && <p className="assistance-warning">{current.reason}</p>}
        {policyChanged && (
          <section className="assistance-warning">
            <p>本机授权已变化，不能沿用旧配置发送。</p>
            <Button
              type="button"
              disabled={locked || !current}
              onClick={() => setSelected(current ?? null)}
            >
              核对新的本机授权
            </Button>
          </section>
        )}
        {(sourceError || options.error) && (
          <p className="form-error" role="alert">
            {sourceError || options.error}；选材与问题已保留。
            <Button
              type="button"
              disabled={locked}
              onClick={() => {
                onRetry();
                options.retry();
              }}
            >
              重读 AI 协助配置
            </Button>
          </p>
        )}
        <section className="assistance-snapshot" aria-label="本次模型材料预览">
          <strong>仅发送以下问题与片段</strong>
          <pre>{input || '填写问题并明确选择片段后显示。'}</pre>
          <p className="hint">
            {input.length}{' '}
            字符。不会自动带入任务标题、说明、其他讨论或真人协助回复；本机已知密钥格式可能进一步遮盖。这是授权材料，不是模型收件回执。
          </p>
        </section>
        <label className="assistance-consent">
          <input
            type="checkbox"
            checked={material}
            disabled={locked || !input || sourceChanged}
            onChange={(e) => setMaterial(e.target.checked)}
          />
          确认将本次预览材料发送给 Claude Code
        </label>
        <label className="assistance-consent">
          <input
            type="checkbox"
            checked={cost}
            disabled={locked || !selected || unavailable}
            onChange={(e) => setCost(e.target.checked)}
          />
          确认使用所选节点本机账户并承担本次费用
        </label>
        <AssistanceFeedback command={command} />
      </div>
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={command.busy} disabled={!ready}>
          启动 AI 文本协助
        </Button>
      </div>
    </form>
  );
}
