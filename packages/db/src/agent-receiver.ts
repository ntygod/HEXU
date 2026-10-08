import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import * as C from '../../contracts/src/agent-receiver.js';
import type { AssistanceDetail } from '../../contracts/src/assistance.js';
import { canonicalJson, assertRevision } from '../../domain/src/index.js';
import {
  agentReceiverConnectionById,
  deriveAgentReceiverRequestPrincipal,
  revalidateAgentReceiverConnection,
  type AgentReceiverPrincipal,
} from '../../identity/src/agent-receiver-connections.js';
import type { Store } from './store.js';
export const AGENT_RECEIVER_MIGRATION = `
CREATE TABLE agent_receiver_connections (
 id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES agent_participants(id),
 project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
 endpoint_revision INTEGER NOT NULL, capability_id TEXT NOT NULL, capability_version INTEGER NOT NULL,
 grant_id TEXT NOT NULL REFERENCES agent_delegation_grants(id), grant_revision INTEGER NOT NULL,
 scopes TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
 revoked_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX agent_receiver_participant ON agent_receiver_connections(participant_id,project_id);
CREATE TRIGGER agent_receiver_member_removed AFTER DELETE ON collab_memberships BEGIN
 UPDATE agent_receiver_connections SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
 WHERE revoked_at IS NULL AND participant_id IN (SELECT id FROM agent_participants WHERE owner_user_id=OLD.user_id AND space_id=OLD.space_id);
END;
CREATE TRIGGER agent_receiver_project_removed AFTER DELETE ON collab_project_members BEGIN
 UPDATE agent_receiver_connections SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
 WHERE revoked_at IS NULL AND project_id=OLD.project_id AND participant_id IN (SELECT id FROM agent_participants WHERE owner_user_id=OLD.user_id);
END;
CREATE TRIGGER agent_receiver_project_downgraded AFTER UPDATE OF role ON collab_project_members WHEN NEW.role NOT IN ('edit','manage') BEGIN
 UPDATE agent_receiver_connections SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
 WHERE revoked_at IS NULL AND project_id=NEW.project_id AND participant_id IN (SELECT id FROM agent_participants WHERE owner_user_id=NEW.user_id);
END;
`;
const now = () => new Date().toISOString();
const missing = () => new DomainError('NOT_FOUND', '接收连接或请求不存在或已失效', 404);
/** Same explicit projection as the request-bound transport, safe for Events and MCP callers. */
export function receiverRequestView(detail: AssistanceDetail) {
  const item = detail.assistance,
    agent = item.agent;
  if (!agent) throw missing();
  return {
    requestId: agent.requestId,
    revision: item.revision,
    state: item.state,
    inputRevision: agent.currentInputRevision,
    inputHash: agent.inputHash,
    accessRevision: agent.accessRevision,
    phase: agent.phase,
    terminalReason: agent.terminalReason,
    question: item.question,
    clarification: agent.clarification,
    materials: agent.materials,
    responses: agent.responses.map((response) => ({
      id: response.id,
      type: response.type,
      body: response.body,
      scope: response.scope,
      inputRevision: response.inputRevision,
      inputHash: response.inputHash,
      accessRevision: response.accessRevision,
      createdAt: response.createdAt,
      actor:
        response.actor.kind === 'agent'
          ? {
              kind: 'agent',
              participantId: response.actor.participantId,
              connectionId: response.actor.connectionId,
              connectionRevision: response.actor.connectionRevision,
            }
          : response.actor.kind === 'policy'
            ? { kind: 'policy', grantRevision: response.actor.grantRevision }
            : { kind: 'human' },
    })),
  };
}
interface Row {
  id: string;
  participant_id: string;
  project_id: string;
  revision: number;
  endpoint_revision: number;
  capability_id: string;
  capability_version: number;
  grant_id: string;
  grant_revision: number;
  scopes: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}
export class AgentReceiverStore {
  constructor(private readonly store: Store) {}
  private owner(participantId: string) {
    if (!this.store.teamMode) throw new DomainError('TEAM_MODE_REQUIRED', '需要真实账号', 422);
    const row = this.store.db
      .prepare(
        `SELECT 1 FROM agent_participants a JOIN collab_memberships m ON m.user_id=a.owner_user_id AND m.space_id=a.space_id WHERE a.id=? AND a.owner_user_id=? AND a.space_id=? AND a.revoked_at IS NULL`,
      )
      .get(participantId, this.store.actorId, this.store.spaceId);
    if (!row) throw missing();
  }
  private row(participantId: string, id: string): Row {
    this.owner(participantId);
    const row = this.store.db
      .prepare('SELECT * FROM agent_receiver_connections WHERE id=? AND participant_id=?')
      .get(id, participantId) as unknown as Row | undefined;
    if (!row) throw missing();
    return row;
  }
  private metadata(r: Row): C.AgentReceiverCredential {
    return {
      id: r.id,
      revision: r.revision,
      participantId: r.participant_id,
      projectId: r.project_id,
      target: {
        participantId: r.participant_id,
        endpointRevision: r.endpoint_revision,
        capabilityId: r.capability_id,
        capabilityVersion: r.capability_version,
        grantId: r.grant_id,
        grantRevision: r.grant_revision,
      },
      scopes: JSON.parse(r.scopes),
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
    };
  }
  listCredentials(participantId: string) {
    this.owner(participantId);
    return {
      items: (
        this.store.db
          .prepare(
            'SELECT * FROM agent_receiver_connections WHERE participant_id=? ORDER BY rowid DESC',
          )
          .all(participantId) as unknown as Row[]
      ).map((r) => this.metadata(r)),
    };
  }
  getCredential(participantId: string, id: string) {
    return { credential: this.metadata(this.row(participantId, id)) };
  }
  private operation(
    participantId: string,
    scope: string,
    key: string,
    payload: unknown,
    guard: () => void,
    action: () => string,
  ) {
    if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key))
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '操作需要有效的 Idempotency-Key');
    const full = `${this.store.spaceId}:human:${this.store.actorId}:agent.receiver:${participantId}:${scope}`,
      fingerprint = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    guard();
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
  issue(participantId: string, input: unknown, key: string) {
    const data = C.parseAgentReceiverIssue(input);
    let token: string | null = null;
    const guard = () => {
      this.owner(participantId);
      const g = this.store.db
        .prepare(
          `SELECT 1 FROM agent_delegation_grants g JOIN agent_participants a ON a.id=g.participant_id JOIN agent_endpoints e ON e.participant_id=a.id JOIN agent_capabilities c ON c.participant_id=a.id JOIN projects p ON p.id=g.project_id JOIN collab_project_members m ON m.project_id=p.id AND m.user_id=a.owner_user_id WHERE g.id=? AND g.participant_id=? AND g.project_id=? AND g.revision=? AND g.revoked_at IS NULL AND c.id=? AND c.version=? AND e.revision=? AND m.role IN ('edit','manage') AND json_extract(p.body,'$.archivedAt') IS NULL AND json_extract(g.body,'$.request')=1 AND json_extract(g.body,'$.expiresAt')>=? AND json_extract(g.body,'$.capabilityId')=c.id AND json_extract(g.body,'$.capabilityVersion')=c.version AND json_extract(g.body,'$.endpointRevision')=e.revision`,
        )
        .get(
          data.grantId,
          participantId,
          data.projectId,
          data.grantRevision,
          data.capabilityId,
          data.capabilityVersion,
          data.endpointRevision,
          data.expiresAt,
        );
      if (!g || data.expiresAt <= now()) throw missing();
    };
    const id = this.operation(participantId, 'issue', key, data, guard, () => {
      if (Date.parse(data.expiresAt) - Date.now() > 24 * 3600_000)
        throw new DomainError('INVALID_INPUT', '接收连接有效期不得超过24小时');
      token = `hexu_receiver_${randomBytes(32).toString('base64url')}`;
      const id = randomUUID();
      this.store.db
        .prepare('INSERT INTO agent_receiver_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          participantId,
          data.projectId,
          1,
          data.endpointRevision,
          data.capabilityId,
          data.capabilityVersion,
          data.grantId,
          data.grantRevision,
          JSON.stringify(data.scopes),
          createHash('sha256').update(token).digest('hex'),
          data.expiresAt,
          null,
          now(),
        );
      agentReceiverConnectionById(this.store.db, id);
      return id;
    });
    agentReceiverConnectionById(this.store.db, id);
    return { credential: this.metadata(this.row(participantId, id)), token };
  }
  revoke(participantId: string, id: string, input: unknown, key: string) {
    const data = C.parseAgentReceiverRevoke(input);
    this.operation(
      participantId,
      `revoke:${id}`,
      key,
      data,
      () => {
        this.row(participantId, id);
      },
      () => {
        const row = this.row(participantId, id);
        assertRevision(row.revision, data.expectedRevision);
        if (!row.revoked_at)
          this.store.db
            .prepare(
              'UPDATE agent_receiver_connections SET revoked_at=?,revision=revision+1 WHERE id=?',
            )
            .run(now(), id);
        return id;
      },
    );
    return this.getCredential(participantId, id);
  }
  get(actor: AgentReceiverPrincipal, requestId: string) {
    const id = this.store.agentAssistance.byRequestId(requestId),
      principal = deriveAgentReceiverRequestPrincipal(this.store.db, actor, id);
    return receiverRequestView(this.store.agentAssistance.get(id, principal));
  }
  list(actor: AgentReceiverPrincipal) {
    revalidateAgentReceiverConnection(this.store.db, actor);
    const rows = this.store.db
      .prepare(
        'SELECT request_id FROM assistance_agent_requests WHERE recipient_participant_id=? AND grant_id=? AND grant_revision=? ORDER BY rowid DESC',
      )
      .all(actor.participantId, actor.target.grantId, actor.target.grantRevision) as {
      request_id: string;
    }[];
    return rows.flatMap((r) => {
      try {
        return [this.get(actor, r.request_id)];
      } catch (e) {
        if (e instanceof DomainError && e.code === 'NOT_FOUND') return [];
        throw e;
      }
    });
  }
  input(actor: AgentReceiverPrincipal, requestId: string, revision: number) {
    const id = this.store.agentAssistance.byRequestId(requestId),
      principal = deriveAgentReceiverRequestPrincipal(this.store.db, actor, id);
    return this.store.agentAssistance.input(id, revision, principal);
  }
  respond(actor: AgentReceiverPrincipal, requestId: string, input: unknown, key: string) {
    const id = this.store.agentAssistance.byRequestId(requestId),
      principal = deriveAgentReceiverRequestPrincipal(this.store.db, actor, id);
    return receiverRequestView(this.store.agentAssistance.respond(id, input, key, principal));
  }
}
