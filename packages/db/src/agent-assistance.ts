import { revalidateAgentReceiverRequestPrincipal } from '../../identity/src/agent-receiver-connections.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError, type Task, type Message } from '../../contracts/src/index.js';
import {
  selectedAssistanceText,
  parseAssistanceStateChange,
  type AssistanceDetail,
} from '../../contracts/src/assistance.js';
import * as C from '../../contracts/src/agent-assistance.js';
import type { DelegationGrant, AgentParticipant } from '../../contracts/src/agent-capabilities.js';
import type { ProjectSource } from '../../contracts/src/project-sources.js';
import { canonicalJson, assertRevision } from '../../domain/src/index.js';
import type { AgentAssistancePrincipal } from '../../identity/src/agent-assistance-connections.js';
import {
  revalidateAgentRequesterConnection,
  assertAgentRequesterSelection,
  type AgentRequesterPrincipal,
} from '../../identity/src/agent-requester-connections.js';
type AssistanceActor = AgentAssistancePrincipal | AgentRequesterPrincipal;
const isRequester = (actor: AssistanceActor): actor is AgentRequesterPrincipal =>
  'role' in actor && actor.role === 'requester';
import type { Store } from './store.js';
import type { AssistanceRecord } from './assistance.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const now = () => new Date().toISOString();
const missing = () => new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
interface Envelope {
  assistance_id: string;
  request_id: string;
  recipient_participant_id: string;
  requester_participant_id: string | null;
  grant_id: string;
  capability_id: string;
  capability_version: number;
  endpoint_revision: number;
  grant_revision: number;
  input_revision: number;
  access_revision: number;
  revoked_at: string | null;
  body: string;
}
interface InputRecord {
  revision: number;
  inputHash: string;
  selection: C.AgentAssistanceInputSelection;
  materials: C.AgentAssistanceMaterial[];
  createdAt: string;
  causeResponseId: string | null;
  actor: C.AgentAssistanceActor;
}
/** Additional records index the original Assistance; they never own a second task/run lifecycle. */
export class AgentAssistanceStore {
  constructor(private readonly store: Store) {}
  private decode<T>(sql: string, ...args: (string | number)[]): T | undefined {
    const row = this.store.db.prepare(sql).get(...args) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : undefined;
  }
  isAgent(id: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM assistance_agent_requests WHERE assistance_id=?')
      .get(id);
  }
  byRequestId(id: string) {
    const row = this.store.db
      .prepare('SELECT assistance_id FROM assistance_agent_requests WHERE request_id=?')
      .get(id) as { assistance_id: string } | undefined;
    if (!row) throw missing();
    return row.assistance_id;
  }
  private raw(id: string) {
    const item = this.decode<AssistanceRecord>('SELECT body FROM assistances WHERE id=?', id);
    const env = this.store.db
      .prepare('SELECT * FROM assistance_agent_requests WHERE assistance_id=?')
      .get(id) as Envelope | undefined;
    if (!item || !env) throw missing();
    return { item, env };
  }
  private task(item: AssistanceRecord) {
    const task = this.decode<Task>('SELECT body FROM tasks WHERE id=?', item.taskId);
    if (!task) throw missing();
    return task;
  }
  private person(id: string, space: string) {
    const p = this.store.db
      .prepare(
        'SELECT p.id,p.name FROM collab_people p JOIN collab_memberships m ON m.user_id=p.id WHERE p.id=? AND m.space_id=?',
      )
      .get(id, space) as { id: string; name: string } | undefined;
    if (!p) throw missing();
    return p;
  }
  private human() {
    if (!this.store.teamMode) throw new DomainError('TEAM_MODE_REQUIRED', '需要真实账号', 422);
    this.store.permissions.space();
    return { kind: 'human' as const, userId: this.store.actorId };
  }
  private author(actor?: AgentRequesterPrincipal): C.AgentAssistanceActor {
    return actor
      ? {
          kind: 'agent',
          participantId: actor.participantId,
          ownerUserId: actor.ownerUserId,
          connectionId: actor.connectionId,
          connectionRevision: actor.connectionRevision,
        }
      : this.human();
  }
  /** Explicit requester authority, never a borrowed human principal. Also runs inside writes. */
  private requesterTask(taskId: string, actor?: AgentRequesterPrincipal) {
    if (!actor) {
      this.human();
      return this.store.getTask(taskId, true);
    }
    revalidateAgentRequesterConnection(this.store.db, actor);
    if (actor.taskId !== taskId) throw missing();
    const task = this.decode<Task>('SELECT body FROM tasks WHERE id=?', taskId);
    if (
      !task ||
      task.spaceId !== actor.spaceId ||
      task.projectId !== actor.projectId ||
      task.visibility !== 'project'
    )
      throw missing();
    this.authority(task, actor.bound.target, actor.ownerUserId, actor.participantId);
    // Check the entire original selection before receipt replay, even after an Agent shrinks it.
    this.selected(
      task,
      actor.bound.input,
      true,
      actor.bound.materials.map((material) => material.id),
    );
    return task;
  }
  validateRequester(actor: AgentRequesterPrincipal) {
    return this.requesterTask(actor.taskId, actor);
  }
  private target(env: Envelope): C.AgentAssistanceTarget {
    return {
      participantId: env.recipient_participant_id,
      capabilityId: env.capability_id,
      capabilityVersion: env.capability_version,
      endpointRevision: env.endpoint_revision,
      grantId: env.grant_id,
      grantRevision: env.grant_revision,
    };
  }
  private authority(
    task: Task,
    target: C.AgentAssistanceTarget,
    requester: string,
    requesterParticipantId: string | null,
  ) {
    if (task.visibility !== 'project' || !task.projectId)
      throw new DomainError('AGENT_ASSISTANCE_SCOPE', '此片仅支持项目任务的明确文本分享', 422);
    const row = this.store.db
      .prepare(
        `SELECT g.body,g.revision,g.revoked_at,a.body AS agent_body FROM agent_delegation_grants g JOIN agent_participants a ON a.id=g.participant_id JOIN agent_endpoints e ON e.participant_id=a.id JOIN agent_capabilities c ON c.participant_id=a.id JOIN projects p ON p.id=g.project_id JOIN collab_memberships m ON m.user_id=a.owner_user_id AND m.space_id=a.space_id JOIN collab_project_members pm ON pm.user_id=a.owner_user_id AND pm.project_id=p.id JOIN collab_project_members rm ON rm.user_id=? AND rm.project_id=p.id JOIN collab_memberships sm ON sm.user_id=? AND sm.space_id=a.space_id WHERE g.id=? AND g.project_id=? AND a.id=? AND a.space_id=? AND a.revoked_at IS NULL AND g.revoked_at IS NULL AND g.revision=? AND e.revision=? AND c.id=? AND c.version=? AND pm.role IN ('edit','manage') AND rm.role IN ('edit','manage') AND json_extract(p.body,'$.archivedAt') IS NULL`,
      )
      .get(
        requester,
        requester,
        target.grantId,
        task.projectId,
        target.participantId,
        task.spaceId,
        target.grantRevision,
        target.endpointRevision,
        target.capabilityId,
        target.capabilityVersion,
      ) as { body: string; agent_body: string } | undefined;
    if (!row) throw missing();
    const grant = JSON.parse(row.body) as DelegationGrant;
    const agent = JSON.parse(row.agent_body) as AgentParticipant;
    if (
      !grant.request ||
      grant.expiresAt <= now() ||
      grant.capabilityId !== target.capabilityId ||
      grant.capabilityVersion !== target.capabilityVersion ||
      grant.endpointRevision !== target.endpointRevision ||
      (grant.audience === 'selected_members' && !grant.requesterUserIds.includes(requester))
    )
      throw missing();
    if (requesterParticipantId) {
      const p = this.store.db
        .prepare(
          'SELECT 1 FROM agent_participants WHERE id=? AND owner_user_id=? AND space_id=? AND revoked_at IS NULL',
        )
        .get(requesterParticipantId, requester, task.spaceId);
      if (!p || requesterParticipantId === target.participantId)
        throw new DomainError('INVALID_PARTICIPANT', '发起身份需本人所有且与接收身份不同', 422);
    }
    return { grant, agent };
  }
  /** Expiry permanently ends old grants before any replay, including capacity accounting. */
  private expire() {
    this.store.db
      .prepare(
        `UPDATE assistance_agent_requests SET revoked_at=? WHERE revoked_at IS NULL AND grant_id IN (SELECT id FROM agent_delegation_grants WHERE json_extract(body,'$.expiresAt')<=?)`,
      )
      .run(now(), now());
  }
  revalidate(actor: AgentAssistancePrincipal) {
    if (actor.receiverConnection) {
      revalidateAgentReceiverRequestPrincipal(this.store.db, actor);
      return;
    }
    const row = this.store.db
      .prepare(
        'SELECT revision,scopes FROM assistance_agent_credentials WHERE id=? AND assistance_id=? AND participant_id=? AND revoked_at IS NULL AND expires_at>?',
      )
      .get(actor.connectionId, actor.assistanceId, actor.participantId, now()) as
      | { revision: number; scopes: string }
      | undefined;
    if (
      !row ||
      row.revision !== actor.connectionRevision ||
      canonicalJson(JSON.parse(row.scopes)) !== canonicalJson(actor.scopes)
    )
      throw missing();
  }
  private access(
    id: string,
    action: 'read' | 'respond' | 'manage' | 'credential',
    actor?: AssistanceActor,
  ) {
    this.expire();
    const { item, env } = this.raw(id),
      task = this.task(item);
    const requesterActor = actor && isRequester(actor) ? actor : undefined;
    if (requesterActor) {
      this.requesterTask(task.id, requesterActor);
      if (
        env.requester_participant_id !== requesterActor.participantId ||
        item.requester.id !== requesterActor.ownerUserId ||
        !['read', 'manage'].includes(action)
      )
        throw missing();
      const inputs = this.store.db
        .prepare('SELECT body FROM assistance_input_revisions WHERE assistance_id=?')
        .all(id) as { body: string }[];
      for (const row of inputs) {
        const input = JSON.parse(row.body) as InputRecord;
        assertAgentRequesterSelection(
          requesterActor,
          task.id,
          env.requester_participant_id,
          this.target(env),
          input.selection,
        );
        // A new limited credential must not reinterpret legacy ordinal IDs or an
        // incompatible catalog. Human and receiver history remain unchanged.
        if (
          canonicalJson(input.materials.map((material) => material.id)) !==
          canonicalJson(this.requesterMaterialIds(input.selection, requesterActor))
        )
          throw new DomainError(
            'AGENT_SCOPE_REQUIRED',
            '请求材料标识与此凭据的固定目录不一致',
            403,
          );
      }
    } else if (actor) {
      const receiver = actor as AgentAssistancePrincipal;
      this.revalidate(receiver);
      if (
        receiver.assistanceId !== id ||
        actor.participantId !== env.recipient_participant_id ||
        actor.spaceId !== item.spaceId ||
        !receiver.scopes.includes('material_read') ||
        (action === 'respond' && !receiver.scopes.includes('respond')) ||
        !['read', 'respond'].includes(action)
      )
        throw missing();
    } else {
      this.human();
      if (item.spaceId !== this.store.spaceId) throw missing();
    }
    let valid = true;
    try {
      if (env.revoked_at) throw missing();
      this.authority(task, this.target(env), item.requester.id, env.requester_participant_id);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      valid = false;
    }
    const parent = !actor && this.store.permissions.canTask(task);
    const requester = !!requesterActor || (!actor && item.requester.id === this.store.actorId);
    const owner = !actor && item.recipient.id === this.store.actorId;
    if (
      !valid &&
      !(
        action === 'read' &&
        (parent || (requesterActor && JSON.parse(env.body).terminalReason === 'cancelled'))
      ) &&
      !(
        action === 'manage' &&
        (parent || requesterActor) &&
        requester &&
        JSON.parse(env.body).terminalReason === 'cancelled'
      )
    )
      throw missing();
    if (
      action === 'manage' &&
      (!requester || (!requesterActor && !this.store.permissions.canTask(task, true)))
    )
      throw missing();
    if (action === 'credential' && !owner) throw missing();
    if (action === 'respond' && !actor && !owner) throw missing();
    if (action === 'read' && !actor && !parent && !owner) throw missing();
    if (valid && ((actor && !requesterActor) || owner)) {
      const scopes = action === 'respond' ? ['material_read', 'respond'] : ['material_read'];
      for (const scope of scopes) {
        const row = this.store.db
          .prepare(
            'SELECT 1 FROM assistance_input_grants WHERE assistance_id=? AND input_revision=? AND subject_id=? AND scope=? AND revoked_at IS NULL AND expires_at>?',
          )
          .get(id, env.input_revision, env.recipient_participant_id, scope, now());
        if (!row) throw missing();
      }
    }
    return { item, env, task, valid, parent, requester, owner };
  }
  private write(
    scope: string,
    key: string,
    payload: unknown,
    guard: () => void,
    action: () => { id: string },
    actor?: AssistanceActor,
  ) {
    if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key))
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '操作需要有效的 Idempotency-Key');
    guard();
    const actorKey = actor
      ? `agent:${actor.participantId}:${actor.connectionId}`
      : `human:${this.store.actorId}`;
    const full = `${actor?.spaceId ?? this.store.spaceId}:${actorKey}:agent.assistance:${scope}`;
    const fingerprint = hash(payload);
    return this.store.atomic(() => {
      guard();
      const old = this.store.db
        .prepare('SELECT fingerprint,result FROM idempotency_records WHERE scope=? AND key=?')
        .get(full, key) as { fingerprint: string; result: string } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容', 409);
        return JSON.parse(old.result) as { id: string };
      }
      const result = action();
      this.store.db
        .prepare('INSERT INTO idempotency_records VALUES(?,?,?,?)')
        .run(full, key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  private event(item: AssistanceRecord, action: string, actor: string) {
    this.store.db
      .prepare('INSERT INTO assistance_events VALUES(?,?,?,?,?)')
      .run(item.id, item.revision, actor, action, item.updatedAt);
    this.store.db
      .prepare(
        "INSERT INTO outbox(kind,created_at,space_id,assistance_id) VALUES('assistance.updated',?,?,?)",
      )
      .run(item.updatedAt, item.spaceId, item.id);
  }
  private save(item: AssistanceRecord, action: string, actor: string) {
    this.store.db
      .prepare('UPDATE assistances SET state=?,body=? WHERE id=?')
      .run(item.state, JSON.stringify(item), item.id);
    this.event(item, action, actor);
  }
  private inputRaw(id: string, revision: number) {
    const input = this.decode<InputRecord>(
      'SELECT body FROM assistance_input_revisions WHERE assistance_id=? AND revision=?',
      id,
      revision,
    );
    if (!input) throw missing();
    return input;
  }
  private selected(
    task: Task,
    input: C.AgentAssistanceInputSelection,
    strictHash: boolean,
    materialIds?: string[],
  ) {
    const message = this.decode<Message>(
      'SELECT body FROM messages WHERE id=? AND task_id=?',
      input.message.sourceMessageId,
      task.id,
    );
    if (!message || !['human', 'agent'].includes(message.actorType)) throw missing();
    if (hash(message) !== input.message.expectedSourceHash)
      throw new DomainError('INPUT_STALE', '来源已变化，请明确重新选材', 409);
    const snapshot = {
      text: selectedAssistanceText(message.body, input.message.range),
      actorType: message.actorType as 'human' | 'agent',
      actorName: message.actorName,
      createdAt: message.createdAt,
      sourceHash: hash(message),
    };
    const materials: C.AgentAssistanceMaterial[] = [
      {
        id: 'message',
        label: '已选消息摘录',
        text: snapshot.text,
      },
    ];
    for (const ref of input.projectTexts.items) {
      const source = this.decode<ProjectSource>(
        'SELECT body FROM project_sources WHERE id=? AND project_id=? AND space_id=?',
        ref.id,
        task.projectId!,
        task.spaceId,
      );
      if (!source || source.deletedAt || source.kind !== 'text' || source.url)
        throw new DomainError('INPUT_STALE', '仅可选择当前同项目纯文本资料', 409);
      if (source.revision !== ref.revision || source.contentHash !== ref.contentHash)
        throw new DomainError('INPUT_STALE', '资料已变化，请明确重新选材', 409);
      let text = source.content.slice(0, ref.maxChars);
      if (
        /[\uD800-\uDBFF]$/.test(text) ||
        (text.endsWith('\r') && source.content[text.length] === '\n')
      )
        text = text.slice(0, -1);
      materials.push({
        // Source-derived opaque IDs are stable across subset order, owners' previews and credentials.
        // Stored historical IDs still take precedence when validating immutable old inputs.
        id:
          materialIds?.[materials.length] ??
          `text-${createHash('sha256').update(source.id).digest('hex')}`,
        label: source.title,
        text,
      });
    }
    const projectHash = hash(materials.slice(1));
    if (strictHash && projectHash !== input.projectTexts.expectedHash)
      throw new DomainError('INPUT_STALE', '资料预览已变化', 409);
    if (
      materials.slice(1).reduce((n, m) => n + m.text.length + m.label.length, 0) > 10000 ||
      canonicalJson({ question: input.question, clarification: input.clarification, materials })
        .length > 20000
    )
      throw new DomainError('INPUT_BUDGET', '共享文本超出预算', 422);
    const selection = {
      ...input,
      projectTexts: { ...input.projectTexts, expectedHash: projectHash },
    };
    return { snapshot, materials, selection, inputHash: hash({ selection, materials }) };
  }
  private requesterMaterialIds(
    input: C.AgentAssistanceInputSelection,
    actor?: AgentRequesterPrincipal,
  ) {
    return actor
      ? [
          'message',
          ...input.projectTexts.items.map(
            (ref) =>
              actor.bound.materials[
                actor.bound.input.projectTexts.items.findIndex(
                  (allowed) => canonicalJson(ref) === canonicalJson(allowed),
                ) + 1
              ]!.id,
          ),
        ]
      : undefined;
  }
  preview(taskId: string, input: unknown, actor?: AgentRequesterPrincipal) {
    const data = C.parseAgentAssistancePreview(input);
    const task = this.requesterTask(taskId, actor);
    if (actor)
      assertAgentRequesterSelection(
        actor,
        taskId,
        data.requesterParticipantId,
        data.target,
        data.input,
      );
    this.authority(
      task,
      data.target,
      actor?.ownerUserId ?? this.store.actorId,
      data.requesterParticipantId,
    );
    const result = this.selected(
      task,
      data.input,
      false,
      this.requesterMaterialIds(data.input, actor),
    );
    return {
      ...data,
      input: result.selection,
      expectedTaskRevision: task.revision,
      inputHash: result.inputHash,
      materials: result.materials,
      question: data.input.question,
      clarification: data.input.clarification,
    };
  }
  private addInput(item: AssistanceRecord, env: Envelope, input: InputRecord, expiresAt: string) {
    this.store.db
      .prepare('INSERT INTO assistance_input_revisions VALUES(?,?,?,?)')
      .run(item.id, input.revision, input.inputHash, JSON.stringify(input));
    for (const scope of ['material_read', 'respond'])
      this.store.db
        .prepare('INSERT INTO assistance_input_grants VALUES(?,?,?,?,?,?,?,NULL)')
        .run(
          item.id,
          input.revision,
          env.recipient_participant_id,
          scope,
          input.inputHash,
          env.access_revision,
          expiresAt,
        );
  }
  private responses(id: string) {
    return (
      this.store.db
        .prepare('SELECT body FROM assistance_replies WHERE assistance_id=? ORDER BY revision')
        .all(id) as { body: string }[]
    ).map((r) => JSON.parse(r.body) as C.AgentAssistanceResponseRecord);
  }
  private stage(item: AssistanceRecord, env: Envelope) {
    const responses = this.responses(item.id).filter((r) => r.inputRevision === env.input_revision);
    const last = responses.at(-1);
    return {
      responses,
      last,
      accepted: responses.some((r) => r.type === 'accept'),
      pending: last && ['request_input', 'propose_scope'].includes(last.type) ? last : null,
    };
  }
  private accept(
    item: AssistanceRecord,
    env: Envelope,
    actor: C.AgentAssistanceActor,
    automatic: boolean,
  ) {
    const { grant } = this.authority(
      this.task(item),
      this.target(env),
      item.requester.id,
      env.requester_participant_id,
    );
    const count = this.store.db
      .prepare('SELECT count(*) AS n FROM assistance_agent_capacity WHERE grant_id=?')
      .get(env.grant_id) as { n: number };
    if (count.n >= grant.maxConcurrent) {
      if (automatic) return false;
      throw new DomainError('CAPACITY_LIMIT', '此预授权的接受容量已满', 409);
    }
    this.store.db
      .prepare('INSERT INTO assistance_agent_capacity VALUES(?,?,?,?)')
      .run(item.id, env.grant_id, env.input_revision, now());
    this.append(item, env, 'accept', '', null, actor);
    return true;
  }
  private append(
    item: AssistanceRecord,
    env: Envelope,
    type: C.AgentAssistanceResponseRecord['type'],
    body: string,
    scope: C.AgentAssistanceResponseRecord['scope'],
    actor: C.AgentAssistanceActor,
  ) {
    item.revision++;
    item.updatedAt = now();
    const current = this.inputRaw(item.id, env.input_revision);
    const response = {
      id: randomUUID(),
      revision: item.revision,
      type,
      body,
      scope,
      actor,
      inputRevision: env.input_revision,
      inputHash: current.inputHash,
      accessRevision: env.access_revision,
      createdAt: item.updatedAt,
    };
    this.store.db
      .prepare('INSERT INTO assistance_replies VALUES(?,?,?)')
      .run(item.id, item.revision, JSON.stringify(response));
    this.save(
      item,
      type,
      actor.kind === 'human'
        ? actor.userId
        : actor.kind === 'agent'
          ? actor.participantId
          : 'policy',
    );
    return response;
  }
  create(
    taskId: string,
    input: unknown,
    key: string,
    actor?: AgentRequesterPrincipal,
    onCreated?: (requestId: string) => void,
  ): AssistanceDetail {
    const data = C.parseAgentAssistanceCreate(input);
    const guard = () => {
      const task = this.requesterTask(taskId, actor);
      if (actor)
        assertAgentRequesterSelection(
          actor,
          taskId,
          data.requesterParticipantId,
          data.target,
          data.input,
        );
      this.authority(
        task,
        data.target,
        actor?.ownerUserId ?? this.store.actorId,
        data.requesterParticipantId,
      );
    };
    const receipt = this.write(
      `create:${taskId}`,
      key,
      data,
      guard,
      () => {
        const task = this.requesterTask(taskId, actor);
        assertRevision(task.revision, data.expectedTaskRevision);
        const auth = this.authority(
          task,
          data.target,
          actor?.ownerUserId ?? this.store.actorId,
          data.requesterParticipantId,
        );
        const selected = this.selected(
          task,
          data.input,
          true,
          this.requesterMaterialIds(data.input, actor),
        );
        if (selected.inputHash !== data.expectedInputHash)
          throw new DomainError('INPUT_STALE', '请确认当前选材预览', 409);
        const count = this.store.db
          .prepare(
            "SELECT count(*) AS n FROM assistances WHERE space_id=? AND requester_id=? AND state IN ('open','responded')",
          )
          .get(task.spaceId, actor?.ownerUserId ?? this.store.actorId) as { n: number };
        if (count.n >= 50) throw new DomainError('ASSISTANCE_LIMIT', '请先处理已有未结束协助', 422);
        const at = now();
        const item: AssistanceRecord = {
          id: randomUUID(),
          recipientKind: 'agent',
          taskId,
          spaceId: task.spaceId,
          question: data.input.question,
          requester: this.person(actor?.ownerUserId ?? this.store.actorId, task.spaceId),
          recipient: this.person(auth.agent.ownerUserId, task.spaceId),
          state: 'open',
          revision: 1,
          createdAt: at,
          updatedAt: at,
          sourceMessageId: data.input.message.sourceMessageId,
          sourceRange: data.input.message.range,
          taskRevision: task.revision,
          snapshot: selected.snapshot,
          snapshotHash: hash(selected.snapshot),
        };
        const env: Envelope = {
          assistance_id: item.id,
          request_id: randomUUID(),
          recipient_participant_id: data.target.participantId,
          requester_participant_id: data.requesterParticipantId,
          grant_id: data.target.grantId,
          capability_id: data.target.capabilityId,
          capability_version: data.target.capabilityVersion,
          endpoint_revision: data.target.endpointRevision,
          grant_revision: data.target.grantRevision,
          input_revision: 1,
          access_revision: 1,
          revoked_at: null,
          body: '{}',
        };
        this.store.db
          .prepare('INSERT INTO assistances VALUES(?,?,?,?,?,?,?)')
          .run(
            item.id,
            item.spaceId,
            taskId,
            item.requester.id,
            item.recipient.id,
            item.state,
            JSON.stringify(item),
          );
        this.store.db
          .prepare('INSERT INTO assistance_agent_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(...Object.values(env));
        this.addInput(
          item,
          env,
          {
            revision: 1,
            inputHash: selected.inputHash,
            selection: selected.selection,
            materials: selected.materials,
            createdAt: at,
            causeResponseId: null,
            actor: this.author(actor),
          },
          auth.grant.expiresAt,
        );
        this.event(item, 'created', actor?.participantId ?? this.store.actorId);
        if (auth.grant.autoAccept)
          this.accept(
            item,
            env,
            {
              kind: 'policy',
              ownerUserId: auth.agent.ownerUserId,
              grantRevision: auth.grant.revision,
            },
            true,
          );
        // Trusted internal extension executes before the original receipt/outbox transaction commits.
        // Used only to bind requester original work atomically; never starts execution.
        onCreated?.(env.request_id);
        return { id: item.id };
      },
      actor,
    );
    return this.get(receipt.id, actor);
  }
  get(id: string, actor?: AssistanceActor): AssistanceDetail {
    const { item, env, task, valid, parent, requester, owner } = this.access(id, 'read', actor),
      input = this.inputRaw(id, env.input_revision),
      stage = this.stage(item, env);
    let sourceChanged: boolean | null = null;
    if (parent) {
      try {
        this.selected(
          task,
          input.selection,
          true,
          input.materials.map((material) => material.id),
        );
        sourceChanged = false;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        sourceChanged = true;
      }
    }
    const canManage = !actor && valid && requester && this.store.permissions.canTask(task, true);
    const terminal = item.state === 'closed' || item.state === 'cancelled';
    const all = this.responses(id).filter(
      (r) =>
        parent ||
        (actor && isRequester(actor)) ||
        !!this.store.db
          .prepare(
            "SELECT 1 FROM assistance_input_grants WHERE assistance_id=? AND input_revision=? AND subject_id=? AND scope='material_read' AND revoked_at IS NULL AND expires_at>?",
          )
          .get(id, r.inputRevision, env.recipient_participant_id, now()),
    );
    const terminalReason: C.AgentAssistanceTerminalReason | null = env.revoked_at
      ? (JSON.parse(env.body).terminalReason ?? 'access_revoked')
      : item.state === 'cancelled'
        ? 'cancelled'
        : item.state === 'closed'
          ? all.at(-1)?.type === 'decline'
            ? 'declined'
            : 'requester_closed'
          : null;
    const phase: C.AgentAssistancePhase = terminal
      ? 'terminal'
      : item.state === 'responded'
        ? 'answered'
        : stage.pending
          ? 'waiting_input'
          : stage.accepted
            ? 'accepted'
            : 'awaiting_acceptance';
    const policy = valid
      ? this.authority(task, this.target(env), item.requester.id, env.requester_participant_id)
          .grant
      : null;
    const reservations = this.store.db
      .prepare('SELECT count(*) AS n FROM assistance_agent_capacity WHERE grant_id=?')
      .get(env.grant_id) as { n: number };
    const agent: C.AgentAssistanceMetadata = {
      capacityBlocked:
        !!policy &&
        policy.autoAccept &&
        phase === 'awaiting_acceptance' &&
        reservations.n >= policy.maxConcurrent,
      requestId: env.request_id,
      requesterParticipantId: env.requester_participant_id,
      recipientParticipantId: env.recipient_participant_id,
      capabilityId: env.capability_id,
      capabilityVersion: env.capability_version,
      endpointRevision: env.endpoint_revision,
      grantId: env.grant_id,
      grantRevision: env.grant_revision,
      currentInputRevision: env.input_revision,
      accessRevision: env.access_revision,
      inputHash: input.inputHash,
      phase,
      terminalReason,
      materials: input.materials,
      responses: all,
      pendingResponseId: stage.pending?.id ?? null,
      clarification: input.selection.clarification,
      ...(canManage ? { editInput: input.selection } : {}),
      canIssueCredential: !actor && owner && valid,
      ...(!actor && owner ? { credential: this.credential(id) } : {}),
    };
    return {
      assistance: {
        id: item.id,
        recipientKind: 'agent',
        agent,
        question: input.selection.question,
        requester: item.requester,
        recipient: item.recipient,
        state: item.state,
        revision: item.revision,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        snapshot:
          !actor && parent
            ? item.snapshot
            : {
                text: input.materials[0]!.text,
                actorType: item.snapshot.actorType,
                actorName: item.snapshot.actorName,
                createdAt: input.createdAt,
                sourceHash: '',
              },
        snapshotHash: !actor && parent ? item.snapshotHash : '',
        sourceChanged,
        taskLink: parent ? { id: task.id, title: task.title, shortId: task.shortId } : null,
        canReply: valid && item.state === 'open' && ((!!actor && !isRequester(actor)) || owner),
        canManage,
        canAdopt: false,
        canEditTask: !actor && this.store.permissions.canTask(task, true),
        accessEnded: !valid,
      },
      replies: [],
      nextBefore: null,
    };
  }
  input(id: string, revision: number, actor?: AgentAssistancePrincipal) {
    const { env, item, parent } = this.access(id, 'read', actor);
    const input = this.inputRaw(id, revision);
    if (!parent) {
      const grant = this.store.db
        .prepare(
          "SELECT 1 FROM assistance_input_grants WHERE assistance_id=? AND input_revision=? AND subject_id=? AND scope='material_read' AND revoked_at IS NULL AND expires_at>?",
        )
        .get(id, revision, env.recipient_participant_id, now());
      if (!grant) throw missing();
    }
    return {
      requestId: env.request_id,
      revision,
      inputHash: input.inputHash,
      question: input.selection.question,
      clarification: input.selection.clarification,
      materials: input.materials,
      createdAt: input.createdAt,
    };
  }
  respond(id: string, input: unknown, key: string, actor?: AgentAssistancePrincipal) {
    const data = C.parseAgentAssistanceResponse(input);
    this.write(
      `respond:${id}`,
      key,
      data,
      () => {
        this.access(id, 'respond', actor);
      },
      () => {
        const { item, env, task } = this.access(id, 'respond', actor);
        assertRevision(item.revision, data.expectedRevision);
        assertRevision(env.input_revision, data.inputRevision);
        assertRevision(env.access_revision, data.expectedAccessRevision);
        const current = this.inputRaw(id, env.input_revision);
        if (current.inputHash !== data.expectedInputHash)
          throw new DomainError('INPUT_STALE', '输入版本已变化', 409);
        if (data.type === 'accept' || data.type === 'answer')
          this.selected(
            task,
            current.selection,
            true,
            current.materials.map((material) => material.id),
          );
        if (item.state !== 'open')
          throw new DomainError('ASSISTANCE_CLOSED', '协助已结束或已回答', 409);
        const stage = this.stage(item, env);
        if (stage.pending && data.type !== 'decline')
          throw new DomainError('AWAITING_INPUT', '请等待发起方明确补充输入', 409);
        if (this.responses(id).length >= 200)
          throw new DomainError('ASSISTANCE_LIMIT', '协助回应已达上限', 422);
        const author: C.AgentAssistanceActor = actor
          ? {
              kind: 'agent',
              participantId: actor.participantId,
              ownerUserId: actor.ownerUserId,
              connectionId: actor.connectionId,
              connectionRevision: actor.connectionRevision,
            }
          : this.human();
        if (data.type === 'accept') {
          if (stage.accepted) throw new DomainError('ALREADY_ACCEPTED', '当前输入已接受', 409);
          this.accept(item, env, author, false);
        } else {
          if (data.type === 'answer' && !stage.accepted)
            throw new DomainError('ACCEPT_REQUIRED', '请先接受当前输入', 409);
          if (data.type === 'propose_scope') {
            if (
              !data.scope.materialIds.includes(current.materials[0]!.id) ||
              data.scope.materialIds.some((x) => !current.materials.some((m) => m.id === x))
            )
              throw new DomainError(
                'SCOPE_EXPANSION',
                '范围提案须保留固定消息摘录且只能缩减已有项目文本',
                422,
              );
          }
          if (data.type === 'decline') item.state = 'closed';
          if (data.type === 'answer') item.state = 'responded';
          this.append(
            item,
            env,
            data.type,
            data.body,
            data.type === 'propose_scope' ? data.scope : null,
            author,
          );
          if (data.type === 'answer' || data.type === 'decline')
            this.store.db
              .prepare('DELETE FROM assistance_agent_capacity WHERE assistance_id=?')
              .run(id);
        }
        return { id };
      },
      actor,
    );
    return this.get(id, actor);
  }
  revise(id: string, input: unknown, key: string, actor?: AgentRequesterPrincipal) {
    const data = C.parseAgentAssistanceReviseInput(input);
    this.write(
      `revise:${id}`,
      key,
      data,
      () => {
        const context = this.access(id, 'manage', actor);
        if (actor) {
          assertAgentRequesterSelection(
            actor,
            context.task.id,
            context.env.requester_participant_id,
            this.target(context.env),
            data.input,
          );
          const current = this.inputRaw(id, context.env.input_revision);
          if (
            data.input.projectTexts.items.some(
              (ref) =>
                !current.selection.projectTexts.items.some(
                  (previous) => canonicalJson(ref) === canonicalJson(previous),
                ),
            )
          )
            throw new DomainError(
              'AGENT_SCOPE_REQUIRED',
              '补充输入只能缩小本请求已有项目材料',
              403,
            );
        }
      },
      () => {
        const { item, env, task } = this.access(id, 'manage', actor);
        assertRevision(item.revision, data.expectedRevision);
        assertRevision(env.input_revision, data.expectedInputRevision);
        assertRevision(env.access_revision, data.expectedAccessRevision);
        assertRevision(task.revision, data.expectedTaskRevision);
        if (item.state !== 'open')
          throw new DomainError('ASSISTANCE_CLOSED', '只能补充尚未回答的协助', 409);
        const stage = this.stage(item, env);
        if ((stage.pending?.id ?? null) !== data.causeResponseId)
          throw new DomainError('NEGOTIATION_CONFLICT', '请明确回应当前待补充请求', 409);
        const selected = this.selected(
          task,
          data.input,
          true,
          this.requesterMaterialIds(data.input, actor),
        );
        if (selected.inputHash !== data.expectedInputHash)
          throw new DomainError('INPUT_STALE', '请确认新输入预览', 409);
        env.input_revision++;
        env.access_revision++;
        this.store.db
          .prepare(
            'UPDATE assistance_agent_requests SET input_revision=?,access_revision=? WHERE assistance_id=?',
          )
          .run(env.input_revision, env.access_revision, id);
        this.store.db
          .prepare(
            "UPDATE assistance_input_grants SET revoked_at=? WHERE assistance_id=? AND scope='respond' AND revoked_at IS NULL",
          )
          .run(now(), id);
        this.store.db
          .prepare('DELETE FROM assistance_agent_capacity WHERE assistance_id=?')
          .run(id);
        const auth = this.authority(
          task,
          this.target(env),
          item.requester.id,
          env.requester_participant_id,
        );
        this.addInput(
          item,
          env,
          {
            revision: env.input_revision,
            inputHash: selected.inputHash,
            selection: selected.selection,
            materials: selected.materials,
            createdAt: now(),
            causeResponseId: data.causeResponseId,
            actor: this.author(actor),
          },
          auth.grant.expiresAt,
        );
        item.revision++;
        item.updatedAt = now();
        this.save(item, 'input_revised', actor?.participantId ?? this.store.actorId);
        if (auth.grant.autoAccept)
          this.accept(
            item,
            env,
            {
              kind: 'policy',
              ownerUserId: auth.agent.ownerUserId,
              grantRevision: auth.grant.revision,
            },
            true,
          );
        return { id };
      },
      actor,
    );
    return this.get(id, actor);
  }
  change(id: string, input: unknown, key: string, actor?: AgentRequesterPrincipal) {
    const data = parseAssistanceStateChange(input);
    if (actor && data.action !== 'cancel')
      throw new DomainError('AGENT_SCOPE_REQUIRED', '发起凭据仅可取消请求', 403);
    this.write(
      `state:${id}`,
      key,
      data,
      () => {
        this.access(id, 'manage', actor);
      },
      () => {
        const { item } = this.access(id, 'manage', actor);
        assertRevision(item.revision, data.expectedRevision);
        if (item.state === 'cancelled' || (item.state === 'closed' && data.action === 'close'))
          throw new DomainError('ASSISTANCE_CLOSED', '协助已结束', 409);
        if (data.action === 'cancel') {
          this.store.db
            .prepare(
              "UPDATE assistance_agent_requests SET body=json_set(body,'$.terminalReason','cancelled','$.actorId',?,'$.actor',json(?)),revoked_at=? WHERE assistance_id=? AND revoked_at IS NULL",
            )
            .run(
              actor?.participantId ?? this.store.actorId,
              JSON.stringify(this.author(actor)),
              now(),
              id,
            );
        } else {
          item.state = 'closed';
          item.revision++;
          item.updatedAt = now();
          this.store.db
            .prepare('DELETE FROM assistance_agent_capacity WHERE assistance_id=?')
            .run(id);
          this.save(item, 'closed', actor?.participantId ?? this.store.actorId);
        }
        return { id };
      },
      actor,
    );
    return this.get(id, actor);
  }
  private credential(id: string) {
    const row = this.store.db
      .prepare(
        'SELECT id,revision,scopes,expires_at,revoked_at FROM assistance_agent_credentials WHERE assistance_id=?',
      )
      .get(id) as
      | {
          id: string;
          revision: number;
          scopes: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          revision: row.revision,
          scopes: JSON.parse(row.scopes) as C.AgentAssistanceCredentialScope[],
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        }
      : null;
  }
  issueCredential(id: string, input: unknown, key: string) {
    const data = C.parseAgentAssistanceCredentialIssue(input);
    let token: string | null = null;
    this.write(
      `credential:${id}`,
      key,
      data,
      () => {
        this.access(id, 'credential');
      },
      () => {
        const { item, env } = this.access(id, 'credential');
        if (item.state === 'cancelled') throw missing();
        const previous = this.credential(id);
        assertRevision(previous?.revision ?? 0, data.expectedRevision);
        const expiry = Date.parse(data.expiresAt) - Date.now();
        const auth = this.authority(
          this.task(item),
          this.target(env),
          item.requester.id,
          env.requester_participant_id,
        );
        if (expiry <= 0 || expiry > 24 * 3600_000 || data.expiresAt > auth.grant.expiresAt)
          throw new DomainError('INVALID_INPUT', '凭据需在24小时及预授权到期前有效');
        if (!data.scopes.includes('material_read'))
          throw new DomainError('INVALID_INPUT', '回应凭据必须有材料读取scope');
        token = `hexu_request_${randomBytes(32).toString('base64url')}`;
        const credential = {
          id: previous?.id ?? randomUUID(),
          revision: (previous?.revision ?? 0) + 1,
          scopes: data.scopes,
          expiresAt: data.expiresAt,
          revokedAt: null,
        };
        this.store.db
          .prepare(
            'INSERT INTO assistance_agent_credentials VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(assistance_id) DO UPDATE SET revision=excluded.revision,token_hash=excluded.token_hash,scopes=excluded.scopes,expires_at=excluded.expires_at,revoked_at=NULL,body=excluded.body',
          )
          .run(
            credential.id,
            id,
            env.recipient_participant_id,
            credential.revision,
            createHash('sha256').update(token).digest('hex'),
            JSON.stringify(data.scopes),
            data.expiresAt,
            null,
            JSON.stringify(credential),
          );
        item.revision++;
        item.updatedAt = now();
        this.save(item, 'credential_issued', this.store.actorId);
        return { id };
      },
    );
    return { credential: this.credential(id), token };
  }
  revokeCredential(id: string, input: unknown, key: string) {
    const data = C.parseAgentAssistanceCredentialManagement(input);
    if (data.action !== 'revoke') throw new DomainError('INVALID_INPUT', '此入口只撤销凭据');
    this.write(
      `credential.revoke:${id}`,
      key,
      data,
      () => {
        this.access(id, 'credential');
      },
      () => {
        const { item } = this.access(id, 'credential');
        const credential = this.credential(id);
        if (!credential) throw missing();
        assertRevision(credential.revision, data.expectedRevision);
        this.store.db
          .prepare(
            'UPDATE assistance_agent_credentials SET revoked_at=?,revision=revision+1 WHERE assistance_id=?',
          )
          .run(now(), id);
        item.revision++;
        item.updatedAt = now();
        this.save(item, 'credential_revoked', this.store.actorId);
        return { id };
      },
    );
    return { credential: this.credential(id) };
  }
}
