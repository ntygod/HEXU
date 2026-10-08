import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../contracts/src/index.js';
import type {
  AgentAssistanceInputSelection,
  AgentAssistanceTarget,
  AgentAssistanceMaterial,
} from '../../contracts/src/agent-assistance.js';
import { canonicalJson } from '../../domain/src/index.js';

/** Internal, authenticated limited authority. Never serialize the owner or source references. */
export interface AgentRequesterPrincipal {
  kind: 'agent';
  role: 'requester';
  participantId: string;
  connectionId: string;
  connectionRevision: number;
  ownerUserId: string;
  spaceId: string;
  taskId: string;
  projectId: string;
  expiresAt: string;
  bound: {
    target: AgentAssistanceTarget;
    input: AgentAssistanceInputSelection;
    materials: AgentAssistanceMaterial[];
    inputHash: string;
  };
}
const denied = () => new DomainError('AGENT_AUTH_REQUIRED', '请求发起凭据已失效或权限已撤销', 401);
export function isAgentRequesterPath(path: string, method: string) {
  return (
    (method === 'GET' &&
      ([
        '/agent-requester/v1/identity',
        '/agent-requester/v1/capabilities',
        '/agent-requester/v1/materials',
        '/agent-requester/v1/requests',
      ].includes(path) ||
        /^\/agent-requester\/v1\/(requests|receipts)\/[^/]+$/.test(path))) ||
    (method === 'POST' &&
      (['/agent-requester/v1/preview', '/agent-requester/v1/requests'].includes(path) ||
        /^\/agent-requester\/v1\/requests\/[^/]+\/(input-revisions|cancel)$/.test(path)))
  );
}
function current(
  db: DatabaseSync,
  column: 'id' | 'token_hash',
  value: string,
): AgentRequesterPrincipal {
  const row = db
    .prepare(
      `SELECT c.*, a.owner_user_id, a.space_id FROM agent_requester_credentials c
    JOIN agent_participants a ON a.id=c.participant_id
    JOIN agent_endpoints ae ON ae.participant_id=a.id
    JOIN tasks t ON t.id=c.task_id AND t.space_id=a.space_id
    JOIN projects p ON p.id=c.project_id AND p.space_id=a.space_id
    JOIN collab_memberships sm ON sm.space_id=a.space_id AND sm.user_id=a.owner_user_id
    JOIN collab_project_members pm ON pm.project_id=p.id AND pm.user_id=a.owner_user_id
    JOIN agent_participants recipient ON recipient.id=json_extract(c.body,'$.target.participantId') AND recipient.space_id=a.space_id
    JOIN agent_endpoints e ON e.participant_id=recipient.id
    JOIN agent_capabilities cap ON cap.participant_id=recipient.id
    JOIN agent_delegation_grants g ON g.id=json_extract(c.body,'$.target.grantId') AND g.participant_id=recipient.id AND g.project_id=p.id
    JOIN collab_memberships rsm ON rsm.space_id=a.space_id AND rsm.user_id=recipient.owner_user_id
    JOIN collab_project_members rpm ON rpm.project_id=p.id AND rpm.user_id=recipient.owner_user_id
    WHERE c.${column}=? AND c.revoked_at IS NULL AND c.expires_at>?
    AND a.revoked_at IS NULL AND recipient.revoked_at IS NULL AND ae.revision=c.endpoint_revision
    AND pm.role IN ('edit','manage') AND rpm.role IN ('edit','manage')
    AND json_extract(p.body,'$.archivedAt') IS NULL
    AND json_extract(t.body,'$.visibility')='project' AND json_extract(t.body,'$.projectId')=p.id
    AND g.revoked_at IS NULL AND g.revision=json_extract(c.body,'$.target.grantRevision')
    AND json_extract(g.body,'$.expiresAt')>? AND json_extract(g.body,'$.request')=1
    AND cap.id=json_extract(c.body,'$.target.capabilityId') AND cap.version=json_extract(c.body,'$.target.capabilityVersion')
    AND e.revision=json_extract(c.body,'$.target.endpointRevision')
    AND json_extract(g.body,'$.capabilityId')=cap.id AND json_extract(g.body,'$.capabilityVersion')=cap.version
    AND json_extract(g.body,'$.endpointRevision')=e.revision
    AND (json_extract(g.body,'$.audience')='project_members' OR EXISTS (SELECT 1 FROM json_each(g.body,'$.requesterUserIds') WHERE value=a.owner_user_id))`,
    )
    .get(value, new Date().toISOString(), new Date().toISOString()) as
    | {
        id: string;
        revision: number;
        participant_id: string;
        task_id: string;
        project_id: string;
        owner_user_id: string;
        space_id: string;
        expires_at: string;
        body: string;
      }
    | undefined;
  if (!row) throw denied();
  const body = JSON.parse(row.body);
  return {
    kind: 'agent',
    role: 'requester',
    participantId: row.participant_id,
    connectionId: row.id,
    connectionRevision: row.revision,
    ownerUserId: row.owner_user_id,
    spaceId: row.space_id,
    taskId: row.task_id,
    projectId: row.project_id,
    expiresAt: row.expires_at,
    bound: {
      target: body.target,
      input: body.input,
      materials: body.materials,
      inputHash: body.inputHash,
    },
  };
}
export function revalidateAgentRequesterConnection(
  db: DatabaseSync,
  actor: AgentRequesterPrincipal,
) {
  const fresh = current(db, 'id', actor.connectionId);
  if (canonicalJson(fresh) !== canonicalJson(actor)) throw denied();
  return fresh;
}
export function authenticateAgentRequesterConnection(
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
    throw new DomainError('AGENT_CHANNEL_REQUIRED', '发起通道不接受浏览器、节点或身份覆盖', 403);
  if (
    typeof headers.authorization !== 'string' ||
    !/^Bearer hexu_requester_[A-Za-z0-9_-]{43}$/.test(headers.authorization)
  )
    throw denied();
  return current(
    db,
    'token_hash',
    createHash('sha256').update(headers.authorization.slice(7)).digest('hex'),
  );
}
export function assertAgentRequesterSelection(
  actor: AgentRequesterPrincipal,
  taskId: string,
  participantId: string | null,
  target: AgentAssistanceTarget,
  input: AgentAssistanceInputSelection,
) {
  if (
    taskId !== actor.taskId ||
    participantId !== actor.participantId ||
    canonicalJson(target) !== canonicalJson(actor.bound.target) ||
    canonicalJson(input.message) !== canonicalJson(actor.bound.input.message) ||
    input.projectTexts.items.some(
      (ref) =>
        !actor.bound.input.projectTexts.items.some(
          (allowed) => canonicalJson(ref) === canonicalJson(allowed),
        ),
    )
  )
    throw new DomainError(
      'AGENT_SCOPE_REQUIRED',
      '请求不得扩大或更换固定任务、目标和材料范围',
      403,
    );
}
export function publicAgentRequesterActor(actor: AgentRequesterPrincipal) {
  return {
    kind: actor.kind,
    role: actor.role,
    participantId: actor.participantId,
    connectionId: actor.connectionId,
    connectionRevision: actor.connectionRevision,
    expiresAt: actor.expiresAt,
  };
}
