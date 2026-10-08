import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, record, revision, text } from '../../../packages/contracts/src/index.js';
import { AgentReceiverStore } from '../../../packages/db/src/agent-receiver.js';
import type { Store } from '../../../packages/db/src/store.js';
import {
  authenticateAgentReceiverConnection,
  isAgentReceiverPath,
  publicAgentReceiverActor,
} from '../../../packages/identity/src/agent-receiver-connections.js';
export function attachAgentReceiver(app: FastifyInstance, store: Store) {
  const service = new AgentReceiverStore(store),
    body = { bodyLimit: 64 * 1024 };
  const id = (r: FastifyRequest, name: string) => text(record(r.params)[name], name, 150);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  const base = '/api/v1/agent-participants/:participantId/receiver-connections';
  app.get(base, async (r) => service.listCredentials(id(r, 'participantId')));
  app.get(`${base}/:connectionId`, async (r) =>
    service.getCredential(id(r, 'participantId'), id(r, 'connectionId')),
  );
  app.post(base, body, async (r, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .code(201)
      .send(service.issue(id(r, 'participantId'), r.body, key(r))),
  );
  app.post(`${base}/:connectionId/revoke`, body, async (r) =>
    service.revoke(id(r, 'participantId'), id(r, 'connectionId'), r.body, key(r)),
  );
  app.addHook('onRequest', async (r, reply) => {
    const url = new URL(r.url, 'http://localhost');
    if (!url.pathname.startsWith('/agent-receiver/')) return;
    reply.header('x-hexu-agent-api', '1').header('Cache-Control', 'no-store');
    if (!store.teamMode)
      throw new DomainError('REAL_IDENTITY_REQUIRED', '接收通道仅在真实账号模式启用', 422);
    if (r.headers['x-hexu-agent-api'] !== '1')
      throw new DomainError('AGENT_API_VERSION_UNSUPPORTED', '需要 Agent API 版本 1', 409);
    if (
      !isAgentReceiverPath(url.pathname, r.method) ||
      url.search ||
      (r.method === 'GET' &&
        (r.headers['transfer-encoding'] ||
          (r.headers['content-length'] !== undefined && r.headers['content-length'] !== '0')))
    )
      throw new DomainError('NOT_FOUND', '此通道未开放该动作', 404);
    authenticateAgentReceiverConnection(store.db, r.headers);
  });
  const current = (r: FastifyRequest) => authenticateAgentReceiverConnection(store.db, r.headers);
  app.get('/agent-receiver/v1/identity', async (r) => publicAgentReceiverActor(current(r)));
  app.get('/agent-receiver/v1/requests', async (r) => ({ items: service.list(current(r)) }));
  app.get('/agent-receiver/v1/requests/:requestId', async (r) =>
    service.get(current(r), id(r, 'requestId')),
  );
  app.get('/agent-receiver/v1/requests/:requestId/input-revisions/:revision', async (r) =>
    service.input(current(r), id(r, 'requestId'), revision(Number(id(r, 'revision')))),
  );
  app.post('/agent-receiver/v1/requests/:requestId/responses', body, async (r) =>
    service.respond(current(r), id(r, 'requestId'), r.body, key(r)),
  );
}
