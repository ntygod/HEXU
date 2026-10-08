import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../contracts/src/index.js';
import type { Principal } from '../../contracts/src/identity.js';

export interface AgentConnectionPrincipal {
  actorType: 'agent';
  participantId: string;
  connectionId: string;
  connectionRevision: number;
  ownerUserId: string;
  spaceId: string;
  projectId: string;
  scope: 'capability_read';
  expiresAt: string;
}
export function isAgentConnectionPath(pathname: string) {
  return (
    pathname === '/agent/v1/identity' ||
    /^\/agent\/v1\/projects\/[^/]+\/capabilities$/.test(pathname)
  );
}
/** Independent capability-read credential only. Browser/node/admin credentials are never adopted.
 * No external calls, account credentials or plaintext secret storage. */
export function authenticateAgentConnection(
  db: DatabaseSync,
  headers: Record<string, unknown>,
): AgentConnectionPrincipal {
  if (
    headers.cookie ||
    headers.origin ||
    headers['sec-fetch-site'] ||
    headers['x-hexu-runner'] ||
    headers['x-hexu-space']
  )
    throw new DomainError(
      'AGENT_CHANNEL_REQUIRED',
      'Agent 通道不接受浏览器会话、节点或空间身份覆盖',
      403,
    );
  const authorization = headers.authorization;
  if (
    typeof authorization !== 'string' ||
    !/^Bearer hexu_agent_[A-Za-z0-9_-]{43}$/.test(authorization)
  )
    throw new DomainError('AGENT_AUTH_REQUIRED', '需要独立 Agent 连接凭据', 401);
  const token = authorization.slice(7);
  const row = db
    .prepare(
      `SELECT c.id,c.revision,c.participant_id,c.project_id,c.expires_at,a.owner_user_id,a.space_id
    FROM agent_connections c JOIN agent_participants a ON a.id=c.participant_id
    JOIN agent_endpoints e ON e.participant_id=a.id
    JOIN collab_memberships sm ON sm.space_id=a.space_id AND sm.user_id=a.owner_user_id
    JOIN collab_project_members pm ON pm.project_id=c.project_id AND pm.user_id=a.owner_user_id
    JOIN projects p ON p.id=c.project_id AND p.space_id=a.space_id
    WHERE c.token_hash=? AND c.revoked_at IS NULL AND a.revoked_at IS NULL
    AND c.endpoint_revision=e.revision AND c.expires_at>? AND pm.role IN ('edit','manage')
    AND json_extract(p.body,'$.archivedAt') IS NULL`,
    )
    .get(createHash('sha256').update(token).digest('hex'), new Date().toISOString()) as
    | {
        id: string;
        revision: number;
        participant_id: string;
        project_id: string;
        expires_at: string;
        owner_user_id: string;
        space_id: string;
      }
    | undefined;
  if (!row) throw new DomainError('AGENT_AUTH_REQUIRED', 'Agent 连接凭据已失效或权限已撤销', 401);
  return {
    actorType: 'agent',
    participantId: row.participant_id,
    connectionId: row.id,
    connectionRevision: row.revision,
    ownerUserId: row.owner_user_id,
    spaceId: row.space_id,
    projectId: row.project_id,
    scope: 'capability_read',
    expiresAt: row.expires_at,
  };
}
/** Internal current human authority lookup, never supplied by the remote Agent body. */
export function agentOwnerPrincipal(db: DatabaseSync, actor: AgentConnectionPrincipal): Principal {
  const user = db
    .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
    .get(actor.ownerUserId) as Principal['user'] | undefined;
  if (!user) throw new DomainError('AGENT_AUTH_REQUIRED', 'Agent 所有者已不可用', 401);
  return { user, spaceId: actor.spaceId };
}
