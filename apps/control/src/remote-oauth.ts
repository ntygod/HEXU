import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../../../packages/db/src/store.js';
import { DomainError } from '../../../packages/contracts/src/index.js';
import {
  createOAuthIssuer,
  OAUTH_PATH,
  type OAuthIssuer,
  type OAuthIssuerOptions,
} from '../../../packages/identity/src/oauth.js';
import { OAUTH_PAGE_CSS } from '../../../packages/identity/src/oauth-pages.js';

export interface RemoteOAuthOptions {
  identityDatabasePath: string;
  identitySecret: string;
  client: OAuthIssuerOptions['client'];
}

/** A separate handle over the already provisioned identity database, never a new account store. */
export async function openRemoteOAuth(store: Store, origin: string, options: RemoteOAuthOptions) {
  if (!isAbsolute(options.identityDatabasePath) || options.identitySecret.length < 32)
    throw new Error(
      'OAuth requires an existing absolute identity database path and its identity secret',
    );
  const stat = statSync(options.identityDatabasePath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('OAuth identity database must be a private regular file');
  const business = store.db
    .prepare('PRAGMA database_list')
    .all()
    .find((r) => r.name === 'main');
  if (business?.file) {
    const other = statSync(String(business.file));
    if (stat.dev === other.dev && stat.ino === other.ino)
      throw new Error('Identity and business databases must remain separate');
  }
  const db = new DatabaseSync(options.identityDatabasePath);
  try {
    // Read before migration: a missing or empty identity store must never be silently initialized.
    if (
      !db.prepare('SELECT 1 FROM "user" LIMIT 1').get() ||
      !db.prepare('SELECT 1 FROM account LIMIT 1').get()
    )
      throw new Error('OAuth requires existing invited accounts');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const issuer = await createOAuthIssuer(db, options.identitySecret, {
      origin,
      resource: origin + '/collaboration/mcp',
      client: options.client,
      receiverDatabase: store.db,
    });
    return { issuer, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

// Protected-resource suffix is owned by the MCP adapter; do not register it twice.
const issuerRoutes = [
  ['GET', '/.well-known/oauth-authorization-server' + OAUTH_PATH],
  ['GET', OAUTH_PATH + '/.well-known/oauth-authorization-server'],
  ['GET', '/.well-known/oauth-protected-resource'],
  ['GET', OAUTH_PATH + '/jwks'],
  ['GET', OAUTH_PATH + '/sign-in'],
  ['POST', OAUTH_PATH + '/sign-in'],
  ['GET', OAUTH_PATH + '/oauth2/authorize'],
  ['GET', OAUTH_PATH + '/consent'],
  ['POST', OAUTH_PATH + '/consent'],
  ['POST', OAUTH_PATH + '/oauth2/token'],
  ['GET', OAUTH_PATH + '/receiver-bindings'],
  ['POST', OAUTH_PATH + '/receiver-binding/revoke'],
  ['GET', OAUTH_PATH + '/tokens.css'],
  ['GET', OAUTH_PATH + '/pages.css'],
] as const;
export const isRemoteOAuthPath = (path: string, method: string) =>
  issuerRoutes.some(([m, p]) => m === method && p === path);
export const isOAuthBrowserPath = (path: string) =>
  [
    '/sign-in',
    '/consent',
    '/oauth2/authorize',
    '/receiver-bindings',
    '/receiver-binding/revoke',
    '/tokens.css',
    '/pages.css',
  ].some((p) => path === OAUTH_PATH + p);

/** Encapsulated raw-body adapter: Fastify must not parse and reserialize signed/form requests. */
export async function attachRemoteOAuth(app: FastifyInstance, issuer: OAuthIssuer) {
  const origin = new URL(issuer.issuer).origin;
  // Compiled server lives in dist/apps/control/src; the canonical runtime token source is shipped
  // with this repository. Missing assets fail startup rather than returning an unstyled auth page.
  const tokens = readFileSync(
    new URL('../../../../packages/ui/src/tokens.css', import.meta.url),
    'utf8',
  ).replace(
    ":root[data-theme='light'],",
    ":root[data-theme='light'],\n:root:has(#oauth-light:checked),",
  );
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 16384 }, (_req, body, done) =>
      done(null, body),
    );
    scope.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'POST') return;
      const timer = setTimeout(() => {
        if (reply.sent) return;
        reply.header('Connection', 'close').code(408).send({ error: 'invalid_request' });
        reply.raw.once('finish', () => req.raw.destroy());
      }, 5000);
      timer.unref();
      req.raw.once('end', () => clearTimeout(timer));
      req.raw.once('close', () => clearTimeout(timer));
      reply.raw.once('finish', () => clearTimeout(timer));
    });
    scope.setErrorHandler((error, _req, reply) => {
      const status =
        error instanceof DomainError
          ? error.status
          : (error as { statusCode?: number }).statusCode === 413
            ? 413
            : 400;
      return reply.code(status).send({ error: 'invalid_request' });
    });
    for (const [method, url] of issuerRoutes)
      scope.route({
        method,
        url,
        bodyLimit: 16384,
        handler: async (req, reply) => {
          if (url.endsWith('.css')) {
            if (req.url !== url) return reply.code(400).send({ error: 'invalid_request' });
            return reply
              .type('text/css; charset=utf-8')
              .send(url.endsWith('/tokens.css') ? tokens : OAUTH_PAGE_CSS);
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          const response = await issuer.handler(
            new Request(origin + req.url, {
              method,
              headers,
              ...(method === 'POST' ? { body: req.body as Buffer | undefined } : {}),
            }),
          );
          reply.code(response.status);
          response.headers.forEach((value, name) => {
            if (name !== 'set-cookie') reply.header(name, value);
          });
          const cookies = response.headers.getSetCookie();
          if (cookies.length) reply.header('Set-Cookie', cookies);
          return reply.send(Buffer.from(await response.arrayBuffer()));
        },
      });
  });
}

/** No files are touched unless the explicit flag is 1. Client metadata is local configuration,
 * not registration: starting the service never creates or changes an OAuth client. */
export function remoteOAuthFromEnvironment(env: NodeJS.ProcessEnv): RemoteOAuthOptions | undefined {
  if (
    env.HEXU_COLLABORATION_OAUTH_ENABLED === undefined ||
    env.HEXU_COLLABORATION_OAUTH_ENABLED === '0'
  )
    return undefined;
  if (env.HEXU_COLLABORATION_OAUTH_ENABLED !== '1') throw new Error('Invalid OAuth opt-in flag');
  const required = (name: string) => {
    if (!env[name]) throw new Error(`${name} is required`);
    return env[name]!;
  };
  const identityDatabasePath = required('HEXU_COLLABORATION_IDENTITY_DATABASE');
  const secretFile = required('HEXU_COLLABORATION_IDENTITY_SECRET_FILE');
  const stat = statSync(secretFile);
  if (!isAbsolute(secretFile) || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096)
    throw new Error('Existing identity secret must be a private bounded file');
  const identitySecret = readFileSync(secretFile, 'utf8').trim();
  let client: RemoteOAuthOptions['client'];
  try {
    client = JSON.parse(required('HEXU_COLLABORATION_OAUTH_CLIENT'));
  } catch {
    throw new Error('Explicit OAuth public client JSON is required');
  }
  if (
    !client ||
    typeof client.id !== 'string' ||
    typeof client.name !== 'string' ||
    !Array.isArray(client.redirectUris) ||
    !client.redirectUris.every((v) => typeof v === 'string') ||
    Object.keys(client).some((k) => !['id', 'name', 'redirectUris'].includes(k))
  )
    throw new Error('Invalid OAuth public client configuration');
  return { identityDatabasePath, identitySecret, client };
}
