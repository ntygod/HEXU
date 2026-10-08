import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { getOAuthProviderState } from '@better-auth/oauth-provider';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';

export const OAUTH_SCOPES = ['hexu:material_read', 'hexu:respond'] as const;
export const OAUTH_PATH = '/collaboration-auth';
/** Internal opt-in contract only. No CLI/env flag or listener mounts it in this delivery. */
export interface OAuthIssuerOptions {
  origin: string;
  resource: string;
  client: { id: string; name: string; redirectUris: string[] };
}
const queryDigest = (value: string) =>
  digest(
    JSON.stringify(
      [...new URLSearchParams(value).entries()].sort(([ak, av], [bk, bv]) =>
        ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
      ),
    ),
  );
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (status: number, error = 'invalid_request') =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
function httpsURL(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    value !== url.href ||
    !url.hostname.includes('.') ||
    url.hostname === 'localhost' ||
    /[\s*]/.test(value)
  )
    throw new Error(
      'OAuth requires an exact canonical HTTPS URL without credentials/query/fragment',
    );
  return url;
}
export function validateOAuthIssuerOptions(input: OAuthIssuerOptions): OAuthIssuerOptions {
  const origin = httpsURL(input.origin + (input.origin.endsWith('/') ? '' : '/'));
  if (origin.pathname !== '/' || input.origin !== origin.origin)
    throw new Error('OAuth origin must be an exact HTTPS origin');
  const resource = httpsURL(input.resource);
  if (resource.origin !== origin.origin || resource.pathname !== '/collaboration/mcp')
    throw new Error('OAuth resource must be the same-origin finite collaboration MCP endpoint');
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.client.id) ||
    !input.client.name.trim() ||
    input.client.name.length > 120 ||
    input.client.redirectUris.length < 1 ||
    input.client.redirectUris.length > 5 ||
    new Set(input.client.redirectUris).size !== input.client.redirectUris.length
  )
    throw new Error('A single explicitly configured public client is required');
  for (const redirect of input.client.redirectUris) httpsURL(redirect);
  return structuredClone(input);
}

/** Reuses existing Better Auth user/account records, with a distinct cookie signature namespace.
 * This is an OAuth protocol contract, not a receiver principal or permission to call MCP tools.
 * The caller owns the DB lifetime; creation never provisions a client or starts a listener.
 */
export async function createOAuthIssuer(
  db: DatabaseSync,
  identitySecret: string,
  input: OAuthIssuerOptions,
) {
  const options = validateOAuthIssuerOptions(input);
  const issuer = options.origin + OAUTH_PATH;
  const secret = createHmac('sha256', identitySecret)
    .update('hexu:isolated-oauth-issuer:v1:' + issuer)
    .digest('hex');
  const provisioning = new AsyncLocalStorage<boolean>();
  const auth = betterAuth({
    appName: 'HEXU collaboration OAuth',
    database: db,
    secret,
    baseURL: options.origin,
    basePath: OAUTH_PATH,
    trustedOrigins: [options.origin],
    disabledPaths: ['/token', '/sign-up/email'],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: { expiresIn: 3600, updateAge: 3600, cookieCache: { enabled: false } },
    advanced: {
      cookiePrefix: 'hexu-oauth',
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax', path: OAUTH_PATH },
      ipAddress: { ipAddressHeaders: [] },
    },
    rateLimit: {
      storage: 'database',
      enabled: true,
      window: 60,
      max: 60,
      customRules: { '/sign-in/email': { window: 60, max: 10 } },
    },
    telemetry: { enabled: false },
    logger: { disabled: true },
    plugins: [
      jwt(),
      {
        id: 'hexu-oauth-consent-contract',
        endpoints: {
          hexuConsentContext: createAuthEndpoint(
            '/hexu/consent-context',
            {
              method: 'POST',
              body: z.object({ oauth_query: z.string().min(1).max(12000) }),
              use: [sessionMiddleware],
            },
            async (ctx) => {
              // The provider before-hook verifies the signed query and expiry before this endpoint.
              const state = await getOAuthProviderState();
              if (!state?.query) throw new APIError('BAD_REQUEST');
              return {
                userId: ctx.context.session.user.id,
                sessionId: ctx.context.session.session.id,
                expiresAt: ctx.context.session.session.expiresAt,
              };
            },
          ),
        },
      },
      mcp({
        resource: options.resource,
        loginPage: `${issuer}/sign-in`,
        consentPage: `${issuer}/consent`,
        scopes: [...OAUTH_SCOPES],
        grantTypes: ['authorization_code'],
        accessTokenExpiresIn: 300,
        codeExpiresIn: 120,
        refreshTokenReuseInterval: 0,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        allowPublicClientPrelogin: false,
        enforcePerClientResources: true,
        clientPrivileges: ({ action }) => provisioning.getStore() === true && action === 'create',
        resourcePrivileges: () => false,
        generateClientId: () => {
          if (provisioning.getStore() !== true)
            throw new Error('Client provisioning is internal only');
          return options.client.id;
        },
      }),
    ],
  });
  // Separate from normal identity initialization: this schema is absent unless explicitly opted in.
  const migrations = await getMigrations(auth.options);
  db.exec('BEGIN IMMEDIATE');
  try {
    await migrations.runMigrations();
    db.exec(`CREATE TABLE IF NOT EXISTS hexu_oauth_interactions (
      query_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
      nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, query_expires_at INTEGER NOT NULL, consumed_at INTEGER
    )`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const session = (headers: Headers) =>
    auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
  const configuredClient = async () => {
    const row = await (
      await auth.$context
    ).adapter.findOne<Record<string, unknown>>({
      model: 'oauthClient',
      where: [{ field: 'clientId', value: options.client.id }],
    });
    if (!row) return false;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (
      row.disabled ||
      row.skipConsent ||
      row.clientSecret ||
      row.tokenEndpointAuthMethod !== 'none' ||
      row.requirePKCE !== true ||
      !same(row.redirectUris, options.client.redirectUris) ||
      !same(row.scopes, OAUTH_SCOPES) ||
      !same(row.grantTypes, ['authorization_code'])
    )
      throw new Error('Stored OAuth client no longer matches the pinned contract');
    return true;
  };
  const validQuery = (query: URLSearchParams, signed = false) => {
    const allowed = new Set([
      'client_id',
      'redirect_uri',
      'response_type',
      'resource',
      'scope',
      'state',
      'code_challenge',
      'code_challenge_method',
      'prompt',
      ...(signed ? ['sig', 'exp', 'ba_iat', 'ba_param'] : []),
    ]);
    if (
      [...query.keys()].some((key) => !allowed.has(key)) ||
      (query.has('prompt') && query.get('prompt') !== 'consent')
    )
      return false;
    for (const key of new Set(query.keys())) {
      if (!['ba_param'].includes(key) && query.getAll(key).length !== 1) return false;
    }
    const scopes = (query.get('scope') ?? '').split(' ');
    return (
      query.get('client_id') === options.client.id &&
      options.client.redirectUris.includes(query.get('redirect_uri') ?? '') &&
      query.get('response_type') === 'code' &&
      query.get('resource') === options.resource &&
      query.get('code_challenge_method') === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(query.get('code_challenge') ?? '') &&
      !!query.get('state') &&
      (query.get('state')?.length ?? 0) <= 512 &&
      scopes.length > 0 &&
      new Set(scopes).size === scopes.length &&
      scopes.includes('hexu:material_read') &&
      scopes.every((s) => OAUTH_SCOPES.includes(s as (typeof OAUTH_SCOPES)[number])) &&
      !['claims', 'request', 'request_uri', 'id_token_hint'].some((key) => query.has(key))
    );
  };
  async function consentView(request: Request, query: string) {
    if (!validQuery(new URLSearchParams(query), true)) return failure(400);
    const current = await auth.api.hexuConsentContext({
      headers: request.headers,
      body: { oauth_query: query },
    });
    const queryHash = queryDigest(query),
      now = Date.now(),
      params = new URLSearchParams(query);
    const expiresAt = Math.min(
      Number(params.get('exp')) * 1000,
      now + 120000,
      current.expiresAt.getTime(),
    );
    const nonce = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM hexu_oauth_interactions WHERE query_expires_at < ?').run(now);
    const row = db
      .prepare(
        'SELECT session_id, user_id, consumed_at FROM hexu_oauth_interactions WHERE query_hash=?',
      )
      .get(queryHash);
    if (
      row &&
      (row.session_id !== current.sessionId ||
        row.user_id !== current.userId ||
        row.consumed_at !== null)
    )
      return failure(409);
    db.prepare(
      `INSERT INTO hexu_oauth_interactions(query_hash,session_id,user_id,nonce_hash,expires_at,query_expires_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(query_hash) DO UPDATE SET nonce_hash=excluded.nonce_hash, expires_at=MIN(expires_at,excluded.expires_at)`,
    ).run(
      queryHash,
      current.sessionId,
      current.userId,
      digest(nonce),
      expiresAt,
      Number(params.get('exp')) * 1000,
    );
    return Response.json({
      view: 'consent',
      client: { id: options.client.id, name: options.client.name },
      resource: options.resource,
      redirectUri: params.get('redirect_uri'),
      scopes: params.get('scope')!.split(' '),
      consentId: nonce,
      expiresAt: new Date(expiresAt).toISOString(),
      businessAccess: 'not_bound',
    });
  }
  async function consent(request: Request) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      Object.keys(body).some((k) => !['consentId', 'oauthQuery', 'accept', 'scopes'].includes(k)) ||
      typeof body.oauthQuery !== 'string' ||
      typeof body.consentId !== 'string' ||
      typeof body.accept !== 'boolean' ||
      !Array.isArray(body.scopes) ||
      !body.scopes.every((s) => typeof s === 'string')
    )
      return failure(400);
    const query = body.oauthQuery;
    if (!validQuery(new URLSearchParams(query), true)) return failure(400);
    const requested = new URLSearchParams(query).get('scope')!.split(' ');
    const accepted = body.scopes as string[];
    if (
      new Set(accepted).size !== accepted.length ||
      accepted.some((s) => !requested.includes(s)) ||
      (body.accept && !accepted.includes('hexu:material_read'))
    )
      return failure(400, 'invalid_scope');
    const current = await auth.api.hexuConsentContext({
      headers: request.headers,
      body: { oauth_query: query },
    });
    const claim = db
      .prepare(
        `UPDATE hexu_oauth_interactions SET consumed_at=? WHERE query_hash=? AND
      session_id=? AND user_id=? AND nonce_hash=? AND expires_at>? AND consumed_at IS NULL`,
      )
      .run(
        Date.now(),
        queryDigest(query),
        current.sessionId,
        current.userId,
        digest(body.consentId),
        Date.now(),
      );
    if (claim.changes !== 1) return failure(409);
    // Fail closed after a claimed interaction: unknown/failure requires a new authorize request.
    return auth.handler(
      new Request(issuer + '/oauth2/consent', {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({
          accept: body.accept,
          oauth_query: query,
          ...(body.accept ? { scope: accepted.join(' ') } : {}),
        }),
      }),
    );
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    let forwarded = false;
    request.headers.forEach((_value, name) => {
      if (name.startsWith('x-forwarded-')) forwarded = true;
    });
    if (
      url.origin !== options.origin ||
      request.headers.has('forwarded') ||
      forwarded ||
      (request.headers.has('host') && request.headers.get('host') !== url.host)
    )
      return failure(403);
    if (request.headers.has('dpop')) return failure(400);
    if (request.url.length > 12000) return failure(414);
    const browser =
      path === `${issuer.slice(options.origin.length)}/consent` || path === OAUTH_PATH + '/sign-in';
    if (
      browser &&
      request.method === 'POST' &&
      (request.headers.get('origin') !== options.origin ||
        request.headers.get('content-type')?.split(';')[0] !== 'application/json' ||
        request.headers.has('authorization'))
    )
      return failure(403);
    if (
      browser &&
      request.headers.get('sec-fetch-site') === 'cross-site' &&
      request.method !== 'GET'
    )
      return failure(403);
    const metadata = new Set([
      '/.well-known/oauth-authorization-server' + OAUTH_PATH,
      OAUTH_PATH + '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/collaboration/mcp',
    ]);
    if (metadata.has(path) && request.method === 'GET' && !url.search) {
      const response = await auth.handler(request);
      if (!response.ok) return response;
      const value = await response.json();
      if (path.includes('oauth-authorization-server')) {
        // 1.7.6 omits public-client `none` unless DCR/CIMD is enabled. Our only client is public.
        value.token_endpoint_auth_methods_supported = ['none'];
        delete value.introspection_endpoint;
        delete value.introspection_endpoint_auth_methods_supported;
        delete value.end_session_endpoint;
        delete value.userinfo_endpoint;
        delete value.registration_endpoint;
        delete value.revocation_endpoint;
        delete value.revocation_endpoint_auth_methods_supported;
        delete value.revocation_endpoint_auth_signing_alg_values_supported;
        delete value.introspection_endpoint_auth_signing_alg_values_supported;
        delete value.token_endpoint_auth_signing_alg_values_supported;
        delete value.backchannel_logout_supported;
        delete value.backchannel_logout_session_supported;
        delete value.dpop_signing_alg_values_supported;
      }
      delete value.dpop_signing_alg_values_supported;
      return Response.json(value);
    }
    if (path === OAUTH_PATH + '/jwks' && request.method === 'GET' && !url.search)
      return auth.handler(request);
    if (path === OAUTH_PATH + '/sign-in' && request.method === 'GET')
      return Response.json({ view: 'sign-in', registration: 'existing_invited_account_only' });
    if (path === OAUTH_PATH + '/sign-in' && request.method === 'POST' && !url.search) {
      const body = await request.json().catch(() => null);
      if (
        !body ||
        Object.keys(body).some((k) => !['email', 'password'].includes(k)) ||
        typeof body.email !== 'string' ||
        typeof body.password !== 'string'
      )
        return failure(400);
      const response = await auth.handler(
        new Request(issuer + '/sign-in/email', {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(body),
        }),
      );
      const headers = new Headers();
      for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
      // No raw session token or user record in browser-readable JSON.
      return Response.json(response.ok ? { ok: true } : { error: 'login_failed' }, {
        status: response.status,
        headers,
      });
    }
    if (
      ![
        'GET ' + OAUTH_PATH + '/oauth2/authorize',
        'GET ' + OAUTH_PATH + '/consent',
        'POST ' + OAUTH_PATH + '/consent',
        'POST ' + OAUTH_PATH + '/oauth2/token',
      ].includes(request.method + ' ' + path)
    )
      return failure(404, 'not_found');
    if (!(await configuredClient())) return failure(503, 'client_not_provisioned');
    if (path === OAUTH_PATH + '/oauth2/authorize' && request.method === 'GET') {
      if (!validQuery(url.searchParams)) return failure(400);
      // Consent is explicit on every authorization, even if the library has a prior consent row.
      url.searchParams.set('prompt', 'consent');
      return auth.handler(new Request(url, request));
    }
    if (path === OAUTH_PATH + '/consent' && request.method === 'GET')
      return consentView(request, url.search.slice(1));
    if (path === OAUTH_PATH + '/consent' && request.method === 'POST' && !url.search)
      return consent(request);
    if (path === OAUTH_PATH + '/oauth2/token' && request.method === 'POST' && !url.search) {
      if (
        request.headers.has('cookie') ||
        request.headers.has('authorization') ||
        request.headers.has('origin') ||
        request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded'
      )
        return failure(400);
      const form = new URLSearchParams(await request.clone().text());
      const allowed = [
        'grant_type',
        'code',
        'client_id',
        'redirect_uri',
        'code_verifier',
        'resource',
      ];
      if (
        [...form.keys()].some((k) => !allowed.includes(k) || form.getAll(k).length !== 1) ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(form.get('code_verifier') ?? '') ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('client_id') !== options.client.id ||
        !options.client.redirectUris.includes(form.get('redirect_uri') ?? '') ||
        (form.has('resource') && form.get('resource') !== options.resource)
      )
        return failure(400);
      return auth.handler(request);
    }
    return failure(404, 'not_found');
  }
  return {
    issuer,
    resource: options.resource,
    /** Explicit operator-only provisioning: never exposed by handler; requires an existing issuer session.
     * Static public client metadata only; no client secret, DCR, CIMD, grant or receiver credential.
     */
    async provisionConfiguredClient(headers: Headers) {
      if (!(await session(headers)))
        throw new Error('Existing issuer session required for provisioning');
      if (await configuredClient()) return { clientId: options.client.id };
      await provisioning.run(true, () =>
        auth.api.adminCreateOAuthClient({
          headers,
          body: {
            client_name: options.client.name,
            redirect_uris: options.client.redirectUris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code'],
            response_types: ['code'],
            scope: OAUTH_SCOPES.join(' '),
            require_pkce: true,
            skip_consent: false,
          },
        }),
      );
      if (!(await configuredClient())) throw new Error('Client provisioning failed');
      return { clientId: options.client.id };
    },
    async handler(request: Request) {
      let response: Response;
      try {
        if (request.method === 'POST' && request.body) {
          const reader = request.body.getReader(),
            parts: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 16384) {
              await reader.cancel();
              return failure(413);
            }
            parts.push(chunk.value);
          }
          request = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: Buffer.concat(parts),
          });
        }
        response = await handle(request);
        if (response.status >= 400 && response.status < 500) {
          const body = await response
            .clone()
            .json()
            .catch(() => null);
          const allowed = [
            'invalid_request',
            'invalid_grant',
            'invalid_client',
            'invalid_scope',
            'unsupported_grant_type',
            'access_denied',
            'login_required',
            'not_found',
            'login_failed',
          ];
          const error = allowed.includes(body?.error) ? body.error : 'invalid_request';
          response = failure(response.status, error);
        }
      } catch {
        response = failure(400);
      }
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      return new Response(response.body, { status: response.status, headers });
    },
  };
}
export type OAuthIssuer = Awaited<ReturnType<typeof createOAuthIssuer>>;
