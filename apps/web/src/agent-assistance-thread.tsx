import { CollaborationObservations } from './task-collaboration.js';
import { AdoptAssistance, AssistanceAdoptionHistory } from './assistance-adoption.js';
import { AgentConsumptionStatus } from './agent-consumption.js';
import { AgentAssistanceCredentials } from './agent-assistance-credentials.js';
import { useEffect, useRef, useState, type SetStateAction } from 'react';
import type { AssistanceDetail } from '../../../packages/contracts/src/assistance.js';
import type {
  AgentAssistancePhase,
  AgentAssistanceResponseType,
  AgentAssistanceResponseRecord,
} from '../../../packages/contracts/src/agent-assistance.js';
import { Button } from '../../../packages/ui/src/index.js';
import { Link, time, useApp } from './state.js';
import { AgentAssistanceEditor } from './agent-assistance-create.js';
import {
  AgentAssistanceFeedback,
  useAgentAssistanceCommand,
  useAgentAssistanceDraft,
} from './agent-assistance-state.js';
export const agentPhase: Record<AgentAssistancePhase, string> = {
  awaiting_acceptance: '等待接受本轮输入',
  accepted: '本轮已接受（业务确认）',
  waiting_input: '等待发起者补充或确认范围',
  answered: '外部回答已保存',
  terminal: '已结束或撤销',
};
const labels: Record<AgentAssistanceResponseType, string> = {
  accept: '接受',
  decline: '拒绝',
  request_input: '请求澄清',
  propose_scope: '提出范围调整',
  answer: '回答',
};
export function AgentAssistanceThread({
  value,
  readError,
  onRetry,
  onBusy,
}: {
  value: AssistanceDetail;
  readError: string;
  onRetry(): void;
  onBusy?(busy: boolean): void;
}) {
  const { data } = useApp();
  const item = value.assistance,
    agent = item.agent!;
  const [draft, setDraft, clearDraft] = useAgentAssistanceDraft(
    `respond:${item.id}`,
    {
      base: item,
      body: '',
      type: (agent.phase === 'accepted' ? 'answer' : 'accept') as AgentAssistanceResponseType,
      question: '',
      materialIds: agent.materials.map((material) => material.id),
    },
    { kind: 'respond', id: item.id },
  );
  const { base, body, type, question, materialIds } = draft;
  function change<K extends keyof typeof draft>(
    field: K,
    value: SetStateAction<(typeof draft)[K]>,
  ) {
    setDraft((previous) => ({
      ...previous,
      [field]:
        typeof value === 'function'
          ? (value as (old: (typeof draft)[K]) => (typeof draft)[K])(previous[field])
          : value,
    }));
  }
  const setBase = (value: typeof item) => change('base', value);
  const setBody = (value: string) => change('body', value);
  const setType = (value: AgentAssistanceResponseType) => change('type', value);
  const setQuestion = (value: string) => change('question', value);
  const setMaterialIds = (value: SetStateAction<string[]>) => change('materialIds', value);
  const [editing, setEditing] = useState(false),
    [end, setEnd] = useState<'close' | 'cancel' | null>(null),
    [endRevision, setEndRevision] = useState(item.revision),
    [adoptReplyId, setAdoptReplyId] = useState<string | null>(null),
    [adoptionBusy, setAdoptionBusy] = useState(false);
  const supplementButton = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (!editing && wasEditing.current && supplementButton.current?.isConnected)
      supplementButton.current.focus();
    wasEditing.current = editing;
  }, [editing]);
  const command = useAgentAssistanceCommand<AssistanceDetail>(`respond:${item.id}`, (next) => {
    setBase(next.assistance);
    setBody('');
    setQuestion('');
    setEnd(null);
    setEditing(false);
    onRetry();
  });
  const [editorBusy, setEditorBusy] = useState(false),
    [credentialBusy, setCredentialBusy] = useState(false);
  const locked = command.busy || !!command.pending || editorBusy || credentialBusy || adoptionBusy;
  const conflict = end
    ? endRevision !== item.revision
    : item.canReply && base.revision !== item.revision;
  useEffect(() => {
    onBusy?.(command.busy || editorBusy || credentialBusy || adoptionBusy);
    return () => onBusy?.(false);
  }, [command.busy, editorBusy, credentialBusy, adoptionBusy, onBusy]);
  useEffect(() => {
    if (
      item.canReply &&
      !body &&
      !question &&
      !end &&
      !editing &&
      !locked &&
      base.revision !== item.revision
    ) {
      setBase(item);
      setMaterialIds(agent.materials.map((m) => m.id));
    }
  }, [item.revision, body, question, end, editing, locked]);
  useEffect(() => {
    if (!item.canReply) {
      clearDraft();
      if (item.state === 'open' && command.pending?.path.endsWith('/responses')) command.revoke();
    }
    if (!item.canManage) {
      setEnd(null);
      setEditing(false);
    }
    if (!item.canEditTask || item.accessEnded) setAdoptReplyId(null);
    if (item.accessEnded) command.revoke();
  }, [item.canReply, item.canManage, item.canEditTask, item.accessEnded, item.state]);
  if (command.denied)
    return (
      <div role="alert">
        <p>当前请求授权已结束，编辑内容已清除。</p>
        <Button type="button" onClick={onRetry}>
          重读 Agent 协助权限
        </Button>
      </div>
    );
  const task = item.taskLink ? data.tasks.find((t) => t.id === item.taskLink!.id) : undefined;
  const sendResponse = () => {
    if (
      locked ||
      conflict ||
      readError ||
      !base.agent ||
      !item.canReply ||
      (type !== 'accept' && !body.trim()) ||
      (type === 'accept' && agent.phase !== 'awaiting_acceptance') ||
      (type === 'answer' && agent.phase !== 'accepted') ||
      ((type === 'request_input' || type === 'propose_scope') && agent.phase === 'waiting_input') ||
      (type === 'propose_scope' && !question.trim())
    )
      return;
    const common = {
      expectedRevision: base.revision,
      inputRevision: base.agent.currentInputRevision,
      expectedInputHash: base.agent.inputHash,
      expectedAccessRevision: base.agent.accessRevision,
      type,
    };
    void command.send(
      `/assistances/${item.id}/responses`,
      type === 'accept'
        ? common
        : type === 'propose_scope'
          ? { ...common, body, scope: { question, materialIds } }
          : { ...common, body },
    );
  };
  const pendingResponse = agent.responses.find(
    (response) =>
      response.id === agent.pendingResponseId &&
      response.inputRevision === agent.currentInputRevision &&
      (response.type === 'request_input' || response.type === 'propose_scope'),
  );
  const answers = agent.responses.filter((response) => response.type === 'answer');
  const negotiation = agent.responses.filter(
    (response) => response.type !== 'answer' && response.id !== pendingResponse?.id,
  );
  function responseRecord(response: AgentAssistanceResponseRecord) {
    return (
      <article key={response.id} className="assistance-reply">
        <strong>
          {labels[response.type]} · 输入修订 {response.inputRevision}
          {response.inputRevision !== agent.currentInputRevision ? '（历史输入）' : ''}
        </strong>
        <p className="hint">
          来源：
          {response.actor.kind === 'human'
            ? `真人 ${response.actor.userId === item.requester.id ? item.requester.name : response.actor.userId === item.recipient.id ? item.recipient.name : response.actor.userId}`
            : response.actor.kind === 'agent'
              ? `Agent ${response.actor.participantId}`
              : '所有者预授权策略'}
          {' · '}
          {time(response.createdAt)}
        </p>
        {response.actor.kind === 'policy' && (
          <p className="hint">预授权接受只确认本轮输入，不证明远端在线、取件或执行。</p>
        )}
        {response.body && <pre>{response.body}</pre>}
        {response.scope && (
          <>
            <p>待发起者明确确认的问题：{response.scope.question}</p>
            <p>
              提议保留材料：
              {response.scope.materialIds
                .map((id) => agent.materials.find((material) => material.id === id)?.label ?? id)
                .join('、')}
            </p>
            <p className="hint">范围提议尚未更改当前材料，需要有权发起者明确确认新修订。</p>
          </>
        )}
        {item.canEditTask &&
          !item.accessEnded &&
          item.state !== 'cancelled' &&
          response.type === 'answer' &&
          response.actor.kind === 'agent' &&
          response.inputRevision === agent.currentInputRevision && (
            <Button
              type="button"
              disabled={locked || !!readError}
              onClick={() => setAdoptReplyId(response.id)}
            >
              选择外部回答采用到任务说明
            </Button>
          )}
      </article>
    );
  }
  return (
    <div className="dialog-body assistance-content">
      <div className="assistance-card-meta">
        <strong>
          {item.requester.name} → {item.recipient.name}
        </strong>
        <span className="badge neutral">{agentPhase[agent.phase]}</span>
      </div>
      <p className="hint">
        发起关联：{agent.requesterParticipantId ?? '真人直接发起'} · 接收 Agent：
        {agent.recipientParticipantId}
      </p>
      {agent.capacityBlocked && (
        <p role="status">当前授权接受容量已满；请求已保存，尚未接受。不会自动启动执行。</p>
      )}
      <h2>{item.question}</h2>
      <p>
        当前输入修订 {agent.currentInputRevision} · 授权修订 {agent.accessRevision}
      </p>
      <p className="hint">
        请求记录更新：{time(item.updatedAt)}
        。保存或接受只确认本轮请求；远端取件、返回成果、原工作继续和人工采用分别记录。
      </p>
      {agent.phase === 'accepted' && (
        <p role="status">本轮输入已接受，等待返回成果；尚不能据此确认远端在线或执行已开始。</p>
      )}
      {agent.phase === 'waiting_input' && (
        <section className="assistance-warning" aria-label="需要人处理的协作问题">
          <h3>{pendingResponse?.type === 'propose_scope' ? '需要人确认范围' : '需要人补充信息'}</h3>
          <p>{item.requester.name}需要核对当前问题与有限材料，再明确提交下一轮输入。</p>
          {pendingResponse ? (
            responseRecord(pendingResponse)
          ) : (
            <p>当前请求正在等待补充，具体问题以重新读取的回应记录为准。</p>
          )}
          {!item.canManage && <p className="hint">由有权发起者处理；当前身份不能修改分享范围。</p>}
        </section>
      )}
      <section aria-label="Agent 当前固定输入" className="assistance-snapshot">
        {agent.clarification && <p>{agent.clarification}</p>}
        {agent.materials.map((material) => (
          <div key={material.id}>
            <strong>{material.label}</strong>
            <pre>{material.text}</pre>
          </div>
        ))}
        <details>
          <summary>输入指纹</summary>
          <p>{agent.inputHash}</p>
        </details>
      </section>
      {item.taskLink ? (
        <Link to={`/tasks/${item.taskLink.id}`}>
          返回任务：{item.taskLink.shortId} · {item.taskLink.title}
        </Link>
      ) : (
        <p className="hint">仅可查看本请求获准材料，没有父任务或项目访问权。</p>
      )}
      {readError && (
        <p role="alert">
          {readError}；输入和固定基线已保留。
          <Button type="button" onClick={onRetry}>
            重读 Agent 协助
          </Button>
        </p>
      )}
      <section className="assistance-replies" aria-label="Agent 返回成果">
        <h3>返回成果</h3>
        {answers.length ? (
          answers.map(responseRecord)
        ) : (
          <p className="hint">还没有已保存的文本成果。</p>
        )}
        {answers.length > 0 && (
          <p className="hint">
            返回文本已保存。采用到任务说明需明确选择；原工作是否继续请查看其单独记录。
          </p>
        )}
      </section>
      <details className="assistance-replies" aria-label="Agent 类型回应记录">
        <summary>协商往返记录（{negotiation.length}）</summary>
        {negotiation.length ? (
          negotiation.map(responseRecord)
        ) : (
          <p className="hint">没有其他协商记录。</p>
        )}
      </details>
      {item.canReply && item.state === 'open' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendResponse();
          }}
          className="assistance-reply-form"
        >
          <label className="field">
            回应类型
            <select
              aria-label="Agent 回应类型"
              value={type}
              disabled={locked}
              onChange={(e) => {
                setType(e.target.value as AgentAssistanceResponseType);
              }}
            >
              <option value="accept" disabled={agent.phase !== 'awaiting_acceptance'}>
                接受当前输入
              </option>
              <option value="decline">拒绝</option>
              <option value="request_input" disabled={agent.phase === 'waiting_input'}>
                需要澄清
              </option>
              <option value="propose_scope" disabled={agent.phase === 'waiting_input'}>
                提出范围调整
              </option>
              <option value="answer" disabled={agent.phase !== 'accepted'}>
                提交文本回答
              </option>
            </select>
          </label>
          {type !== 'accept' && (
            <label className="field">
              回应正文
              <textarea
                aria-label="Agent 回应正文"
                maxLength={6000}
                rows={4}
                value={body}
                disabled={locked}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
          )}
          {type === 'propose_scope' && (
            <>
              <label className="field">
                提议问题
                <textarea
                  aria-label="提议问题"
                  value={question}
                  maxLength={2000}
                  disabled={locked}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <fieldset disabled={locked}>
                <legend>仅可缩小额外文本范围，保留主消息摘录</legend>
                {agent.materials.map((material) => (
                  <label key={material.id} className="assistance-consent">
                    <input
                      type="checkbox"
                      disabled={material.id === agent.materials[0]?.id}
                      checked={materialIds.includes(material.id)}
                      onChange={(e) =>
                        setMaterialIds((ids) =>
                          e.target.checked
                            ? [...ids, material.id]
                            : ids.filter((id) => id !== material.id),
                        )
                      }
                    />
                    {material.label}
                  </label>
                ))}
              </fieldset>
              <p>提案不会改变当前输入或获取新材料，需发起者明确确认新修订。</p>
            </>
          )}
          <p className="hint">本浏览器操作记录为真实人类来源；请仅提交你有权向发起者分享的文本。</p>
          <Button
            type="submit"
            variant="primary"
            disabled={
              locked ||
              conflict ||
              !!readError ||
              (type !== 'accept' && !body.trim()) ||
              (type === 'accept' && agent.phase !== 'awaiting_acceptance') ||
              (type === 'answer' && agent.phase !== 'accepted') ||
              ((type === 'request_input' || type === 'propose_scope') &&
                agent.phase === 'waiting_input') ||
              (type === 'propose_scope' && !question.trim())
            }
          >
            保存{labels[type]}
          </Button>
        </form>
      )}
      {(conflict || command.conflict) && (
        <section className="assistance-warning" aria-label="Agent 回应版本比较">
          <p>
            原输入修订 {base.agent?.currentInputRevision} / 请求版本 {base.revision}；当前输入修订{' '}
            {agent.currentInputRevision} / 请求版本 {item.revision}
            。请查看当前材料和回应后明确比较，不自动更换范围。
          </p>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setBase(item);
              setMaterialIds(agent.materials.map((m) => m.id));
              setEnd(null);
            }}
          >
            已比较当前输入，保留正文
          </Button>
        </section>
      )}
      {item.canManage && item.state === 'open' && task && agent.editInput && (
        <Button
          type="button"
          disabled={locked}
          aria-expanded={editing}
          aria-controls={`agent-supplement-${item.id}`}
          onClick={(event) => {
            supplementButton.current = event.currentTarget;
            setEditing((value) => !value);
          }}
        >
          {editing ? '收起补充编辑' : '补充或确认范围'}
        </Button>
      )}
      {editing && task && agent.editInput && (
        <div id={`agent-supplement-${item.id}`}>
          <AgentAssistanceEditor
            task={task}
            messageId={agent.editInput.message.sourceMessageId}
            existing={value}
            onBusy={setEditorBusy}
            onSaved={() => {
              setEditing(false);
              onRetry();
            }}
          />
        </div>
      )}
      {item.canManage && item.state !== 'cancelled' && (
        <div className="assistance-actions">
          {item.state !== 'closed' && (
            <Button
              type="button"
              disabled={locked}
              onClick={() => {
                setEndRevision(item.revision);
                setEnd('close');
              }}
            >
              结束 Agent 协助
            </Button>
          )}
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setEndRevision(item.revision);
              setEnd('cancel');
            }}
          >
            撤销 Agent 分享
          </Button>
        </div>
      )}
      {end && (
        <section className="assistance-warning" aria-label="Agent 协助结束确认">
          <p>
            {end === 'close'
              ? '结束后不接受新回应，保留原获准阅读与历史。'
              : '撤销后关闭有限取件与回应授权。无法收回已分享内容，也不代表外部执行已停止。'}
          </p>
          <Button
            type="button"
            disabled={locked || conflict || !!readError}
            onClick={() =>
              void command.send(`/assistances/${item.id}/state`, {
                expectedRevision: endRevision,
                action: end,
              })
            }
          >
            确认{end === 'close' ? '结束' : '撤销'}
          </Button>
          <Button type="button" disabled={locked} onClick={() => setEnd(null)}>
            暂不操作
          </Button>
        </section>
      )}
      {item.taskLink && (
        <CollaborationObservations taskId={item.taskLink.id} assistanceId={item.id} />
      )}
      {item.taskLink && (
        <AgentConsumptionStatus taskId={item.taskLink.id} requestId={agent.requestId} />
      )}
      {adoptReplyId && item.taskLink && item.canEditTask && !item.accessEnded && (
        <AdoptAssistance
          taskId={item.taskLink.id}
          id={item.id}
          replyId={adoptReplyId}
          onBusy={setAdoptionBusy}
          onClose={() => setAdoptReplyId(null)}
        />
      )}
      {item.taskLink && <AssistanceAdoptionHistory taskId={item.taskLink.id} id={item.id} />}
      <AgentAssistanceCredentials
        id={item.id}
        agent={agent}
        onSaved={onRetry}
        onBusy={setCredentialBusy}
      />
      <AgentAssistanceFeedback command={command} />
    </div>
  );
}
