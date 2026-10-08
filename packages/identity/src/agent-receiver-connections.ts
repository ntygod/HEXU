import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../contracts/src/index.js';
import type { AgentAssistanceTarget } from '../../contracts/src/agent-assistance.js';
import { canonicalJson } from '../../domain/src/index.js';
import type {
  AgentAssistancePrincipal,
  AgentAssistanceScope,
} from './agent-assistance-connections.js';
export interface AgentReceiverPrincipal {
  kind: 'agent';
  role: 'receiver';
  participantId: string;
  connectionId: string;
  connectionRevision: number;
  ownerUserId: string;
  spaceId: string;
  projectId: string;
  target: AgentAssistanceTarget;
  scopes: AgentAssistanceScope[];
  expiresAt: string;
}
const denied = () => new DomainError('AGENT_AUTH_REQUIRED', '接收连接已失效或授权已撤销', 401);
function current(
  db: DatabaseSync,
  column: 'id' | 'token_hash',
  value: string,
): AgentReceiverPrincipal {
  const row = db
    .prepare(
      `SELECT c.*,a.owner_user_id,a.space_id FROM agent_receiver_connections c
    JOIN agent_participants a ON a.id=c.participant_id
    JOIN agent_endpoints e ON e.participant_id=a.id
    JOIN agent_capabilities cap ON cap.participant_id=a.id AND cap.id=c.capability_id
    JOIN agent_delegation_grants g ON g.id=c.grant_id AND g.participant_id=a.id AND g.project_id=c.project_id
    JOIN projects p ON p.id=c.project_id AND p.space_id=a.space_id
    JOIN collab_memberships sm ON sm.space_id=a.space_id AND sm.user_id=a.owner_user_id
    JOIN collab_project_members pm ON pm.project_id=p.id AND pm.user_id=a.owner_user_id
    WHERE c.${column}=? AND c.revoked_at IS NULL AND c.expires_at>?
    AND a.revoked_at IS NULL AND g.revoked_at IS NULL AND g.revision=c.grant_revision
    AND e.revision=c.endpoint_revision AND cap.version=c.capability_version
    AND pm.role IN ('edit','manage') AND json_extract(p.body,'$.archivedAt') IS NULL
    AND json_extract(g.body,'$.request')=1 AND json_extract(g.body,'$.expiresAt')>=c.expires_at
    AND json_extract(g.body,'$.capabilityId')=cap.id AND json_extract(g.body,'$.capabilityVersion')=cap.version
    AND json_extract(g.body,'$.endpointRevision')=e.revision`,
    )
    .get(value, new Date().toISOString()) as any;
  if (!row) throw denied();
  const scopes: AgentAssistanceScope[] = JSON.parse(row.scopes);
  if (
    !Array.isArray(scopes) ||
    !scopes.includes('material_read') ||
    scopes.some((s) => !['material_read', 'respond'].includes(s))
  )
    throw denied();
  return {
    kind: 'agent',
    role: 'receiver',
    participantId: row.participant_id,
    connectionId: row.id,
    connectionRevision: row.revision,
    ownerUserId: row.owner_user_id,
    spaceId: row.space_id,
    projectId: row.project_id,
    target: {
      participantId: row.participant_id,
      capabilityId: row.capability_id,
      capabilityVersion: row.capability_version,
      endpointRevision: row.endpoint_revision,
      grantId: row.grant_id,
      grantRevision: row.grant_revision,
    },
    scopes,
    expiresAt: row.expires_at,
  };
}
export function agentReceiverConnectionById(db: DatabaseSync, id: string) {
  return current(db, 'id', id);
}
export function revalidateAgentReceiverConnection(db: DatabaseSync, actor: AgentReceiverPrincipal) {
  const fresh = agentReceiverConnectionById(db, actor.connectionId);
  if (canonicalJson(fresh) !== canonicalJson(actor)) throw denied();
  return fresh;
}
export function authenticateAgentReceiverConnection(
  db: DatabaseSync,
  headers: Record<string, unknown>,
) {
  if (
    headers.cookie ||
    headers.origin ||
    headers['sec-fetch-site'] ||
    headers['x-hexu-runner'] ||
    headers['x-hexu-space'] ||
    headers['x-hexu-client']
  )
    throw new DomainError('AGENT_CHANNEL_REQUIRED', '接收通道不接受浏览器、节点或身份覆盖', 403);
  if (
    typeof headers.authorization !== 'string' ||
    !/^Bearer hexu_receiver_[A-Za-z0-9_-]{43}$/.test(headers.authorization)
  )
    throw denied();
  return current(
    db,
    'token_hash',
    createHash('sha256').update(headers.authorization.slice(7)).digest('hex'),
  );
}
export function deriveAgentReceiverRequestPrincipal(
  db: DatabaseSync,
  actor: AgentReceiverPrincipal,
  assistanceId: string,
): AgentAssistancePrincipal {
  revalidateAgentReceiverConnection(db, actor);
  const t = actor.target;
  const row = db
    .prepare(
      `SELECT 1 FROM assistance_agent_requests r JOIN assistances h ON h.id=r.assistance_id
    JOIN tasks task ON task.id=h.task_id AND task.space_id=h.space_id
    WHERE r.assistance_id=? AND r.recipient_participant_id=? AND r.capability_id=? AND r.capability_version=?
    AND r.endpoint_revision=? AND r.grant_id=? AND r.grant_revision=? AND r.revoked_at IS NULL
    AND h.space_id=? AND h.state!='cancelled' AND json_extract(task.body,'$.projectId')=?`,
    )
    .get(
      assistanceId,
      actor.participantId,
      t.capabilityId,
      t.capabilityVersion,
      t.endpointRevision,
      t.grantId,
      t.grantRevision,
      actor.spaceId,
      actor.projectId,
    );
  if (!row) throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
  return {
    kind: 'agent',
    participantId: actor.participantId,
    connectionId: actor.connectionId,
    connectionRevision: actor.connectionRevision,
    ownerUserId: actor.ownerUserId,
    spaceId: actor.spaceId,
    assistanceId,
    scopes: actor.scopes,
    expiresAt: actor.expiresAt,
    receiverConnection: true,
  };
}
export function revalidateAgentReceiverRequestPrincipal(
  db: DatabaseSync,
  actor: AgentAssistancePrincipal,
) {
  const fresh = deriveAgentReceiverRequestPrincipal(
    db,
    agentReceiverConnectionById(db, actor.connectionId),
    actor.assistanceId,
  );
  if (canonicalJson(fresh) !== canonicalJson(actor)) throw denied();
  return fresh;
}
export function publicAgentReceiverActor(actor: AgentReceiverPrincipal) {
  return {
    kind: actor.kind,
    role: actor.role,
    participantId: actor.participantId,
    connectionId: actor.connectionId,
    connectionRevision: actor.connectionRevision,
    scopes: actor.scopes,
    expiresAt: actor.expiresAt,
  };
}
export function isAgentReceiverPath(path: string, method: string) {
  return (
    (method === 'GET' &&
      (['/agent-receiver/v1/identity', '/agent-receiver/v1/requests'].includes(path) ||
        /^\/agent-receiver\/v1\/requests\/[^/]+$/.test(path) ||
        /^\/agent-receiver\/v1\/requests\/[^/]+\/input-revisions\/[1-9][0-9]*$/.test(path))) ||
    (method === 'POST' && /^\/agent-receiver\/v1\/requests\/[^/]+\/responses$/.test(path))
  );
}
