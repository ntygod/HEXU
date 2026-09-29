import type { FastifyInstance, FastifyRequest } from 'fastify';
import { text } from '../../../packages/contracts/src/index.js';
import { nodeId } from '../../../packages/contracts/src/nodes.js';
import { parseCheckpointCursor } from '../../../packages/contracts/src/checkpoints.js';
import { HandoffStore } from '../../../packages/db/src/handoffs.js';
import type { Store } from '../../../packages/db/src/store.js';

export function attachHandoffs(app: FastifyInstance, store: Store) {
  if (!store.teamMode) return;
  const handoffs = new HandoffStore(store);
  const taskId = (r: FastifyRequest) => nodeId((r.params as { taskId: string }).taskId);
  const id = (r: FastifyRequest) => nodeId((r.params as { handoffId: string }).handoffId);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  const path = '/api/v1/tasks/:taskId/handoffs';
  app.get(path, async (r) => handoffs.list(taskId(r), parseCheckpointCursor(r.query)));
  app.get(path + '/options', async (r) => handoffs.options(taskId(r)));
  app.post(path, async (r, reply) =>
    reply.code(201).send(handoffs.offer(taskId(r), r.body, key(r))),
  );
  app.get(path + '/:handoffId', async (r) => handoffs.get(taskId(r), id(r)));
  app.get(path + '/:handoffId/history', async (r) => handoffs.history(taskId(r), id(r)));
  for (const action of ['reject', 'withdraw'] as const)
    app.post(path + `/:handoffId/${action}`, async (r) =>
      handoffs.close(taskId(r), id(r), action, r.body, key(r)),
    );
  const timer = setInterval(() => {
    try {
      handoffs.expire();
    } catch {
      /* Retry without fabricating an expired receipt. */
    }
  }, 60000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
