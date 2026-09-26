import { NodeContinuations } from '../../../packages/db/src/node-continuations.js';
import { NextInputs } from '../../../packages/db/src/next-inputs.js';
import { parseNextInputEdit } from '../../../packages/contracts/src/next-input.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, text, revision } from '../../../packages/contracts/src/index.js';
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
  const continuations = new NodeContinuations(store, execution);
  const token = (r: FastifyRequest) => {
    const value = r.headers.authorization;
    if (!value?.startsWith('Bearer '))
      throw new DomainError('NODE_AUTH_REQUIRED', '缺少节点凭证', 401);
    return nodeSecret(value.slice(7));
  };
  app.get('/api/v1/tasks/:taskId/node-options', async (r) => {
    const q = exact(r.query, ['sourceRunId']);
    const taskId = nodeId((r.params as { taskId: string }).taskId);
    const source = q.sourceRunId === undefined ? undefined : nodeId(q.sourceRunId);
    if (source) execution.continuationPreview(taskId, source, true);
    return execution.options(taskId, source);
  });
  app.get('/api/v1/tasks/:taskId/next-inputs', async (r) => ({
    items: new NextInputs(store).list(nodeId((r.params as { taskId: string }).taskId)),
  }));
  app.get('/api/v1/tasks/:taskId/node-continuation-preview', async (r) => {
    const q = exact(r.query, ['sourceRunId', 'waiting']);
    if (q.waiting !== undefined && q.waiting !== 'true')
      throw new DomainError('INVALID_INPUT', '无效等待预览选项');
    return execution.continuationPreview(
      nodeId((r.params as { taskId: string }).taskId),
      nodeId(q.sourceRunId),
      q.waiting === 'true',
    );
  });
  app.patch('/api/v1/next-inputs/:inputId', async (r) => {
    const body = parseNextInputEdit(r.body);
    return new NextInputs(store).edit(
      nodeId((r.params as { inputId: string }).inputId),
      body.expectedRevision,
      body.body,
      text(r.headers['idempotency-key'], '操作标识', 128),
    );
  });
  app.post('/api/v1/next-inputs/:inputId/cancel', async (r) => {
    const body = exact(r.body, ['expectedRevision']);
    return new NextInputs(store).edit(
      nodeId((r.params as { inputId: string }).inputId),
      revision(body.expectedRevision),
      null,
      text(r.headers['idempotency-key'], '操作标识', 128),
    );
  });
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
    try {
      execution.reconcile();
      continuations.tick();
    } catch {
      app.log.error('Node continuation reconciliation failed; no automatic execution retry');
    }
  }, 250);
  timer.unref();
  app.addHook('preClose', async () => {
    clearInterval(timer);
    continuations.close();
  });
  return Object.assign(execution, { continuations });
}
