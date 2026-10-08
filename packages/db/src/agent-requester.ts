import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import * as C from '../../contracts/src/agent-requester.js';
import type { AgentAssistanceInputSelection } from '../../contracts/src/agent-assistance.js';
import { canonicalJson, assertRevision } from '../../domain/src/index.js';
import {
  revalidateAgentRequesterConnection,
  type AgentRequesterPrincipal,
} from '../../identity/src/agent-requester-connections.js';
import type { Store } from './store.js';
const now = () => new Date().toISOString();
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const missing = () => new DomainError('NOT_FOUND', '发起授权或请求不存在或已失效', 404);
interface CredentialRow {
  id: string;
  participant_id: string;
  task_id: string;
  project_id: string;
  revision: number;
  expires_at: string;
  revoked_at: string | null;
  body: string;
}
/** Bounded transport facade over the original Assistance domain, with no alternate task store. */
export class AgentRequesterStore {
  constructor(private readonly store: Store) {}
  private owner(taskId: string, participantId?: string) {
    if (!this.store.teamMode) throw new DomainError('TEAM_MODE_REQUIRED', '需要真实账号', 422);
    const task = this.store.getTask(taskId, true);
    if (task.visibility !== 'project' || !task.projectId) throw missing();
    if (
      participantId &&
      !this.store.db
        .prepare('SELECT 1 FROM agent_participants WHERE id=? AND owner_user_id=? AND space_id=?')
        .get(participantId, this.store.actorId, this.store.spaceId)
    )
      throw missing();
    return task;
  }
  private metadata(row: CredentialRow): C.AgentRequesterCredential {
    const b = JSON.parse(row.body);
    return {
      id: row.id,
      revision: row.revision,
      participantId: row.participant_id,
      taskId: row.task_id,
      target: b.target,
      inputHash: b.inputHash,
      materialLabels: b.materials.map((m: { label: string }) => m.label),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: b.createdAt,
    };
  }
  private row(taskId: string, id: string) {
    const row = this.store.db
      .prepare(
        'SELECT c.* FROM agent_requester_credentials c JOIN agent_participants a ON a.id=c.participant_id WHERE c.id=? AND c.task_id=? AND a.owner_user_id=? AND a.space_id=?',
      )
      .get(id, taskId, this.store.actorId, this.store.spaceId) as CredentialRow | undefined;
    if (!row) throw missing();
    return row;
  }
  private operation(
    scope: string,
    key: string,
    payload: unknown,
    guard: () => void,
    action: () => string,
  ) {
    if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key))
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '操作需要有效的 Idempotency-Key');
    guard();
    const full = `${this.store.spaceId}:human:${this.store.actorId}:agent.requester:${scope}`,
      fingerprint = hash(payload);
    return this.store.atomic(() => {
      guard();
      const old = this.store.db
        .prepare('SELECT fingerprint,result FROM idempotency_records WHERE scope=? AND key=?')
        .get(full, key) as { fingerprint: string; result: string } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容', 409);
        return JSON.parse(old.result).id as string;
      }
      const id = action();
      this.store.db
        .prepare('INSERT INTO idempotency_records VALUES(?,?,?,?)')
        .run(full, key, fingerprint, JSON.stringify({ id }));
      return id;
    });
  }
  listCredentials(taskId: string) {
    this.owner(taskId);
    return {
      items: (
        this.store.db
          .prepare(
            'SELECT c.* FROM agent_requester_credentials c JOIN agent_participants a ON a.id=c.participant_id WHERE c.task_id=? AND a.owner_user_id=? AND a.space_id=? ORDER BY c.rowid DESC',
          )
          .all(taskId, this.store.actorId, this.store.spaceId) as unknown as CredentialRow[]
      ).map((row) => this.metadata(row)),
    };
  }
  issue(taskId: string, input: unknown, key: string): C.AgentRequesterCredentialIssued {
    const data = C.parseAgentRequesterCredentialIssue(input);
    let token: string | null = null;
    const guard = () => {
      this.owner(taskId, data.participantId);
      this.store.agentAssistance.preview(taskId, data.preview);
    };
    const id = this.operation(`issue:${taskId}`, key, data, guard, () => {
      const task = this.owner(taskId, data.participantId),
        preview = this.store.agentAssistance.preview(taskId, data.preview);
      assertRevision(task.revision, data.expectedTaskRevision);
      if (preview.inputHash !== data.expectedInputHash)
        throw new DomainError('INPUT_STALE', '请确认当前材料预览', 409);
      const grant = this.store.db
        .prepare('SELECT body FROM agent_delegation_grants WHERE id=?')
        .get(data.preview.target.grantId) as { body: string };
      const duration = Date.parse(data.expiresAt) - Date.now();
      if (
        duration <= 0 ||
        duration > 24 * 3600_000 ||
        data.expiresAt > JSON.parse(grant.body).expiresAt
      )
        throw new DomainError('INVALID_INPUT', '授权需在24小时及目标预授权到期前有效');
      const endpoint = this.store.db
        .prepare('SELECT revision FROM agent_endpoints WHERE participant_id=?')
        .get(data.participantId) as { revision: number } | undefined;
      if (!endpoint) throw new DomainError('INVALID_PARTICIPANT', '发起身份需有已登记端点', 422);
      token = `hexu_requester_${randomBytes(32).toString('base64url')}`;
      const id = randomUUID();
      this.store.db
        .prepare('INSERT INTO agent_requester_credentials VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          data.participantId,
          taskId,
          task.projectId!,
          1,
          endpoint.revision,
          createHash('sha256').update(token).digest('hex'),
          data.expiresAt,
          null,
          JSON.stringify({
            target: preview.target,
            input: preview.input,
            materials: preview.materials,
            inputHash: preview.inputHash,
            createdAt: now(),
          }),
        );
      return id;
    });
    const row = this.row(taskId, id);
    if (row.revoked_at || row.expires_at <= now()) throw missing();
    return { credential: this.metadata(row), token };
  }
  revoke(taskId: string, id: string, input: unknown, key: string) {
    const data = C.parseAgentRequesterCancel(input);
    const guard = () => {
      this.owner(taskId);
      this.row(taskId, id);
    };
    this.operation(`revoke:${id}`, key, data, guard, () => {
      const row = this.row(taskId, id);
      assertRevision(row.revision, data.expectedRevision);
      if (!row.revoked_at)
        this.store.db
          .prepare(
            'UPDATE agent_requester_credentials SET revoked_at=?,revision=revision+1 WHERE id=?',
          )
          .run(now(), id);
      return id;
    });
    return { credential: this.metadata(this.row(taskId, id)) };
  }
  private guard(actor: AgentRequesterPrincipal) {
    revalidateAgentRequesterConnection(this.store.db, actor);
    this.store.agentAssistance.validateRequester(actor);
  }
  private selection(
    actor: AgentRequesterPrincipal,
    data: C.AgentRequesterInput,
  ): AgentAssistanceInputSelection {
    this.guard(actor);
    if (data.materialIds.some((id) => !actor.bound.materials.some((m) => m.id === id)))
      throw new DomainError('AGENT_SCOPE_REQUIRED', '不得添加预授权之外的材料', 403);
    return {
      ...actor.bound.input,
      question: data.question,
      clarification: data.clarification,
      projectTexts: {
        items: actor.bound.input.projectTexts.items.filter((_, i) =>
          data.materialIds.includes(actor.bound.materials[i + 1]!.id),
        ),
        expectedHash: actor.bound.input.projectTexts.expectedHash,
      },
    };
  }
  private fullPreview(actor: AgentRequesterPrincipal, data: C.AgentRequesterInput) {
    return this.store.agentAssistance.preview(
      actor.taskId,
      {
        target: actor.bound.target,
        requesterParticipantId: actor.participantId,
        input: this.selection(actor, data),
      },
      actor,
    );
  }
  preview(actor: AgentRequesterPrincipal, input: unknown) {
    const p = this.fullPreview(actor, C.parseAgentRequesterInput(input));
    return {
      expectedTaskRevision: p.expectedTaskRevision,
      inputHash: p.inputHash,
      question: p.question,
      clarification: p.clarification,
      materials: p.materials,
    };
  }
  materials(actor: AgentRequesterPrincipal) {
    this.guard(actor);
    return {
      materials: actor.bound.materials,
      question: actor.bound.input.question,
      clarification: actor.bound.input.clarification,
    };
  }
  capabilities(actor: AgentRequesterPrincipal) {
    this.guard(actor);
    const c = this.store.db
      .prepare('SELECT body FROM agent_capabilities WHERE id=?')
      .get(actor.bound.target.capabilityId) as { body: string };
    const cap = JSON.parse(c.body);
    return { items: [{ ...actor.bound.target, label: cap.title, description: cap.description }] };
  }
  create(
    actor: AgentRequesterPrincipal,
    input: unknown,
    key: string,
    onCreated?: (requestId: string) => void,
  ) {
    const data = C.parseAgentRequesterCreate(input),
      p = this.fullPreview(actor, data);
    return this.store.agentAssistance.create(
      actor.taskId,
      {
        target: actor.bound.target,
        requesterParticipantId: actor.participantId,
        input: p.input,
        expectedTaskRevision: data.expectedTaskRevision,
        expectedInputHash: data.expectedInputHash,
        shareConfirmed: true,
      },
      key,
      actor,
      onCreated,
    );
  }
  get(actor: AgentRequesterPrincipal, requestId: string) {
    this.guard(actor);
    const id = this.store.agentAssistance.byRequestId(requestId);
    return this.store.agentAssistance.get(id, actor);
  }
  list(actor: AgentRequesterPrincipal) {
    this.guard(actor);
    const rows = this.store.db
      .prepare(
        'SELECT r.request_id FROM assistance_agent_requests r JOIN assistances a ON a.id=r.assistance_id WHERE a.task_id=? AND r.requester_participant_id=? ORDER BY a.rowid DESC',
      )
      .all(actor.taskId, actor.participantId) as { request_id: string }[];
    return rows.flatMap((row) => {
      try {
        return [this.get(actor, row.request_id)];
      } catch (e) {
        if (e instanceof DomainError && ['NOT_FOUND', 'AGENT_SCOPE_REQUIRED'].includes(e.code))
          return [];
        throw e;
      }
    });
  }
  revise(actor: AgentRequesterPrincipal, requestId: string, input: unknown, key: string) {
    const data = C.parseAgentRequesterReviseInput(input),
      p = this.fullPreview(actor, data);
    this.get(actor, requestId);
    return this.store.agentAssistance.revise(
      this.store.agentAssistance.byRequestId(requestId),
      {
        expectedRevision: data.expectedRevision,
        expectedInputRevision: data.expectedInputRevision,
        expectedAccessRevision: data.expectedAccessRevision,
        expectedTaskRevision: data.expectedTaskRevision,
        causeResponseId: data.causeResponseId,
        input: p.input,
        expectedInputHash: data.expectedInputHash,
        shareConfirmed: true,
      },
      key,
      actor,
    );
  }
  cancel(actor: AgentRequesterPrincipal, requestId: string, input: unknown, key: string) {
    const data = C.parseAgentRequesterCancel(input);
    this.get(actor, requestId);
    return this.store.agentAssistance.change(
      this.store.agentAssistance.byRequestId(requestId),
      { ...data, action: 'cancel' },
      key,
      actor,
    );
  }
  receipt(actor: AgentRequesterPrincipal, key: string) {
    this.guard(actor);
    if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key))
      throw new DomainError('INVALID_INPUT', '操作标识无效');
    const scope = `${actor.spaceId}:agent:${actor.participantId}:${actor.connectionId}:agent.assistance:create:${actor.taskId}`;
    const row = this.store.db
      .prepare('SELECT result FROM idempotency_records WHERE scope=? AND key=?')
      .get(scope, key) as { result: string } | undefined;
    return row ? this.store.agentAssistance.get(JSON.parse(row.result).id, actor) : null;
  }
}
