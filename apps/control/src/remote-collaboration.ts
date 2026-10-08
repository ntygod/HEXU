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
import {
  attachRemoteOAuth,
  isOAuthBrowserPath,
  isRemoteOAuthPath,
  openRemoteOAuth,
  type RemoteOAuthOptions,
} from './remote-oauth.js';

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
 * Only limited collaboration and explicitly opted-in OAuth routes are reachable. No identity setup,
 * native/node dispatch or human APIs. TLS is terminated here; forwarded headers are rejected.
 */
export async function createRemoteCollaboration(options: {
  store: Store;
  publicOrigin: string;
  tls: SecureContextOptions;
  encryptionKey: Buffer;
  sender?: WebhookSender;
  automaticDrain?: boolean;
  oauth?: RemoteOAuthOptions;
}) {
  if (!options.store.teamMode) throw new Error('Remote collaboration requires existing team data');
  if (!options.tls.cert || !options.tls.key)
    throw new Error('Direct TLS certificate and key are required');
  if (options.encryptionKey.length !== 32)
    throw new Error('Events require a 32-byte encryption key');
  const origin = remoteOrigin(options.publicOrigin);
  const app = Fastify({
    https: { ...options.tls, minVersion: 'TLSv1.2' },
    logger: false,
    bodyLimit: 65536,
    trustProxy: false,
  });
  const oauth = options.oauth
    ? await openRemoteOAuth(options.store, origin.origin, options.oauth)
    : undefined;
  const events = new AgentEvents(
    options.store,
    options.encryptionKey,
    options.sender,
    oauth?.issuer.resourceServer ?? undefined,
  );
  const limits = new Map<string, { count: number; signIns: number; until: number }>();
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Strict-Transport-Security', 'max-age=31536000');
    const u = new URL(req.url, 'https://localhost');
    const oauthRoute = !!oauth && isRemoteOAuthPath(u.pathname, req.method);
    const oauthMetadata =
      !!oauth &&
      req.method === 'GET' &&
      u.pathname === '/.well-known/oauth-protected-resource/collaboration/mcp';
    const browser = oauthRoute && isOAuthBrowserPath(u.pathname);
    if (
      req.headers.host !== origin.host ||
      req.url !== u.pathname + u.search ||
      req.headers.forwarded ||
      Object.keys(req.headers).some((h) => h.startsWith('x-forwarded-')) ||
      (!browser &&
        (u.search || req.headers.origin || req.headers.cookie || req.headers['sec-fetch-site'])) ||
      (browser && req.headers.authorization) ||
      (browser &&
        req.method === 'POST' &&
        (req.headers.origin !== origin.origin || req.headers['sec-fetch-site'] === 'cross-site'))
    )
      throw new DomainError('REMOTE_BOUNDARY_REQUIRED', '只允许明确服务地址的独立认证请求', 403);
    if (
      !(u.pathname === MCP_PATH && req.method === 'POST') &&
      !oauthRoute &&
      !oauthMetadata &&
      !isAgentRequesterPath(u.pathname, req.method) &&
      !isAgentReceiverPath(u.pathname, req.method)
    )
      throw new DomainError('NOT_FOUND', '此服务未开放该接口', 404);
    const now = Date.now();
    for (const [key, v] of limits) if (v.until <= now) limits.delete(key);
    const limit = limits.get(req.ip) ?? { count: 0, signIns: 0, until: now + 60000 };
    // Use the TLS peer, never an attacker-supplied IP header, for the new password surface.
    const loginLimit =
      browser &&
      req.method === 'POST' &&
      u.pathname === '/collaboration-auth/sign-in' &&
      ++limit.signIns > 10;
    if (++limit.count > 120 || loginLimit || limits.size >= 1000)
      throw new DomainError('RATE_LIMITED', '请稍后重试', 429);
    limits.set(req.ip, limit);
  });
  attachAgentRequester(app, options.store);
  attachAgentReceiver(app, options.store);
  attachAgentMcpHttp(app, events);
  if (oauth) {
    try {
      await attachRemoteOAuth(app, oauth.issuer);
    } catch (error) {
      oauth.close();
      await app.close();
      throw error;
    }
  }
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
    oauth?.close();
  });
  return { app, events, oauth: oauth?.issuer ?? null };
}
