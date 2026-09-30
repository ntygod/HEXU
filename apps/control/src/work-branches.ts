import type { FastifyInstance, FastifyRequest } from 'fastify';
import { text } from '../../../packages/contracts/src/index.js';
import { nodeId } from '../../../packages/contracts/src/nodes.js';
import { parseCheckpointCursor } from '../../../packages/contracts/src/checkpoints.js';
import { WorkBranchStore } from '../../../packages/db/src/work-branches.js';
import { BranchWorkspaceStore } from '../../../packages/db/src/work-branch-workspaces.js';
import { WorkBranchResultSourceStore } from '../../../packages/db/src/work-branch-result-source.js';
import { DomainError, revision } from '../../../packages/contracts/src/index.js';
import { exact, nodeSecret } from '../../../packages/contracts/src/nodes.js';
import type { Store } from '../../../packages/db/src/store.js';

export function attachWorkBranches(app: FastifyInstance, store: Store) {
  if (!store.teamMode) return;
  const branches = new WorkBranchStore(store);
  const workspaces = new BranchWorkspaceStore(store);
  const resultSources = new WorkBranchResultSourceStore(store);
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
  app.get(path + '/:branchId/result-source', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return resultSources.get(taskId(r), branchId(r));
  });
  app.post(path + '/:branchId/discard', async (r) =>
    branches.discard(taskId(r), branchId(r), r.body, key(r)),
  );
  const opId = (r: FastifyRequest) =>
    nodeId((r.params as { workspaceOperationId: string }).workspaceOperationId);
  app.get(path + '/:branchId/workspace-options', async (r) =>
    workspaces.options(taskId(r), branchId(r)),
  );
  app.post(path + '/:branchId/workspaces', async (r, reply) =>
    reply.code(201).send(workspaces.create(taskId(r), branchId(r), r.body, key(r))),
  );
  app.get(path + '/:branchId/workspaces/:workspaceOperationId', async (r) =>
    workspaces.get(taskId(r), branchId(r), opId(r)),
  );
  app.post(path + '/:branchId/workspaces/:workspaceOperationId/cancel', async (r) =>
    workspaces.cancel(
      taskId(r),
      branchId(r),
      opId(r),
      revision(exact(r.body, ['expectedRevision']).expectedRevision),
      key(r),
    ),
  );
  app.post('/runner/v1/work-branch-workspace', async (r) => {
    if (!r.headers.authorization?.startsWith('Bearer '))
      throw new DomainError('NODE_AUTH_REQUIRED', '缺少节点凭证', 401);
    return workspaces.nodeCommand(nodeSecret(r.headers.authorization.slice(7)), r.body);
  });
}
