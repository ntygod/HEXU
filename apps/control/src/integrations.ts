import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, revision, text } from '../../../packages/contracts/src/index.js';
import { exact, nodeId, nodeSecret } from '../../../packages/contracts/src/nodes.js';
import { IntegrationStore } from '../../../packages/db/src/integrations.js';
import type { Store } from '../../../packages/db/src/store.js';

export function attachIntegrations(app: FastifyInstance, store: Store) {
  if (!store.teamMode) return;
  const integrations = new IntegrationStore(store),
    path = '/api/v1/tasks/:taskId/integrations';
  const task = (r: FastifyRequest) => nodeId((r.params as { taskId: string }).taskId);
  const id = (r: FastifyRequest) => nodeId((r.params as { integrationId: string }).integrationId);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  const token = (r: FastifyRequest) => {
    if (!r.headers.authorization?.startsWith('Bearer '))
      throw new DomainError('NODE_AUTH_REQUIRED', '缺少节点凭证', 401);
    return nodeSecret(r.headers.authorization.slice(7));
  };
  app.get(path, async (r) => integrations.list(task(r)));
  app.get(path + '/options', async (r) => {
    const q = exact(r.query, ['resultId', 'revisionId']);
    return integrations.options(task(r), nodeId(q.resultId), nodeId(q.revisionId));
  });
  app.post(path, async (r, reply) =>
    reply.code(201).send(integrations.create(task(r), r.body, key(r))),
  );
  app.get(path + '/:integrationId', async (r) => integrations.get(task(r), id(r)));
  app.get(path + '/:integrationId/trials', async (r) => integrations.listTrials(task(r), id(r)));
  app.get(path + '/:integrationId/trials/:trialId', async (r) =>
    integrations.getTrial(task(r), id(r), nodeId((r.params as { trialId: string }).trialId)),
  );
  app.post(path + '/:integrationId/apply', async (r) =>
    integrations.apply(task(r), id(r), r.body, key(r)),
  );
  app.post(path + '/:integrationId/cancel', async (r) =>
    integrations.cancel(
      task(r),
      id(r),
      revision(exact(r.body, ['expectedRevision']).expectedRevision),
      key(r),
    ),
  );
  app.post('/runner/v1/integration-inspect', async (r) =>
    integrations.inspect(token(r), nodeId(exact(r.body, ['integrationId']).integrationId)),
  );
  app.post('/runner/v1/integration-apply-publish', async (r) =>
    integrations.publishApplication(token(r), r.body),
  );
  app.post('/runner/v1/integration-trial-diff-publish', async (r) =>
    integrations.publishTrialDifference(token(r), r.body),
  );
  app.post('/runner/v1/integration-recovery-publish', async (r) =>
    integrations.publishRecovery(token(r), r.body),
  );
  app.post('/runner/v1/integration-publish', async (r) => integrations.publish(token(r), r.body));
}
