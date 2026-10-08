import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, record, text } from '../../../packages/contracts/src/index.js';
import {
  AgentCapabilitiesStore,
  type AgentResourcesContext,
} from '../../../packages/db/src/agent-capabilities.js';
import { PermissionService } from '../../../packages/db/src/permissions.js';
import {
  authenticateAgentConnection,
  agentOwnerPrincipal,
  isAgentConnectionPath,
  type AgentConnectionPrincipal,
} from '../../../packages/identity/src/agent-connections.js';

/** Read-only independent Agent transport, still governed by the app's loopback host boundary.
 * Exact allowlist, no browser-session bypass for any /api/v1 route. */
export function attachAgentConnections(app: FastifyInstance, context: AgentResourcesContext) {
  const actors = new WeakMap<FastifyRequest, AgentConnectionPrincipal>();
  app.addHook('onRequest', async (request, reply) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/agent/')) return;
    if (!context.teamMode)
      throw new DomainError('REAL_IDENTITY_REQUIRED', '独立 Agent 通道仅在真实账号模式启用', 422);
    if (
      request.method !== 'GET' ||
      url.search ||
      !isAgentConnectionPath(url.pathname) ||
      request.headers['transfer-encoding'] ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
    )
      throw new DomainError('NOT_FOUND', '此 Agent 通道尚未开放该动作', 404);
    actors.set(request, authenticateAgentConnection(context.db, request.headers));
    reply.header('Cache-Control', 'no-store');
  });
  const current = (request: FastifyRequest) => {
    if (!actors.has(request))
      throw new DomainError('AGENT_AUTH_REQUIRED', '需要独立 Agent 身份', 401);
    // Recheck current generation, revocation and membership immediately before every read.
    return authenticateAgentConnection(context.db, request.headers);
  };
  app.get('/agent/v1/identity', async (request) => current(request));
  app.get('/agent/v1/projects/:projectId/capabilities', async (request) => {
    const actor = current(request),
      projectId = text(record(request.params).projectId, '项目', 150);
    if (projectId !== actor.projectId)
      throw new DomainError('NOT_FOUND', '项目不在此连接的只读范围内', 404);
    const principal = agentOwnerPrincipal(context.db, actor);
    const resources = new AgentCapabilitiesStore({
      db: context.db,
      teamMode: true,
      actorId: actor.ownerUserId,
      spaceId: actor.spaceId,
      permissions: new PermissionService(context.db, () => principal),
    });
    return { actor, items: resources.discover(projectId) };
  });
}
