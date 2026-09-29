import type { FastifyInstance, FastifyRequest } from 'fastify';
import { text } from '../../../packages/contracts/src/index.js';
import { nodeId } from '../../../packages/contracts/src/nodes.js';
import { parseCheckpointCursor } from '../../../packages/contracts/src/checkpoints.js';
import { WorkBranchStore } from '../../../packages/db/src/work-branches.js';
import type { Store } from '../../../packages/db/src/store.js';

export function attachWorkBranches(app: FastifyInstance, store: Store) {
  if (!store.teamMode) return;
  const branches = new WorkBranchStore(store);
  const taskId = (r: FastifyRequest) => nodeId((r.params as { taskId: string }).taskId);
  const branchId = (r: FastifyRequest) => nodeId((r.params as { branchId: string }).branchId);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  const path = '/api/v1/tasks/:taskId/work-branches';
  app.get(path, async (r) => branches.list(taskId(r), parseCheckpointCursor(r.query)));
  app.get(path + '/options', async (r) => branches.options(taskId(r)));
  app.post(path, async (r, reply) =>
    reply.code(201).send(branches.create(taskId(r), r.body, key(r))),
  );
  app.get(path + '/groups/:groupId', async (r) =>
    branches.get(taskId(r), nodeId((r.params as { groupId: string }).groupId)),
  );
  app.get(path + '/:branchId/history', async (r) => branches.history(taskId(r), branchId(r)));
  app.post(path + '/:branchId/discard', async (r) =>
    branches.discard(taskId(r), branchId(r), r.body, key(r)),
  );
}
