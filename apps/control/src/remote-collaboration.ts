import Fastify from 'fastify';
import type { SecureContextOptions } from 'node:tls';
import { DomainError } from '../../../packages/contracts/src/index.js';
import type { Store } from '../../../packages/db/src/store.js';
import { isAgentRequesterPath } from '../../../packages/identity/src/agent-requester-connections.js';
import { isAgentReceiverPath } from '../../../packages/identity/src/agent-receiver-connections.js';
import { attachAgentRequester } from './agent-requester.js';
import { attachAgentReceiver } from './agent-receiver.js';
import { AgentEvents } from './agent-events.js';
import { attachAgentMcpHttp, MCP_PATH } from './agent-mcp-http.js';
import type { WebhookSender } from './event-webhook.js';

export function remoteOrigin(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.search ||
    u.hash ||
    !u.hostname.includes('.') ||
    u.hostname === 'localhost'
  )
    throw new Error('An explicit HTTPS collaboration origin is required');
  return u;
}
/** Deliberately distinct listener, not an exposed preview app or a general reverse proxy.
 * Only existing limited collaboration routes are reachable. No identity setup, browser UI,
 * native/node dispatch or human APIs. TLS is terminated here; forwarded headers are rejected.
 */
export async function createRemoteCollaboration(options: {
  store: Store;
  publicOrigin: string;
  tls: SecureContextOptions;
  encryptionKey: Buffer;
  sender?: WebhookSender;
  automaticDrain?: boolean;
}) {
  if (!options.store.teamMode) throw new Error('Remote collaboration requires existing team data');
  if (!options.tls.cert || !options.tls.key)
    throw new Error('Direct TLS certificate and key are required');
  const origin = remoteOrigin(options.publicOrigin);
  const app = Fastify({
    https: { ...options.tls, minVersion: 'TLSv1.2' },
    logger: false,
    bodyLimit: 65536,
    trustProxy: false,
  });
  const events = new AgentEvents(options.store, options.encryptionKey, options.sender);
  const limits = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Strict-Transport-Security', 'max-age=31536000');
    const u = new URL(req.url, 'https://localhost');
    if (
      req.headers.host !== origin.host ||
      u.search ||
      req.headers.forwarded ||
      Object.keys(req.headers).some((h) => h.startsWith('x-forwarded-')) ||
      req.headers.origin ||
      req.headers.cookie ||
      req.headers['sec-fetch-site']
    )
      throw new DomainError('REMOTE_BOUNDARY_REQUIRED', '只允许明确服务地址的独立认证请求', 403);
    if (
      !(u.pathname === MCP_PATH && req.method === 'POST') &&
      !isAgentRequesterPath(u.pathname, req.method) &&
      !isAgentReceiverPath(u.pathname, req.method)
    )
      throw new DomainError('NOT_FOUND', '此服务未开放该接口', 404);
    const now = Date.now();
    for (const [key, v] of limits) if (v.until <= now) limits.delete(key);
    const limit = limits.get(req.ip) ?? { count: 0, until: now + 60000 };
    if (++limit.count > 120 || limits.size >= 1000)
      throw new DomainError('RATE_LIMITED', '请稍后重试', 429);
    limits.set(req.ip, limit);
  });
  attachAgentRequester(app, options.store);
  attachAgentReceiver(app, options.store);
  attachAgentMcpHttp(app, events);
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof DomainError ? error.status : 500;
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="hexu-collaboration"');
    return reply.code(status).send({
      error: {
        code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
        message: 'Collaboration request rejected',
      },
    });
  });
  const timer =
    options.automaticDrain === false
      ? null
      : setInterval(() => {
          void events.drain().catch(() => {});
        }, 1000);
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await events.idle();
  });
  return { app, events };
}
