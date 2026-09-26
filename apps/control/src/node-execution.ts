import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, text } from '../../../packages/contracts/src/index.js';
import { exact, nodeId, nodeSecret } from '../../../packages/contracts/src/nodes.js';
import {
  parseExecutionEvent,
  parsePolicy,
} from '../../../packages/contracts/src/node-execution.js';
import { NodeExecution } from '../../../packages/db/src/node-execution.js';
import type { NodeRegistry } from '../../../packages/db/src/nodes.js';
import type { Store } from '../../../packages/db/src/store.js';

export function attachNodeExecution(app: FastifyInstance, store: Store, nodes: NodeRegistry) {
  const execution = new NodeExecution(store, nodes);
  const token = (r: FastifyRequest) => {
    const value = r.headers.authorization;
    if (!value?.startsWith('Bearer '))
      throw new DomainError('NODE_AUTH_REQUIRED', '缺少节点凭证', 401);
    return nodeSecret(value.slice(7));
  };
  app.get('/api/v1/tasks/:taskId/node-options', async (r) =>
    execution.options(nodeId((r.params as { taskId: string }).taskId)),
  );
  app.post('/runner/v1/execution-policy', async (r) => {
    const b = exact(r.body, ['connectionId', 'policy']);
    return execution.publish(
      token(r),
      nodeId(b.connectionId),
      b.policy === null ? null : parsePolicy(b.policy),
    );
  });
  app.post('/runner/v1/execution-poll', async (r) => {
    const b = exact(r.body, ['connectionId']);
    return execution.poll(token(r), nodeId(b.connectionId));
  });
  app.post('/runner/v1/execution-permit', async (r) => {
    const b = exact(r.body, ['connectionId', 'dispatchId', 'generation']);
    return execution.permit(
      token(r),
      nodeId(b.connectionId),
      nodeId(b.dispatchId),
      nodeId(b.generation),
    );
  });
  app.post('/runner/v1/execution-event', async (r) => {
    const b = exact(r.body, ['dispatchId', 'generation', 'event']);
    return execution.acceptEvent(
      token(r),
      nodeId(b.dispatchId),
      nodeId(b.generation),
      parseExecutionEvent(b.event),
    );
  });
  const timer = setInterval(() => {
    execution.reconcile();
  }, 1000);
  timer.unref();
  app.addHook('preClose', async () => {
    clearInterval(timer);
  });
  return execution;
}
