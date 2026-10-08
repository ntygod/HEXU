import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import * as C from '../../contracts/src/agent-consumption.js';
import { canonicalJson } from '../../domain/src/index.js';
import type { AgentRequesterPrincipal } from '../../identity/src/agent-requester-connections.js';
import { AgentRequesterStore } from './agent-requester.js';
import type { Store } from './store.js';
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const conflict = (message: string) => new DomainError('CONSUMPTION_CONFLICT', message, 409);
const missing = () => new DomainError('NOT_FOUND', '原工作消费记录不存在或无权访问', 404);

/** Metadata only. No provider calls, execution permission, Run or Task mutation. */
export class AgentConsumptionStore {
  private readonly requester: AgentRequesterStore;
  constructor(private readonly store: Store) {
    this.requester = new AgentRequesterStore(store);
  }
  private read<T>(sql: string, id: string): T | null {
    const row = this.store.db.prepare(sql).get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : null;
  }
  private view(requestId: string): C.AgentConsumptionView {
    const binding = this.read<C.AgentOriginalWorkBinding>(
      'SELECT body FROM agent_original_work_bindings WHERE request_id=?',
      requestId,
    );
    if (binding) {
      const row = this.store.db
        .prepare('SELECT cancelled_at FROM agent_consumption_cancellations WHERE binding_id=?')
        .get(binding.id) as { cancelled_at: string } | undefined;
      binding.cancelledAt = row?.cancelled_at ?? null;
    }
    const consumption = this.read<C.AgentResultConsumption>(
      'SELECT body FROM agent_result_consumptions WHERE request_id=?',
      requestId,
    );
    if (consumption)
      consumption.acknowledgement = this.read<C.AgentConsumptionAcknowledgement>(
        'SELECT body FROM agent_consumption_acknowledgements WHERE consumption_id=?',
        consumption.id,
      );
    return { binding, consumption };
  }
  private guard(actor: AgentRequesterPrincipal, requestId: string) {
    // Existing source-selection/version checks run before receipts and inside every transaction.
    const detail = this.requester.get(actor, requestId),
      view = this.view(requestId);
    if (
      view.binding &&
      (view.binding.requesterParticipantId !== actor.participantId ||
        view.binding.requesterConnectionId !== actor.connectionId)
    )
      throw missing();
    return { ...view, assistance: detail.assistance, agent: detail.assistance.agent! };
  }
  private requireBinding(view: C.AgentConsumptionView, id: string) {
    if (!view.binding || view.binding.id !== id) throw conflict('原工作绑定不匹配');
    return view.binding;
  }
  private operation(
    actor: AgentRequesterPrincipal,
    requestId: string,
    action: string,
    key: string,
    payload: unknown,
    guard: () => void,
    change: () => boolean,
    withinCreationTransaction = false,
  ): C.AgentConsumptionDelivery {
    if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key))
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '操作需要有效的 Idempotency-Key');
    guard();
    const scope = `${actor.spaceId}:agent:${actor.participantId}:${actor.connectionId}:agent.consumption:${action}:${requestId}`,
      fingerprint = hash(payload);
    const commit = (): C.AgentConsumptionDelivery => {
      guard();
      const old = this.store.db
        .prepare('SELECT fingerprint FROM idempotency_records WHERE scope=? AND key=?')
        .get(scope, key) as { fingerprint: string } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容', 409);
        return { ...this.view(requestId), delivery: 'replay' };
      }
      const changed = change();
      this.store.db
        .prepare('INSERT INTO idempotency_records VALUES(?,?,?,?)')
        .run(scope, key, fingerprint, JSON.stringify({ requestId }));
      if (changed)
        this.store.db
          .prepare(
            'INSERT INTO outbox(task_id,kind,created_at,space_id,project_id) VALUES(?,?,?,?,?)',
          )
          .run(actor.taskId, 'agent.consumption.updated', now(), actor.spaceId, actor.projectId);
      return { ...this.view(requestId), delivery: changed ? 'first' : 'replay' };
    };
    return withinCreationTransaction ? commit() : this.store.atomic(commit);
  }
  get(actor: AgentRequesterPrincipal, requestId: string): C.AgentConsumptionView {
    const { binding, consumption } = this.guard(actor, requestId);
    return { binding, consumption };
  }
  createBound(actor: AgentRequesterPrincipal, input: unknown, key: string) {
    const data = C.parseAgentBoundRequest(input);
    const request = this.requester.create(actor, data.request, key, (requestId) => {
      this.bindInternal(actor, requestId, { origin: data.origin }, key, true);
    });
    const view = this.get(actor, request.assistance.agent!.requestId);
    // On an old create receipt the callback does not run: never backfill a missing binding.
    if (!view.binding || canonicalJson(view.binding.origin) !== canonicalJson(data.origin))
      throw conflict('创建回执的原工作绑定不匹配');
    return { request, ...view };
  }
  bind(actor: AgentRequesterPrincipal, requestId: string, input: unknown, key: string) {
    return this.bindInternal(actor, requestId, input, key);
  }
  private bindInternal(
    actor: AgentRequesterPrincipal,
    requestId: string,
    input: unknown,
    key: string,
    withinCreationTransaction = false,
  ) {
    const data = C.parseAgentOriginalWorkBinding(input);
    const guard = () => {
      const v = this.guard(actor, requestId);
      if (v.binding) {
        if (canonicalJson(v.binding.origin) !== canonicalJson(data.origin))
          throw conflict('原工作不可重新绑定');
        return;
      }
      if (v.assistance.state !== 'open' || v.agent.responses.some((r) => r.type === 'answer'))
        throw conflict('必须在答案保存前绑定原工作');
      const original = this.store.db
        .prepare('SELECT body FROM assistance_input_revisions WHERE assistance_id=? AND revision=1')
        .get(v.assistance.id) as { body: string } | undefined;
      const author = original && JSON.parse(original.body).actor;
      if (
        !author ||
        author.kind !== 'agent' ||
        author.participantId !== actor.participantId ||
        author.connectionId !== actor.connectionId
      )
        throw missing();
    };
    return this.operation(
      actor,
      requestId,
      'binding',
      key,
      data,
      guard,
      () => {
        if (this.view(requestId).binding) return false;
        const binding: C.AgentOriginalWorkBinding = {
          source: 'host_reported',
          id: randomUUID(),
          requestId,
          requesterParticipantId: actor.participantId,
          requesterConnectionId: actor.connectionId,
          origin: data.origin,
          createdAt: now(),
          cancelledAt: null,
        };
        this.store.db
          .prepare('INSERT INTO agent_original_work_bindings VALUES(?,?,?,?,?,?)')
          .run(
            binding.id,
            requestId,
            actor.taskId,
            actor.participantId,
            actor.connectionId,
            JSON.stringify(binding),
          );
        return true;
      },
      withinCreationTransaction,
    );
  }
  consume(actor: AgentRequesterPrincipal, requestId: string, input: unknown, key: string) {
    const data = C.parseAgentConsume(input);
    const guard = () => {
      const v = this.guard(actor, requestId),
        binding = this.requireBinding(v, data.bindingId);
      if (binding.cancelledAt)
        throw new DomainError('CONSUMPTION_CANCELLED', '未来消费已取消；已存在执行状态仍未知', 409);
      if (
        v.assistance.state !== 'responded' ||
        v.agent.phase !== 'answered' ||
        v.assistance.accessEnded
      )
        throw conflict('当前请求没有可消费的有效答案');
      if (
        v.agent.currentInputRevision !== data.inputRevision ||
        v.agent.inputHash !== data.inputHash ||
        v.agent.accessRevision !== data.accessRevision
      )
        throw conflict('输入或访问版本已改变');
      const answer = v.agent.responses.find((r) => r.id === data.responseId);
      if (
        !answer ||
        answer.type !== 'answer' ||
        answer.actor.kind !== 'agent' ||
        answer.actor.participantId !== v.agent.recipientParticipantId ||
        answer.inputRevision !== data.inputRevision ||
        answer.inputHash !== data.inputHash ||
        answer.accessRevision !== data.accessRevision
      )
        throw conflict('答案与固定输入不匹配');
      if (
        v.consumption &&
        (v.consumption.responseId !== answer.id ||
          v.consumption.answerHash !== hash(answer.body) ||
          v.consumption.inputRevision !== data.inputRevision ||
          v.consumption.inputHash !== data.inputHash ||
          v.consumption.accessRevision !== data.accessRevision)
      )
        throw conflict('请求已固定消费其他答案');
      return { v, answer };
    };
    return this.operation(actor, requestId, 'consume', key, data, guard, () => {
      const { v, answer } = guard();
      if (v.consumption) return false;
      const consumption: C.AgentResultConsumption = {
        id: randomUUID(),
        requestId,
        ...data,
        answerHash: hash(answer.body),
        answer: answer.body,
        sourceActor: answer.actor,
        materialIds: v.agent.materials.map((m) => m.id),
        claimedAt: now(),
        acknowledgement: null,
      };
      this.store.db
        .prepare('INSERT INTO agent_result_consumptions VALUES(?,?,?,?)')
        .run(consumption.id, requestId, data.bindingId, JSON.stringify(consumption));
      return true;
    });
  }
  acknowledge(actor: AgentRequesterPrincipal, requestId: string, input: unknown, key: string) {
    const data = C.parseAgentConsumptionAck(input);
    const guard = () => {
      const v = this.guard(actor, requestId),
        binding = this.requireBinding(v, data.bindingId);
      if (!v.consumption || v.consumption.id !== data.consumptionId)
        throw conflict('消费记录不匹配');
      if (
        binding.origin.threadRef !== data.threadRef ||
        binding.origin.sessionRef !== data.sessionRef
      )
        throw conflict('后续输出不属于已绑定的原工作');
      if (data.turnRef === data.threadRef || data.turnRef === data.sessionRef)
        throw conflict('后续回合需单独的观察引用');
      const ack = v.consumption.acknowledgement;
      if (ack && (ack.turnRef !== data.turnRef || ack.output !== data.output))
        throw conflict('已保存的后续观察不可改写');
      return v;
    };
    return this.operation(actor, requestId, 'ack', key, data, guard, () => {
      const v = guard();
      if (v.consumption!.acknowledgement) return false;
      const cancelled = !!v.binding!.cancelledAt || v.assistance.state === 'cancelled';
      const ack: C.AgentConsumptionAcknowledgement = {
        evidence: 'external_self_report',
        turnRef: data.turnRef,
        output: data.output,
        outputHash: hash(data.output),
        observedAt: now(),
        cancelled,
        late:
          cancelled ||
          v.assistance.state === 'closed' ||
          v.agent.currentInputRevision !== v.consumption!.inputRevision,
      };
      this.store.db
        .prepare('INSERT INTO agent_consumption_acknowledgements VALUES(?,?)')
        .run(data.consumptionId, JSON.stringify(ack));
      return true;
    });
  }
  cancel(actor: AgentRequesterPrincipal, requestId: string, input: unknown, key: string) {
    const data = C.parseAgentConsumptionCancel(input);
    const guard = () => {
      this.requireBinding(this.guard(actor, requestId), data.bindingId);
    };
    return this.operation(actor, requestId, 'cancel', key, data, guard, () => {
      if (this.view(requestId).binding!.cancelledAt) return false;
      this.store.db
        .prepare('INSERT INTO agent_consumption_cancellations VALUES(?,?)')
        .run(data.bindingId, now());
      return true;
    });
  }
  listForTask(taskId: string): { items: C.AgentTaskConsumption[] } {
    this.store.getTask(taskId);
    const rows = this.store.db
      .prepare(
        'SELECT request_id FROM agent_original_work_bindings WHERE task_id=? ORDER BY rowid DESC',
      )
      .all(taskId) as { request_id: string }[];
    return {
      items: rows.map((row) => {
        const v = this.view(row.request_id),
          b = v.binding!;
        return {
          requestId: row.request_id,
          binding: {
            id: b.id,
            requesterParticipantId: b.requesterParticipantId,
            provider: b.origin.provider,
            createdAt: b.createdAt,
            cancelledAt: b.cancelledAt,
          },
          consumption: v.consumption,
        };
      }),
    };
  }
  /** A single safe original-work view for an authorized parent Task reader. */
  getForTask(taskId: string, requestId: string): C.AgentTaskConsumption | null {
    this.store.getTask(taskId);
    if (
      !this.store.db
        .prepare('SELECT 1 FROM agent_original_work_bindings WHERE task_id=? AND request_id=?')
        .get(taskId, requestId)
    )
      return null;
    const { binding, consumption } = this.view(requestId);
    const b = binding!;
    return {
      requestId,
      binding: {
        id: b.id,
        requesterParticipantId: b.requesterParticipantId,
        provider: b.origin.provider,
        createdAt: b.createdAt,
        cancelledAt: b.cancelledAt,
      },
      consumption,
    };
  }
}
