import { AdoptAssistance, AssistanceAdoptionHistory } from './assistance-adoption.js';
import { AgentConsumptionStatus } from './agent-consumption.js';
import { AgentAssistanceCredentials } from './agent-assistance-credentials.js';
import { useEffect, useState } from 'react';
import type { AssistanceDetail } from '../../../packages/contracts/src/assistance.js';
import type {
  AgentAssistancePhase,
  AgentAssistanceResponseType,
} from '../../../packages/contracts/src/agent-assistance.js';
import { Button } from '../../../packages/ui/src/index.js';
import { Link, time, useApp } from './state.js';
import { AgentAssistanceEditor } from './agent-assistance-create.js';
import { AgentAssistanceFeedback, useAgentAssistanceCommand } from './agent-assistance-state.js';
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
  const [base, setBase] = useState(item),
    [body, setBody] = useState(''),
    [type, setType] = useState<AgentAssistanceResponseType>('accept'),
    [question, setQuestion] = useState(''),
    [materialIds, setMaterialIds] = useState<string[]>(agent.materials.map((m) => m.id)),
    [editing, setEditing] = useState(false),
    [end, setEnd] = useState<'close' | 'cancel' | null>(null),
    [adoptReplyId, setAdoptReplyId] = useState<string | null>(null),
    [adoptionBusy, setAdoptionBusy] = useState(false);
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
  const conflict = base.revision !== item.revision;
  useEffect(() => {
    onBusy?.(command.busy || editorBusy || credentialBusy || adoptionBusy);
    return () => onBusy?.(false);
  }, [command.busy, editorBusy, credentialBusy, adoptionBusy, onBusy]);
  useEffect(() => {
    if (!body && !question && !end && !editing && !locked) {
      setBase(item);
      setMaterialIds(agent.materials.map((m) => m.id));
    }
  }, [item.revision, body, question, end, editing, locked]);
  useEffect(() => {
    if (!item.canReply) {
      setBody('');
      setQuestion('');
    }
    if (!item.canManage) {
      setEnd(null);
      setEditing(false);
    }
    if (!item.canEditTask || item.accessEnded) setAdoptReplyId(null);
    if (item.accessEnded) command.revoke();
  }, [item.canReply, item.canManage, item.canEditTask, item.accessEnded]);
  if (command.denied)
    return <p role="alert">当前请求授权已结束，编辑内容已清除。请重新读取协助。</p>;
  const task = item.taskLink ? data.tasks.find((t) => t.id === item.taskLink!.id) : undefined;
  const sendResponse = () => {
    if (
      locked ||
      conflict ||
      readError ||
      !base.agent ||
      !item.canReply ||
      (type !== 'accept' && !body.trim())
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
      <p className="assistance-warning">
        not_integrated · callable=false。保存、接受或预授权自动接受均是业务记录，不代表真实 Agent
        收件或模型运行；原工作消费记录与人工采用分开核对，不以保存回答证明模型已继续。
      </p>
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
      <section className="assistance-replies" aria-label="Agent 类型回应记录">
        <h3>协商与回答</h3>
        {agent.responses.map((response) => (
          <article key={response.id} className="assistance-reply">
            <strong>
              {labels[response.type]} · 输入修订 {response.inputRevision}
            </strong>
            <p className="hint">
              {response.actor.kind === 'human'
                ? `真人 ${response.actor.userId}`
                : response.actor.kind === 'agent'
                  ? `Agent ${response.actor.participantId}`
                  : '所有者预授权策略（非 Agent 收件）'}{' '}
              · {time(response.createdAt)}
            </p>
            {response.body && <pre>{response.body}</pre>}
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
            {response.scope && (
              <>
                <p>待发起者明确确认的问题：{response.scope.question}</p>
                <p>仅提议已有材料：{response.scope.materialIds.join('、')}</p>
              </>
            )}
          </article>
        ))}
      </section>
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
        <Button type="button" disabled={locked} onClick={() => setEditing((v) => !v)}>
          {editing ? '关闭补充编辑' : '补充或确认范围'}
        </Button>
      )}
      {editing && task && agent.editInput && (
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
      )}
      {item.canManage && item.state !== 'cancelled' && (
        <div className="assistance-actions">
          {item.state !== 'closed' && (
            <Button
              type="button"
              disabled={locked}
              onClick={() => {
                setBase(item);
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
              setBase(item);
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
                expectedRevision: base.revision,
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
