import type { FastifyInstance, FastifyRequest } from 'fastify';
import { record, text } from '../../../packages/contracts/src/index.js';
import {
  AgentCapabilitiesStore,
  type AgentResourcesContext,
} from '../../../packages/db/src/agent-capabilities.js';

/** Browser-authenticated resource management only. No Cookie/Bearer-to-Agent conversion. */
export function attachAgentCapabilities(app: FastifyInstance, context: AgentResourcesContext) {
  const resources = new AgentCapabilitiesStore(context);
  const id = (r: FastifyRequest, name: string) => text(record(r.params)[name], name, 150);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  app.post('/api/v1/agent-participants/:agentId/connection', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return resources.issueConnection(id(r, 'agentId'), r.body, key(r));
  });
  app.post('/api/v1/agent-participants/:agentId/connection/revoke', async (r) =>
    resources.revokeConnection(id(r, 'agentId'), r.body, key(r)),
  );
  app.get('/api/v1/agent-participants', async () => ({
    items: resources.list(),
  }));
  app.post('/api/v1/agent-participants', async (r, reply) =>
    reply.code(201).send(resources.register(r.body, key(r))),
  );
  app.patch('/api/v1/agent-participants/:agentId', async (r) =>
    resources.update(id(r, 'agentId'), r.body, key(r)),
  );
  app.post('/api/v1/agent-participants/:agentId/revoke', async (r) =>
    resources.revoke(id(r, 'agentId'), r.body, key(r)),
  );
  app.post('/api/v1/agent-participants/:agentId/endpoint', async (r) =>
    resources.setEndpoint(id(r, 'agentId'), r.body, key(r)),
  );
  app.post('/api/v1/agent-participants/:agentId/capability', async (r) =>
    resources.setCapability(id(r, 'agentId'), r.body, key(r)),
  );
  app.post('/api/v1/agent-participants/:agentId/grants', async (r, reply) =>
    reply.code(201).send(resources.grant(id(r, 'agentId'), r.body, key(r))),
  );
  app.post('/api/v1/agent-participants/:agentId/grants/:grantId/revoke', async (r) =>
    resources.revokeGrant(id(r, 'agentId'), id(r, 'grantId'), r.body, key(r)),
  );
  app.get('/api/v1/projects/:projectId/agent-capabilities', async (r) => ({
    items: resources.discover(id(r, 'projectId')),
  }));
  app.post('/api/v1/projects/:projectId/agent-capabilities/:capabilityId/select', async (r) =>
    resources.select(id(r, 'projectId'), id(r, 'capabilityId'), r.body),
  );
}
