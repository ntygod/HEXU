import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../contracts/src/index.js';

export type AgentAssistanceScope = 'material_read' | 'respond';
/** Internal authority only. Never serialize this object into a response or event. */
export interface AgentAssistancePrincipal {
  /** Bootstrap provenance; never grants human access. */
  receiverConnection?: true;
  kind: 'agent';
  participantId: string;
  connectionId: string;
  connectionRevision: number;
  ownerUserId: string;
  spaceId: string;
  assistanceId: string;
  scopes: AgentAssistanceScope[];
  expiresAt: string;
}
export function publicAgentAssistanceActor(actor: AgentAssistancePrincipal) {
  return {
    kind: actor.kind,
    participantId: actor.participantId,
    connectionId: actor.connectionId,
    connectionRevision: actor.connectionRevision,
  };
}
export function isAgentAssistancePath(pathname: string, method: string) {
  return (
    (method === 'GET' &&
      (pathname === '/agent-assistance/v1/identity' ||
        /^\/agent-assistance\/v1\/requests\/[^/]+$/.test(pathname) ||
        /^\/agent-assistance\/v1\/requests\/[^/]+\/input-revisions\/[1-9][0-9]*$/.test(
          pathname,
        ))) ||
    (method === 'POST' && /^\/agent-assistance\/v1\/requests\/[^/]+\/responses$/.test(pathname))
  );
}
/** Request-bound bearer credentials cannot borrow a human principal or capability-read token. */
export function authenticateAgentAssistanceConnection(
  db: DatabaseSync,
  headers: Record<string, unknown>,
): AgentAssistancePrincipal {
  if (
    headers.cookie ||
    headers.origin ||
    headers['sec-fetch-site'] ||
    headers['x-hexu-runner'] ||
    headers['x-hexu-space'] ||
    headers['x-hexu-client']
  )
    throw new DomainError(
      'AGENT_CHANNEL_REQUIRED',
      '有限 Agent 通道不接受浏览器、节点或身份覆盖',
      403,
    );
  const authorization = headers.authorization;
  if (
    typeof authorization !== 'string' ||
    !/^Bearer hexu_request_[A-Za-z0-9_-]{43}$/.test(authorization)
  )
    throw new DomainError('AGENT_AUTH_REQUIRED', '需要请求绑定的独立 Agent 凭据', 401);
  const row = db
    .prepare(
      `
    SELECT c.id,c.revision,c.participant_id,c.assistance_id,c.scopes,c.expires_at,
           a.owner_user_id,a.space_id
    FROM assistance_agent_credentials c
    JOIN assistance_agent_requests r ON r.assistance_id=c.assistance_id
      AND r.recipient_participant_id=c.participant_id
    JOIN assistances h ON h.id=r.assistance_id
    JOIN agent_participants a ON a.id=c.participant_id AND a.space_id=h.space_id
    JOIN agent_endpoints e ON e.participant_id=a.id
    JOIN agent_capabilities cap ON cap.participant_id=a.id AND cap.id=r.capability_id
    JOIN agent_delegation_grants g ON g.id=r.grant_id AND g.participant_id=a.id
    JOIN tasks t ON t.id=h.task_id AND t.space_id=h.space_id
    JOIN projects p ON p.id=json_extract(t.body,'$.projectId') AND p.space_id=h.space_id
    JOIN collab_memberships owner_member ON owner_member.space_id=a.space_id AND owner_member.user_id=a.owner_user_id
    JOIN collab_memberships requester_member ON requester_member.space_id=h.space_id AND requester_member.user_id=h.requester_id
    JOIN collab_project_members requester_project ON requester_project.project_id=p.id AND requester_project.user_id=h.requester_id
    JOIN collab_project_members owner_project ON owner_project.project_id=p.id AND owner_project.user_id=a.owner_user_id
    WHERE c.token_hash=? AND c.revoked_at IS NULL AND c.expires_at>?
      AND r.revoked_at IS NULL AND a.revoked_at IS NULL AND h.state!='cancelled'
      AND g.revoked_at IS NULL AND g.project_id=p.id AND g.revision=r.grant_revision
      AND json_extract(g.body,'$.expiresAt')>?
      AND json_extract(g.body,'$.request')=1
      AND json_extract(g.body,'$.capabilityId')=cap.id
      AND json_extract(g.body,'$.capabilityVersion')=cap.version
      AND json_extract(g.body,'$.endpointRevision')=e.revision
      AND (json_extract(g.body,'$.audience')='project_members' OR EXISTS
        (SELECT 1 FROM json_each(g.body,'$.requesterUserIds') WHERE value=h.requester_id))
      AND e.revision=r.endpoint_revision AND cap.version=r.capability_version
      AND owner_project.role IN ('edit','manage')
      AND json_extract(p.body,'$.archivedAt') IS NULL
  `,
    )
    .get(
      createHash('sha256').update(authorization.slice(7)).digest('hex'),
      new Date().toISOString(),
      new Date().toISOString(),
    ) as
    | {
        id: string;
        revision: number;
        participant_id: string;
        assistance_id: string;
        scopes: string;
        expires_at: string;
        owner_user_id: string;
        space_id: string;
      }
    | undefined;
  if (!row) throw new DomainError('AGENT_AUTH_REQUIRED', '请求凭据已失效或授权已撤销', 401);
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes);
  } catch {
    scopes = null;
  }
  if (
    !Array.isArray(scopes) ||
    !scopes.includes('material_read') ||
    scopes.some((scope) => !['material_read', 'respond'].includes(scope))
  )
    throw new DomainError('AGENT_AUTH_REQUIRED', '请求凭据权限无效', 401);
  return {
    kind: 'agent',
    participantId: row.participant_id,
    connectionId: row.id,
    connectionRevision: row.revision,
    ownerUserId: row.owner_user_id,
    spaceId: row.space_id,
    assistanceId: row.assistance_id,
    scopes: scopes as AgentAssistanceScope[],
    expiresAt: row.expires_at,
  };
}
