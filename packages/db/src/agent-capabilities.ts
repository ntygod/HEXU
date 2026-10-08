import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseAgentConnection,
  type AgentConnection,
  type AgentConnectionIssue,
  parseAgentRegistration,
  parseAgentUpdate,
  parseAgentRevision,
  parseAgentEndpoint,
  parseAgentCapability,
  parseDelegationGrant,
  parseCapabilitySelection,
  type AgentParticipant,
  type AgentParticipantView,
  type AgentEndpoint,
  type AgentCapability,
  type DelegationGrant,
  type AgentCapabilityListing,
  type AgentCapabilitySelection,
} from '../../contracts/src/agent-capabilities.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import { assertGrantExpiry, capabilityListing } from '../../domain/src/agent-capabilities.js';
import type { PermissionService } from './permissions.js';

/** Structural port avoids importing unrelated execution runtimes; production uses Store. */
export interface AgentResourcesContext {
  db: DatabaseSync;
  teamMode: boolean;
  readonly actorId: string;
  readonly spaceId: string;
  permissions: PermissionService;
}
type BodyRow = { body: string };
const decode = <T>(row: unknown): T | null =>
  row ? (JSON.parse((row as BodyRow).body) as T) : null;
const timestamp = () => new Date().toISOString();
export class AgentCapabilitiesStore {
  constructor(readonly store: AgentResourcesContext) {}
  private current() {
    if (!this.store.teamMode)
      throw new DomainError(
        'REAL_IDENTITY_REQUIRED',
        '请在真实账号模式登记 Agent；演示成员不能成为所有者',
        422,
      );
    this.store.permissions.space();
  }
  private participant(id: string): AgentParticipant {
    const row = this.store.db
      .prepare('SELECT body,revision,revoked_at FROM agent_participants WHERE id=? AND space_id=?')
      .get(id, this.store.spaceId) as
      | { body: string; revision: number; revoked_at: string | null }
      | undefined;
    if (!row) throw new DomainError('NOT_FOUND', 'Agent 不存在或不可访问', 404);
    return {
      ...JSON.parse(row.body),
      revision: row.revision,
      revokedAt: row.revoked_at,
    };
  }
  private own(id: string, allowRevoked = false) {
    this.current();
    const agent = this.participant(id);
    if (agent.ownerUserId !== this.store.actorId)
      throw new DomainError('NOT_FOUND', 'Agent 不存在或不可访问', 404);
    if (agent.revokedAt && !allowRevoked)
      throw new DomainError('AGENT_REVOKED', 'Agent 已撤销，旧授权不能恢复', 409);
    return agent;
  }
  private endpoint(id: string) {
    return decode<AgentEndpoint>(
      this.store.db.prepare('SELECT body FROM agent_endpoints WHERE participant_id=?').get(id),
    );
  }
  private capability(id: string) {
    return decode<AgentCapability>(
      this.store.db.prepare('SELECT body FROM agent_capabilities WHERE participant_id=?').get(id),
    );
  }
  private grants(id: string) {
    return (
      this.store.db
        .prepare(
          'SELECT body,revision,revoked_at FROM agent_delegation_grants WHERE participant_id=? ORDER BY id',
        )
        .all(id) as {
        body: string;
        revision: number;
        revoked_at: string | null;
      }[]
    ).map(
      (row) =>
        ({
          ...JSON.parse(row.body),
          revision: row.revision,
          revokedAt: row.revoked_at,
        }) as DelegationGrant,
    );
  }
  private connection(id: string): AgentConnection | null {
    const row = this.store.db
      .prepare('SELECT body,revision,revoked_at FROM agent_connections WHERE participant_id=?')
      .get(id) as { body: string; revision: number; revoked_at: string | null } | undefined;
    return row
      ? { ...JSON.parse(row.body), revision: row.revision, revokedAt: row.revoked_at }
      : null;
  }
  issueConnection(id: string, input: unknown, key: string): AgentConnectionIssue {
    const data = parseAgentConnection(input);
    let token: string | null = null;
    const check = () => {
      this.own(id);
      this.project(data.projectId, true);
    };
    const agent = this.write(`connection:${id}`, key, data, check, () => {
      const delta = Date.parse(data.expiresAt) - Date.now();
      if (delta <= 0 || delta > 24 * 3600_000)
        throw new DomainError('INVALID_INPUT', '独立连接凭据需在未来 24 小时内到期');
      const endpoint = this.endpoint(id);
      if (!endpoint) throw new DomainError('ENDPOINT_REQUIRED', '请先登记端点元数据', 422);
      const previous = this.connection(id);
      assertRevision(previous?.revision ?? 0, data.expectedRevision);
      token = `hexu_agent_${randomBytes(32).toString('base64url')}`;
      const at = timestamp();
      const connection: AgentConnection = {
        id: previous?.id ?? randomUUID(),
        participantId: id,
        projectId: data.projectId,
        revision: data.expectedRevision + 1,
        scope: 'capability_read',
        expiresAt: data.expiresAt,
        revokedAt: null,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      };
      this.store.db
        .prepare(
          'INSERT INTO agent_connections VALUES(?,?,?,?,?,?,?,NULL,?) ON CONFLICT(participant_id) DO UPDATE SET project_id=excluded.project_id,revision=excluded.revision,endpoint_revision=excluded.endpoint_revision,token_hash=excluded.token_hash,expires_at=excluded.expires_at,revoked_at=NULL,body=excluded.body',
        )
        .run(
          id,
          connection.id,
          connection.projectId,
          connection.revision,
          endpoint.revision,
          createHash('sha256').update(token).digest('hex'),
          connection.expiresAt,
          JSON.stringify(connection),
        );
      this.changed(connection.projectId);
      return { participantId: id };
    });
    // A lost response never remints/reveals a secret through the old request key.
    return { agent, token };
  }
  revokeConnection(id: string, input: unknown, key: string) {
    const data = parseAgentRevision(input);
    return this.write(
      `connection.revoke:${id}`,
      key,
      data,
      () => {
        this.own(id);
      },
      () => {
        const connection = this.connection(id);
        if (!connection) throw new DomainError('NOT_FOUND', '连接不存在', 404);
        assertRevision(connection.revision, data.expectedRevision);
        if (!connection.revokedAt)
          this.store.db
            .prepare(
              'UPDATE agent_connections SET revoked_at=?,revision=revision+1 WHERE participant_id=?',
            )
            .run(timestamp(), id);
        return { participantId: id };
      },
    );
  }
  view(id: string): AgentParticipantView {
    const agent = this.own(id, true);
    return {
      ...agent,
      connection: this.connection(id),
      endpoint: this.endpoint(id),
      capability: this.capability(id),
      grants: this.grants(id),
    };
  }
  list(): AgentParticipantView[] {
    if (!this.store.teamMode) return [];
    this.current();
    return (
      this.store.db
        .prepare(
          'SELECT id FROM agent_participants WHERE space_id=? AND owner_user_id=? ORDER BY id',
        )
        .all(this.store.spaceId, this.store.actorId) as { id: string }[]
    ).map((row) => this.view(row.id));
  }
  private changed(projectId: string | null = null) {
    this.store.db
      .prepare('INSERT INTO outbox(kind,created_at,space_id,project_id) VALUES(?,?,?,?)')
      .run('agent.resources_changed', timestamp(), this.store.spaceId, projectId);
  }
  /** Receipt contains identifiers only; current authority is checked before lookup and replay. */
  private write(
    scope: string,
    key: string,
    payload: unknown,
    check: () => void,
    action: () => { participantId: string; grantId?: string },
    allowRevoked = false,
  ) {
    if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key))
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '操作需要有效的 Idempotency-Key');
    this.current();
    check();
    const fullScope = `${this.store.actorId}:${this.store.spaceId}:agent.${scope}`;
    const fingerprint = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.current();
      check();
      const previous = db
        .prepare('SELECT fingerprint,result FROM idempotency_records WHERE scope=? AND key=?')
        .get(fullScope, key) as { fingerprint: string; result: string } | undefined;
      let receipt: { participantId: string; grantId?: string };
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容', 409);
        receipt = JSON.parse(previous.result);
        this.own(receipt.participantId, allowRevoked);
        if (receipt.grantId && !allowRevoked) {
          const grant = this.grants(receipt.participantId).find((g) => g.id === receipt.grantId);
          if (!grant || grant.revokedAt || grant.expiresAt <= timestamp())
            throw new DomainError('AUTHORIZATION_EXPIRED', '原预授权已撤销或到期', 409);
        }
      } else {
        receipt = action();
        db.prepare('INSERT INTO idempotency_records VALUES(?,?,?,?)').run(
          fullScope,
          key,
          fingerprint,
          JSON.stringify(receipt),
        );
      }
      const result = this.view(receipt.participantId);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  register(input: unknown, key: string) {
    const data = parseAgentRegistration(input);
    return this.write(
      'register',
      key,
      data,
      () => this.current(),
      () => {
        const at = timestamp(),
          id = randomUUID();
        const agent: AgentParticipant = {
          ...data,
          id,
          spaceId: this.store.spaceId,
          ownerUserId: this.store.actorId,
          revision: 1,
          revokedAt: null,
          createdAt: at,
          updatedAt: at,
        };
        this.store.db
          .prepare('INSERT INTO agent_participants VALUES(?,?,?,?,NULL,?)')
          .run(id, agent.spaceId, agent.ownerUserId, 1, JSON.stringify(agent));
        this.changed();
        return { participantId: id };
      },
    );
  }
  update(id: string, input: unknown, key: string) {
    const data = parseAgentUpdate(input);
    return this.write(
      `update:${id}`,
      key,
      data,
      () => {
        this.own(id);
      },
      () => {
        const old = this.own(id);
        assertRevision(old.revision, data.expectedRevision);
        const next = {
          ...old,
          name: data.name,
          nativeInstanceRef: data.nativeInstanceRef,
          revision: old.revision + 1,
          updatedAt: timestamp(),
        };
        this.store.db
          .prepare('UPDATE agent_participants SET revision=?,body=? WHERE id=?')
          .run(next.revision, JSON.stringify(next), id);
        if (old.nativeInstanceRef !== data.nativeInstanceRef) {
          this.invalidateGrants(id);
          this.store.db
            .prepare(
              'UPDATE agent_connections SET revoked_at=?,revision=revision+1 WHERE participant_id=? AND revoked_at IS NULL',
            )
            .run(timestamp(), id);
        }
        this.changed();
        return { participantId: id };
      },
    );
  }
  revoke(id: string, input: unknown, key: string) {
    const data = parseAgentRevision(input);
    return this.write(
      `revoke:${id}`,
      key,
      data,
      () => {
        this.own(id, true);
      },
      () => {
        const old = this.own(id, true);
        assertRevision(old.revision, data.expectedRevision);
        if (!old.revokedAt)
          this.store.db
            .prepare('UPDATE agent_participants SET revoked_at=?,revision=revision+1 WHERE id=?')
            .run(timestamp(), id);
        return { participantId: id };
      },
      true,
    );
  }
  private invalidateGrants(id: string) {
    this.store.db
      .prepare(
        'UPDATE agent_delegation_grants SET revoked_at=?,revision=revision+1 WHERE participant_id=? AND revoked_at IS NULL',
      )
      .run(timestamp(), id);
  }
  setEndpoint(id: string, input: unknown, key: string) {
    const data = parseAgentEndpoint(input);
    return this.write(
      `endpoint:${id}`,
      key,
      data,
      () => {
        this.own(id);
      },
      () => {
        const previous = this.endpoint(id);
        assertRevision(previous?.revision ?? 0, data.expectedRevision);
        const { expectedRevision, ...metadata } = data;
        const endpoint: AgentEndpoint = {
          ...metadata,
          id: previous?.id ?? randomUUID(),
          participantId: id,
          revision: expectedRevision + 1,
          authentication: 'not_integrated',
          lastVerifiedAt: null,
        };
        this.store.db
          .prepare(
            'INSERT INTO agent_endpoints VALUES(?,?,?,?) ON CONFLICT(participant_id) DO UPDATE SET revision=excluded.revision,body=excluded.body',
          )
          .run(id, endpoint.id, endpoint.revision, JSON.stringify(endpoint));
        this.invalidateGrants(id);
        this.changed();
        return { participantId: id };
      },
    );
  }
  setCapability(id: string, input: unknown, key: string) {
    const data = parseAgentCapability(input);
    return this.write(
      `capability:${id}`,
      key,
      data,
      () => {
        this.own(id);
      },
      () => {
        const endpoint = this.endpoint(id);
        if (!endpoint) throw new DomainError('ENDPOINT_REQUIRED', '请先登记独立端点元数据', 422);
        const previous = this.capability(id);
        assertRevision(previous?.version ?? 0, data.expectedRevision);
        const capability: AgentCapability = {
          id: previous?.id ?? randomUUID(),
          participantId: id,
          endpointId: endpoint.id,
          version: data.expectedRevision + 1,
          title: data.title,
          description: data.description,
          kind: 'text_expertise',
          input: 'text',
          output: 'text',
          providerSupport: 'unverified',
          hexuIntegration: 'not_integrated',
        };
        this.store.db
          .prepare(
            'INSERT INTO agent_capabilities VALUES(?,?,?,?) ON CONFLICT(participant_id) DO UPDATE SET version=excluded.version,body=excluded.body',
          )
          .run(id, capability.id, capability.version, JSON.stringify(capability));
        this.store.db
          .prepare('INSERT INTO agent_capability_versions VALUES(?,?,?)')
          .run(capability.id, capability.version, JSON.stringify(capability));
        this.invalidateGrants(id);
        this.changed();
        return { participantId: id };
      },
    );
  }
  private project(id: string, edit = false) {
    this.current();
    this.store.permissions.project(id, edit ? 'edit' : 'view');
    const project = decode<{ archivedAt?: string | null }>(
      this.store.db
        .prepare('SELECT body FROM projects WHERE id=? AND space_id=?')
        .get(id, this.store.spaceId),
    );
    if (!project) throw new DomainError('NOT_FOUND', '项目不存在或不可访问', 404);
    if (project.archivedAt)
      throw new DomainError('PROJECT_ARCHIVED', '已归档项目不能开放或选择协作能力', 409);
  }
  private member(projectId: string, userId: string, edit = false) {
    const row = this.store.db
      .prepare(
        'SELECT pm.role FROM collab_project_members pm JOIN collab_memberships sm ON sm.user_id=pm.user_id WHERE pm.project_id=? AND pm.user_id=? AND sm.space_id=?',
      )
      .get(projectId, userId, this.store.spaceId) as { role: string } | undefined;
    return !!row && (!edit || row.role !== 'view');
  }
  grant(id: string, input: unknown, key: string) {
    const data = parseDelegationGrant(input);
    const check = () => {
      this.own(id);
      this.project(data.projectId, true);
      for (const user of data.requesterUserIds)
        if (!this.member(data.projectId, user, data.request))
          throw new DomainError('NOT_FOUND', '指定参与者不具备当前项目权限', 404);
    };
    return this.write(`grant:${id}`, key, data, check, () => {
      assertGrantExpiry(data.expiresAt, Date.now());
      const capability = this.capability(id),
        endpoint = this.endpoint(id);
      if (!capability || !endpoint)
        throw new DomainError('CAPABILITY_UNAVAILABLE', '请先登记端点和文本专业能力', 422);
      assertRevision(capability.version, data.expectedCapabilityVersion);
      assertRevision(endpoint.revision, data.expectedEndpointRevision);
      const { expectedCapabilityVersion, expectedEndpointRevision, ...policy } = data;
      const grant: DelegationGrant = {
        ...policy,
        id: randomUUID(),
        participantId: id,
        capabilityId: capability.id,
        capabilityVersion: expectedCapabilityVersion,
        endpointRevision: expectedEndpointRevision,
        revision: 1,
        discover: true,
        materialScope: 'explicit_text_snapshot',
        outputScope: 'text_answer',
        execution: false,
        externalEffects: false,
        costBearerUserId: this.store.actorId,
        revokedAt: null,
        createdAt: timestamp(),
      };
      this.store.db
        .prepare('INSERT INTO agent_delegation_grants VALUES(?,?,?,?,NULL,?)')
        .run(grant.id, id, grant.projectId, 1, JSON.stringify(grant));
      this.changed(grant.projectId);
      return { participantId: id, grantId: grant.id };
    });
  }
  revokeGrant(id: string, grantId: string, input: unknown, key: string) {
    const data = parseAgentRevision(input);
    const check = () => {
      this.own(id);
      const grant = this.grants(id).find((g) => g.id === grantId);
      if (!grant) throw new DomainError('NOT_FOUND', '预授权不存在', 404);
      this.store.permissions.project(grant.projectId, 'edit');
    };
    return this.write(
      `grant.revoke:${id}:${grantId}`,
      key,
      data,
      check,
      () => {
        const grant = this.grants(id).find((g) => g.id === grantId)!;
        assertRevision(grant.revision, data.expectedRevision);
        if (!grant.revokedAt)
          this.store.db
            .prepare(
              'UPDATE agent_delegation_grants SET revoked_at=?,revision=revision+1 WHERE id=?',
            )
            .run(timestamp(), grantId);
        return { participantId: id, grantId };
      },
      true,
    );
  }
  discover(projectId: string): AgentCapabilityListing[] {
    this.project(projectId);
    const rows = this.store.db
      .prepare(
        'SELECT DISTINCT participant_id AS id FROM agent_delegation_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY participant_id',
      )
      .all(projectId) as { id: string }[];
    const items: AgentCapabilityListing[] = [];
    for (const row of rows) {
      const agent = this.participant(row.id),
        capability = this.capability(row.id),
        endpoint = this.endpoint(row.id);
      if (
        agent.revokedAt ||
        !capability ||
        !endpoint ||
        !this.member(projectId, agent.ownerUserId, true)
      )
        continue;
      const grants = this.grants(row.id).filter(
        (g) =>
          g.projectId === projectId &&
          !g.revokedAt &&
          g.expiresAt > timestamp() &&
          g.capabilityVersion === capability.version &&
          g.endpointRevision === endpoint.revision &&
          (g.audience === 'project_members' || g.requesterUserIds.includes(this.store.actorId)),
      );
      // Stable choice: requesting authority first, then auto-accept, then opaque ID.
      grants.sort(
        (a, b) =>
          Number(b.request) - Number(a.request) ||
          Number(b.autoAccept) - Number(a.autoAccept) ||
          a.id.localeCompare(b.id),
      );
      if (grants[0]) {
        const item = capabilityListing(agent, capability, grants[0]);
        if (!this.member(projectId, this.store.actorId, true)) {
          item.canRequest = false;
          item.autoAccept = false;
          item.authorizationEnvironment = 'request_not_granted';
          item.blocker = '当前项目权限仅可发现，不能请求协助';
        }
        items.push(item);
      }
    }
    return items.sort(
      (a, b) =>
        a.participantId.localeCompare(b.participantId) ||
        a.capabilityId.localeCompare(b.capabilityId),
    );
  }
  select(projectId: string, capabilityId: string, input: unknown): AgentCapabilitySelection {
    const data = parseCapabilitySelection(input);
    const item = this.discover(projectId).find((c) => c.capabilityId === capabilityId);
    if (!item) throw new DomainError('NOT_FOUND', '能力不存在或当前不可发现', 404);
    assertRevision(item.capabilityVersion, data.expectedVersion);
    return {
      projectId,
      participantId: item.participantId,
      capabilityId: item.capabilityId,
      capabilityVersion: item.capabilityVersion,
      grantId: item.grantId,
      grantRevision: item.grantRevision,
      callable: false,
      blocker: item.blocker,
    };
  }
  /** Next slices must call this guard before attempting dispatch; no execution exists here. */
  requireCallable(projectId: string, capabilityId: string, input: unknown): never {
    const selection = this.select(projectId, capabilityId, input);
    throw new DomainError('CAPABILITY_UNAVAILABLE', selection.blocker, 422);
  }
}
