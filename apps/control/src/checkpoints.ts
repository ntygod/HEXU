import { CheckpointRetentionStore } from '../../../packages/db/src/checkpoint-retention.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, text } from '../../../packages/contracts/src/index.js';
import { exact, nodeId, nodeSecret } from '../../../packages/contracts/src/nodes.js';
import { parseCheckpointCursor } from '../../../packages/contracts/src/checkpoints.js';
import { CheckpointStore } from '../../../packages/db/src/checkpoints.js';
import type { Store } from '../../../packages/db/src/store.js';
export function attachCheckpoints(app: FastifyInstance, store: Store) {
  if (!store.teamMode) return;
  const checkpoints = new CheckpointStore(store);
  const taskId = (r: FastifyRequest) => nodeId((r.params as { taskId: string }).taskId);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  const token = (r: FastifyRequest) => {
    if (!r.headers.authorization?.startsWith('Bearer '))
      throw new DomainError('NODE_AUTH_REQUIRED', '缺少节点凭证', 401);
    return nodeSecret(r.headers.authorization.slice(7));
  };
  app.get('/api/v1/tasks/:taskId/checkpoint-options', async (r) => checkpoints.options(taskId(r)));
  app.get('/api/v1/tasks/:taskId/checkpoints', async (r) =>
    checkpoints.list(taskId(r), parseCheckpointCursor(r.query)),
  );
  app.post('/api/v1/tasks/:taskId/checkpoint-requests', async (r, reply) =>
    reply.code(201).send(checkpoints.create(taskId(r), r.body, key(r))),
  );
  app.post('/api/v1/tasks/:taskId/checkpoint-requests/:requestId/cancel', async (r) => {
    exact(r.body, []);
    return checkpoints.cancel(
      taskId(r),
      nodeId((r.params as { requestId: string }).requestId),
      key(r),
    );
  });
  app.post('/runner/v1/checkpoint-inspect', async (r) => {
    const b = exact(r.body, ['requestId']);
    return checkpoints.inspect(token(r), nodeId(b.requestId));
  });
  app.post('/runner/v1/checkpoint-publish', async (r, reply) =>
    reply.code(201).send(checkpoints.publish(token(r), r.body)),
  );
  const retained = new CheckpointRetentionStore(store);
  const refId = (r: FastifyRequest) => nodeId((r.params as { checkpointId: string }).checkpointId);
  const route = '/api/v1/tasks/:taskId/checkpoints/:checkpointId/retentions';
  app.get(route, async (r) => retained.list(taskId(r), refId(r)));
  app.post(route, async (r, reply) =>
    reply.code(201).send(retained.create(taskId(r), refId(r), r.body, key(r))),
  );
  app.post(route + '/:requestId/cancel', async (r) => {
    exact(r.body, []);
    return retained.cancel(
      taskId(r),
      refId(r),
      nodeId((r.params as { requestId: string }).requestId),
      key(r),
    );
  });
  app.post('/runner/v1/checkpoint-retention-inspect', async (r) => {
    const b = exact(r.body, ['requestId']);
    return retained.inspect(token(r), nodeId(b.requestId));
  });
  app.post('/runner/v1/checkpoint-retention-report', async (r, reply) =>
    reply.code(201).send(retained.report(token(r), r.body)),
  );
}
