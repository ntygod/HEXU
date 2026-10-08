import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, record, text } from '../../../packages/contracts/src/index.js';
import { AgentRequesterStore } from '../../../packages/db/src/agent-requester.js';
import type { Store } from '../../../packages/db/src/store.js';
import {
  authenticateAgentRequesterConnection,
  isAgentRequesterPath,
  publicAgentRequesterActor,
} from '../../../packages/identity/src/agent-requester-connections.js';
import { requestView } from './agent-assistance.js';

export function attachAgentRequester(app: FastifyInstance, store: Store) {
  const service = new AgentRequesterStore(store),
    body = { bodyLimit: 64 * 1024 };
  const id = (r: FastifyRequest, name: string) => text(record(r.params)[name], name, 150);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  app.get('/api/v1/tasks/:taskId/agent-requester-credentials', async (r) =>
    service.listCredentials(id(r, 'taskId')),
  );
  app.post('/api/v1/tasks/:taskId/agent-requester-credentials', body, async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(service.issue(id(r, 'taskId'), r.body, key(r)));
  });
  app.post(
    '/api/v1/tasks/:taskId/agent-requester-credentials/:credentialId/revoke',
    body,
    async (r) => service.revoke(id(r, 'taskId'), id(r, 'credentialId'), r.body, key(r)),
  );
  app.addHook('onRequest', async (r, reply) => {
    const url = new URL(r.url, 'http://localhost');
    if (!url.pathname.startsWith('/agent-requester/')) return;
    reply.header('x-hexu-agent-api', '1').header('Cache-Control', 'no-store');
    if (!store.teamMode)
      throw new DomainError('REAL_IDENTITY_REQUIRED', '有限发起通道仅在真实账号模式启用', 422);
    if (r.headers['x-hexu-agent-api'] !== '1')
      throw new DomainError('AGENT_API_VERSION_UNSUPPORTED', '需要 Agent API 版本 1', 409);
    if (
      !isAgentRequesterPath(url.pathname, r.method) ||
      url.search ||
      (r.method === 'GET' &&
        (r.headers['transfer-encoding'] ||
          (r.headers['content-length'] !== undefined && r.headers['content-length'] !== '0')))
    )
      throw new DomainError('NOT_FOUND', '此通道未开放该动作', 404);
    authenticateAgentRequesterConnection(store.db, r.headers);
  });
  const current = (r: FastifyRequest) => authenticateAgentRequesterConnection(store.db, r.headers);
  app.get('/agent-requester/v1/identity', async (r) => publicAgentRequesterActor(current(r)));
  app.get('/agent-requester/v1/capabilities', async (r) => service.capabilities(current(r)));
  app.get('/agent-requester/v1/materials', async (r) => service.materials(current(r)));
  app.post('/agent-requester/v1/preview', body, async (r) => service.preview(current(r), r.body));
  app.get('/agent-requester/v1/requests', async (r) => ({
    items: service.list(current(r)).map(requestView),
  }));
  app.post('/agent-requester/v1/requests', body, async (r, reply) =>
    reply.code(201).send(requestView(service.create(current(r), r.body, key(r)))),
  );
  app.get('/agent-requester/v1/requests/:requestId', async (r) =>
    requestView(service.get(current(r), id(r, 'requestId'))),
  );
  app.post('/agent-requester/v1/requests/:requestId/input-revisions', body, async (r, reply) =>
    reply
      .code(201)
      .send(requestView(service.revise(current(r), id(r, 'requestId'), r.body, key(r)))),
  );
  app.post('/agent-requester/v1/requests/:requestId/cancel', body, async (r) =>
    requestView(service.cancel(current(r), id(r, 'requestId'), r.body, key(r))),
  );
  app.get('/agent-requester/v1/receipts/:operationKey', async (r) => {
    const result = service.receipt(current(r), id(r, 'operationKey'));
    return result
      ? { status: 'recorded', request: requestView(result) }
      : { status: 'not_recorded' };
  });
}
