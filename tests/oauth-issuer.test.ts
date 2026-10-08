import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { mock } from 'node:test';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { createIdentity } from '../packages/identity/src/index.js';
import {
  OAUTH_PATH,
  OAUTH_SCOPES,
  validateOAuthIssuerOptions,
} from '../packages/identity/src/oauth.js';

let networkCalls = 0;
test.before(() => {
  mock.method(globalThis, 'fetch', async () => {
    networkCalls++;
    throw new Error('OAuth fixture forbids network');
  });
});
test.after(() => {
  mock.restoreAll();
  assert.equal(networkCalls, 0);
});

const origin = 'https://hexu.example.invalid';
const resource = origin + '/collaboration/mcp';
const issuer = origin + OAUTH_PATH;
const redirect = 'https://fixture.example.invalid/callback';
const local = 'http://127.0.0.1:4310';
const account = {
  name: 'Fictional member',
  email: 'fixture@example.invalid',
  password: 'Fictional Password 2026!',
};
const oauthOptions = {
  origin,
  resource,
  client: { id: 'fixture-public', name: 'Fixture public client', redirectUris: [redirect] },
};
const headers = (cookie = '') =>
  new Headers({ cookie, origin, 'content-type': 'application/json' });
const cookie = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
async function fixture(provision = true) {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-oauth-test-'));
  const path = join(dir, 'identity.sqlite');
  const options = {
    databasePath: path,
    secret: 'fictional-identity-secret-not-real-0123456789',
    setupCode: 'fictional-setup-code-not-real-0123456789',
    baseURL: local,
    trustedOrigins: [local],
    oauth: oauthOptions,
  };
  const beforeMigration = await createIdentity({ ...options, oauth: undefined });
  const setup = await beforeMigration.setup(
    options.setupCode,
    account,
    new Headers({ origin: local, 'content-type': 'application/json' }),
  );
  beforeMigration.close();
  const identity = await createIdentity(options);
  const oauth = identity.oauth!;
  const db = new DatabaseSync(path);
  const call = (path: string, opts: RequestInit = {}) =>
    oauth.handler(new Request(origin + path, opts));
  const login = async () => {
    const r = await call(OAUTH_PATH + '/sign-in', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.clone().json(), { ok: true });
    return r;
  };
  const loginResponse = await login(),
    sessionHeaders = headers(cookie(loginResponse));
  if (provision) await oauth.provisionConfiguredClient(sessionHeaders);
  const authorize = async (overrides: Record<string, string> = {}, h = sessionHeaders) => {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: oauthOptions.client.id,
      redirect_uri: redirect,
      response_type: 'code',
      resource,
      scope: OAUTH_SCOPES.join(' '),
      state: randomBytes(16).toString('hex'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...overrides,
    });
    const response = await call(OAUTH_PATH + '/oauth2/authorize?' + query, { headers: h });
    return { response, verifier, query };
  };
  const interaction = async (overrides: Record<string, string> = {}) => {
    const a = await authorize(overrides);
    assert.equal(a.response.status, 302);
    const url = new URL(a.response.headers.get('location')!);
    assert.equal(url.origin + url.pathname, issuer + '/consent');
    const response = await oauth.handler(new Request(url, { headers: sessionHeaders }));
    assert.equal(response.status, 200);
    const view = await response.json();
    return { ...a, url, view, oauthQuery: url.search.slice(1) };
  };
  const consent = async (
    i: Awaited<ReturnType<typeof interaction>>,
    scopes: string[] = [...OAUTH_SCOPES],
    accept = true,
    h = sessionHeaders,
  ) =>
    call(OAUTH_PATH + '/consent', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        consentId: i.view.consentId,
        oauthQuery: i.oauthQuery,
        accept,
        scopes,
      }),
    });
  const code = async (scopes: string[] = [...OAUTH_SCOPES]) => {
    const i = await interaction();
    const r = await consent(i, scopes);
    assert.equal(r.status, 200, await r.clone().text());
    const result = await r.json();
    const callback = new URL(result.url);
    assert.equal(callback.origin + callback.pathname, redirect);
    assert.equal(callback.searchParams.get('state'), i.query.get('state'));
    assert.equal(callback.searchParams.get('iss'), issuer);
    assert.ok(callback.searchParams.get('code'));
    return { ...i, code: callback.searchParams.get('code')! };
  };
  const exchange = (
    i: { code: string; verifier: string },
    overrides: Record<string, string> = {},
  ) =>
    call(OAUTH_PATH + '/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: oauthOptions.client.id,
        redirect_uri: redirect,
        code: i.code,
        code_verifier: i.verifier,
        resource,
        ...overrides,
      }),
    });
  return {
    dir,
    path,
    options,
    identity,
    oauth,
    db,
    call,
    login,
    loginResponse,
    setup,
    sessionHeaders,
    authorize,
    interaction,
    consent,
    code,
    exchange,
    async close() {
      db.close();
      identity.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('OAuth stays opt-in; existing loopback identity schema and guard remain unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-oauth-default-'));
  const options = {
    databasePath: join(dir, 'identity.sqlite'),
    secret: 'fictional-default-secret-0123456789012345',
    setupCode: 'fictional-setup-code-01234567890123456789',
    baseURL: local,
    trustedOrigins: [local],
  };
  const i = await createIdentity(options);
  try {
    assert.equal(i.oauth, null);
    const db = new DatabaseSync(options.databasePath);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'oauth%' OR name='jwks' OR name='hexu_oauth_interactions'",
        )
        .get()!.n,
      0,
    );
    db.close();
    await assert.rejects(createIdentity({ ...options, baseURL: origin }), /本机/);
  } finally {
    i.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('official SQLite migration reuses existing invited users/accounts and is idempotent', async () => {
  const f = await fixture();
  try {
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM "user"').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM account').get()!.n, 1);
    const names = f.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const name of [
      'oauthClient',
      'oauthClientResource',
      'oauthResource',
      'oauthConsent',
      'oauthAccessToken',
      'oauthRefreshToken',
      'oauthClientAssertion',
      'jwks',
      'hexu_oauth_interactions',
    ])
      assert.ok(names.includes(name), name);
    const current = await f.identity.current(new Headers({ cookie: cookie(f.setup.response) }));
    assert.equal(current?.user.id, f.setup.user.id);
    const next = await createIdentity(f.options);
    try {
      assert.equal(
        (await next.current(new Headers({ cookie: cookie(f.setup.response) })))?.user.id,
        f.setup.user.id,
      );
      assert.deepEqual(await next.oauth!.provisionConfiguredClient(f.sessionHeaders), {
        clientId: oauthOptions.client.id,
      });
    } finally {
      next.close();
    }
  } finally {
    await f.close();
  }
});

test('discovery truthfully advertises pinned public-client authorization-code + S256 only', async () => {
  const f = await fixture(false);
  try {
    const meta = await f.call('/.well-known/oauth-authorization-server' + OAUTH_PATH);
    assert.equal(meta.status, 200);
    const m = await meta.json();
    assert.equal(m.issuer, issuer);
    assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(m.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(m.grant_types_supported, ['authorization_code']);
    for (const field of [
      'registration_endpoint',
      'client_id_metadata_document_supported',
      'userinfo_endpoint',
      'introspection_endpoint',
      'revocation_endpoint',
      'backchannel_logout_supported',
    ])
      assert.ok(!m[field], field);
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/collaboration/mcp',
    ]) {
      const r = await f.call(path);
      assert.equal(r.status, 200);
      const v = await r.json();
      assert.equal(v.resource, resource);
      assert.deepEqual(v.authorization_servers, [issuer]);
      assert.deepEqual(v.scopes_supported, [...OAUTH_SCOPES]);
      assert.deepEqual(v.bearer_methods_supported, ['header']);
    }
    assert.deepEqual(
      await (await f.call(OAUTH_PATH + '/.well-known/oauth-authorization-server')).json(),
      m,
    );
    const jwks = await (await f.call(OAUTH_PATH + '/jwks')).json();
    assert.ok(jwks.keys.length);
    assert.ok(jwks.keys.every((k: Record<string, unknown>) => !k.d));
    assert.equal((await f.authorize()).response.status, 503);
    await assert.rejects(f.oauth.provisionConfiguredClient(headers()));
  } finally {
    await f.close();
  }
});

test('HTTP allowlist excludes signup, registration, human/receiver APIs and raw provider endpoints', async () => {
  const f = await fixture();
  try {
    for (const path of [
      '/api/v1/identity/setup',
      '/api/v1/tasks',
      '/agent-receiver/v1/requests',
      '/collaboration/mcp',
      OAUTH_PATH + '/sign-up/email',
      OAUTH_PATH + '/oauth2/register',
      OAUTH_PATH + '/oauth2/create-client',
      OAUTH_PATH + '/admin/oauth2/create-client',
      OAUTH_PATH + '/hexu/consent-context',
      OAUTH_PATH + '/oauth2/consent',
      OAUTH_PATH + '/oauth2/revoke',
      OAUTH_PATH + '/token',
    ]) {
      for (const method of ['GET', 'POST'])
        assert.equal(
          (
            await f.call(path, {
              method,
              headers: f.sessionHeaders,
              body: method === 'POST' ? '{}' : undefined,
            })
          ).status,
          404,
          path,
        );
    }
    assert.equal(
      (
        await f.call(OAUTH_PATH + '/sign-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call('/.well-known/oauth-protected-resource', {
          headers: { 'x-forwarded-host': 'evil.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.oauth.handler(
          new Request('http://hexu.example.invalid/.well-known/oauth-protected-resource'),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(OAUTH_PATH + '/sign-in', {
          method: 'POST',
          headers: headers(),
          body: 'x'.repeat(16385),
        })
      ).status,
      413,
    );
    const c = f.loginResponse.headers.getSetCookie().join(';');
    assert.match(c, /HttpOnly/);
    assert.match(c, /Secure/);
    assert.match(c, /SameSite=Lax/i);
    assert.match(c, /Path=\/collaboration-auth/);
  } finally {
    await f.close();
  }
});

test('local identity cookies including renamed cookies cannot authorize the isolated issuer', async () => {
  const f = await fixture();
  try {
    const localCookie = cookie(f.setup.response);
    for (const value of [
      localCookie,
      localCookie.replace('hexu-team.session_token', '__Secure-hexu-oauth.session_token'),
    ]) {
      const a = await f.authorize({}, headers(value));
      assert.equal(a.response.status, 302);
      assert.equal(new URL(a.response.headers.get('location')!).pathname, OAUTH_PATH + '/sign-in');
      await assert.rejects(f.oauth.provisionConfiguredClient(headers(value)));
    }
    assert.equal(await f.identity.current(new Headers({ cookie: cookie(f.loginResponse) })), null);
    assert.equal(
      await f.identity.current(
        new Headers({
          cookie: cookie(f.loginResponse).replace(
            '__Secure-hexu-oauth.session_token',
            'hexu-team.session_token',
          ),
        }),
      ),
      null,
    );
  } finally {
    await f.close();
  }
});

test('authorize requires exact client/HTTPS redirect/resource, mandatory S256 and bounded known scopes', async () => {
  const f = await fixture();
  try {
    const invalidAuthorization: Record<string, string>[] = [
      { client_id: 'other' },
      { redirect_uri: redirect + '/' },
      { redirect_uri: 'https://evil.invalid/callback' },
      { resource: '' },
      { resource: resource + '/' },
      { code_challenge_method: 'plain' },
      { code_challenge: '' },
      { response_type: 'token' },
      { scope: 'hexu:respond' },
      { scope: 'openid' },
      { scope: 'hexu:material_read admin' },
      { scope: 'hexu:material_read hexu:material_read' },
      { state: '' },
      { request_uri: 'https://evil.invalid/request' },
      { a: 'b,c', 'a,b': 'c' },
      { prompt: 'none' },
    ];
    for (const bad of invalidAuthorization)
      assert.equal((await f.authorize(bad)).response.status, 400, JSON.stringify(bad));
    const a = await f.authorize();
    assert.equal(
      (
        await f.call(
          OAUTH_PATH + '/oauth2/authorize?' + a.query + '&resource=' + encodeURIComponent(resource),
          { headers: f.sessionHeaders },
        )
      ).status,
      400,
    );
    for (const patch of [
      { origin: 'http://hexu.example.invalid' },
      { resource: 'https://other.example.invalid/collaboration/mcp' },
      { client: { ...oauthOptions.client, redirectUris: ['http://127.0.0.1:8000/callback'] } },
      { client: { ...oauthOptions.client, redirectUris: ['https://*.example.invalid/callback'] } },
    ])
      assert.throws(() => validateOAuthIssuerOptions({ ...oauthOptions, ...patch }));
  } finally {
    await f.close();
  }
});

test('real library consent and PKCE mint signed short-lived, resource-bound token for existing subject only', async () => {
  const f = await fixture();
  try {
    const i = await f.code(['hexu:material_read']);
    const r = await f.exchange(i);
    assert.equal(r.status, 200, await r.clone().text());
    const token = await r.json();
    assert.equal(token.token_type, 'Bearer');
    assert.equal(token.refresh_token, undefined);
    const jwks = await (await f.call(OAUTH_PATH + '/jwks')).json();
    const verify = (overrides = {}) =>
      verifyJwsAccessToken(token.access_token, {
        jwksFetch: async () => jwks,
        verifyOptions: { issuer, audience: resource, ...overrides },
      });
    const claims = await verify();
    assert.equal(claims.sub, f.setup.user.id);
    assert.equal(claims.client_id, oauthOptions.client.id);
    assert.equal(claims.scope, 'hexu:material_read');
    assert.equal(claims.exp! - claims.iat!, 300);
    for (const k of [
      'ownerUserId',
      'participantId',
      'connectionId',
      'projectId',
      'taskId',
      'email',
      'name',
    ])
      assert.equal(claims[k], undefined);
    await assert.rejects(verify({ issuer: 'https://other.example.invalid' }));
    await assert.rejects(verify({ audience: resource + '/wrong' }));
    await assert.rejects(verify({ currentDate: new Date((claims.exp! + 1) * 1000) }));
    const altered = token.access_token.slice(0, -12) + 'AAAAAAAAAAAA';
    await assert.rejects(
      verifyJwsAccessToken(altered, {
        jwksFetch: async () => jwks,
        verifyOptions: { issuer, audience: resource },
      }),
    );
    const replay = await f.exchange(i);
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: 'invalid_grant' });
  } finally {
    await f.close();
  }
});

test('code exchange rejects wrong PKCE/resource/client/redirect; concurrent reuse issues at most once', async () => {
  const f = await fixture();
  try {
    const bad = await f.code();
    const wrong = await f.exchange(bad, { code_verifier: 'b'.repeat(43) });
    assert.equal(wrong.status, 401);
    assert.equal((await f.exchange(bad)).status, 400);
    const good = await f.code();
    const invalidExchange: Record<string, string>[] = [
      { resource: resource + '/other' },
      { client_id: 'other' },
      { redirect_uri: redirect + '/other' },
      { grant_type: 'refresh_token' },
    ];
    for (const override of invalidExchange)
      assert.equal((await f.exchange(good, override)).status, 400);
    const responses = await Promise.all([f.exchange(good), f.exchange(good)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
    const noResource = await f.code();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauthOptions.client.id,
      redirect_uri: redirect,
      code: noResource.code,
      code_verifier: noResource.verifier,
    });
    const r = await f.call(OAUTH_PATH + '/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    assert.equal(r.status, 200);
    assert.equal(
      JSON.parse(Buffer.from((await r.json()).access_token.split('.')[1], 'base64url').toString())
        .aud,
      resource,
    );
  } finally {
    await f.close();
  }
});

test('consent signed query, nonce and exact session bind; no cross-session acceptance or body identity', async () => {
  const f = await fixture();
  try {
    const i = await f.interaction();
    const other = headers(cookie(await f.login()));
    assert.equal((await f.oauth.handler(new Request(i.url, { headers: other }))).status, 409);
    assert.equal((await f.consent(i, [...OAUTH_SCOPES], true, other)).status, 409);
    const bad = new URL(i.url);
    bad.searchParams.set('scope', 'hexu:material_read');
    assert.equal(
      (await f.oauth.handler(new Request(bad, { headers: f.sessionHeaders }))).status,
      400,
    );
    const extra = await f.call(OAUTH_PATH + '/consent', {
      method: 'POST',
      headers: f.sessionHeaders,
      body: JSON.stringify({
        consentId: i.view.consentId,
        oauthQuery: i.oauthQuery,
        accept: true,
        scopes: [...OAUTH_SCOPES],
        subject: f.setup.user.id,
      }),
    });
    assert.equal(extra.status, 400);
    assert.equal(
      (await f.consent({ ...i, view: { ...i.view, consentId: 'invented' } })).status,
      409,
    );
    assert.equal((await f.consent(i)).status, 200);
    assert.equal((await f.consent(i)).status, 409);
    const reordered = new URL(i.url);
    reordered.search = new URLSearchParams([...reordered.searchParams].reverse()).toString();
    assert.equal(
      (await f.oauth.handler(new Request(reordered, { headers: f.sessionHeaders }))).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test('explicit deny preserves state/issuer; scope selection cannot exceed signed request or omit read', async () => {
  const f = await fixture();
  try {
    const i = await f.interaction({ scope: 'hexu:material_read' });
    assert.equal((await f.consent(i, [...OAUTH_SCOPES])).status, 400);
    assert.equal((await f.consent(i, [])).status, 400);
    const denied = await f.consent(i, [], false);
    assert.equal(denied.status, 200);
    const url = new URL((await denied.json()).url);
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('state'), i.query.get('state'));
    assert.equal(url.searchParams.get('iss'), issuer);
    assert.equal(url.searchParams.get('code'), null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM oauthConsent').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('expired consent interaction and authorization code stay rejected without sleeps or real network', async (t) => {
  const f = await fixture();
  try {
    const i = await f.interaction();
    const c = await f.code();
    f.db
      .prepare('UPDATE hexu_oauth_interactions SET expires_at=? WHERE consumed_at IS NULL')
      .run(Date.now() - 1);
    assert.equal((await f.consent(i)).status, 409);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 121000 });
    assert.equal((await f.exchange(c)).status, 400);
    t.mock.timers.setTime(Date.now() + 600000);
    assert.equal(
      (await f.oauth.handler(new Request(i.url, { headers: f.sessionHeaders }))).status,
      400,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('a modified stored client fails closed instead of silently broadening configured access', async () => {
  const f = await fixture();
  try {
    f.db
      .prepare('UPDATE oauthClient SET skipConsent=1 WHERE clientId=?')
      .run(oauthOptions.client.id);
    assert.equal((await f.authorize()).response.status, 400);
    await assert.rejects(f.oauth.provisionConfiguredClient(f.sessionHeaders), /pinned contract/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM oauthConsent').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('code exchange also rejects a revoked issuer session without creating business credentials', async () => {
  const f = await fixture();
  try {
    const code = await f.code();
    f.db.prepare('DELETE FROM session WHERE userId=?').run(f.setup.user.id);
    const response = await f.exchange(code);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'agent_%'").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('PKCE requires RFC 7636 verifier entropy and alphabet even when a weak challenge hash matches', async () => {
  const f = await fixture();
  try {
    const weak = 'x';
    const i = await f.interaction({
      code_challenge: createHash('sha256').update(weak).digest('base64url'),
    });
    const consent = await f.consent(i);
    assert.equal(consent.status, 200);
    const code = new URL((await consent.json()).url).searchParams.get('code')!;
    assert.equal((await f.exchange({ code, verifier: weak })).status, 400);
    const good = await f.code();
    for (const verifier of ['', 'a'.repeat(42), 'a'.repeat(129), '!'.repeat(43), '汉'.repeat(43)])
      assert.equal((await f.exchange(good, { code_verifier: verifier })).status, 400);
    assert.equal((await f.exchange(good)).status, 200);
  } finally {
    await f.close();
  }
});
