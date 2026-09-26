import { attachNodeExecution } from './node-execution.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NodeRegistry } from '../../../packages/db/src/nodes.js';
import type { Store } from '../../../packages/db/src/store.js';
import { DomainError, revision, text } from '../../../packages/contracts/src/index.js';
import {
  exact,
  nodeId,
  nodeSecret,
  parsePair,
  parseSequence,
  parseSnapshot,
} from '../../../packages/contracts/src/nodes.js';

export function attachNodes(app: FastifyInstance, store: Store) {
  if (!store.teamMode) return;
  const nodes = new NodeRegistry(store);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  const id = (r: FastifyRequest) => nodeId((r.params as { nodeId: string }).nodeId);
  const token = (r: FastifyRequest) => {
    const header = r.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      throw new DomainError('NODE_AUTH_REQUIRED', '缺少节点凭证', 401);
    return nodeSecret(header.slice(7));
  };
  // Pairing attempts are bounded and never identify an account from a weak code.
  const limits = new Map<string, { end: number; count: number }>();
  function rate(r: FastifyRequest) {
    const at = Date.now();
    for (const [ip, entry] of limits) if (entry.end <= at) limits.delete(ip);
    const entry = limits.get(r.ip) ?? { end: at + 60000, count: 0 };
    if (++entry.count > 30 || limits.size >= 1000)
      throw new DomainError('RATE_LIMITED', '配对尝试过于频繁，请稍后重试', 429);
    limits.set(r.ip, entry);
  }
  app.get('/api/v1/nodes', async () => ({ items: nodes.list(), pairings: nodes.pairings() }));
  app.get('/api/v1/nodes/:nodeId', async (r) => nodes.get(id(r)));
  app.post('/api/v1/nodes/pairings', async (r, reply) => {
    const b = exact(r.body, ['projectId']);
    return reply.code(201).send(nodes.createPairing(nodeId(b.projectId, '项目'), key(r)));
  });
  app.post('/api/v1/nodes/pairings/:nodeId/cancel', async (r) => {
    exact(r.body, []);
    return nodes.cancelPairing(id(r), key(r));
  });
  app.post('/api/v1/nodes/:nodeId/revoke', async (r) => {
    const b = exact(r.body, ['expectedRevision']);
    return nodes.revoke(id(r), revision(b.expectedRevision), key(r));
  });

  // This prefix is deliberately outside user-cookie authentication. It accepts only
  // the narrow node protocol, never normal Task/Run/Result or hosted runtime APIs.
  app.post('/runner/v1/pairing-preview', async (r) => {
    rate(r);
    const b = exact(r.body, ['code']);
    return nodes.preview(nodeSecret(b.code));
  });
  app.post('/runner/v1/pair', async (r, reply) => {
    rate(r);
    return reply.code(201).send(nodes.pair(parsePair(r.body)));
  });
  app.post('/runner/v1/hello', async (r) => {
    const b = exact(r.body, ['protocol', 'connectionId']);
    if (b.protocol !== 1) throw new DomainError('PROTOCOL_UNSUPPORTED', '节点协议不兼容', 409);
    return nodes.hello(token(r), nodeId(b.connectionId));
  });
  app.post('/runner/v1/sync', async (r) => {
    const b = exact(r.body, ['connectionId', 'sequence', 'snapshot']);
    return nodes.sync(
      token(r),
      nodeId(b.connectionId),
      parseSequence(b.sequence),
      parseSnapshot(b.snapshot),
    );
  });
  app.post('/runner/v1/goodbye', async (r) => {
    const b = exact(r.body, ['connectionId']);
    return nodes.goodbye(token(r), nodeId(b.connectionId));
  });
  app.post('/runner/v1/disconnect', async (r) => {
    exact(r.body, []);
    return nodes.disconnect(token(r));
  });
  return attachNodeExecution(app, store, nodes);
}
