import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { mock } from 'node:test';
import { createRemoteCollaboration } from '../apps/control/src/remote-collaboration.js';
import { remoteOAuthFromEnvironment } from '../apps/control/src/remote-oauth.js';
import { MCP_PATH, MCP_VERSION } from '../apps/control/src/agent-mcp-http.js';
import { OAUTH_PATH, OAUTH_SCOPES } from '../packages/identity/src/oauth.js';
import {
  OAUTH_PAGE_CSS,
  renderOAuthConsent,
  renderOAuthSignIn,
  type OAuthConsentPageView,
} from '../packages/identity/src/oauth-pages.js';
import { requesterFixture, REQUESTER_HIDDEN } from './helpers/agent-requester.js';
import { cookies, PASSWORD } from './helpers/team.js';

const origin = 'https://hexu.example.invalid';
const host = new URL(origin).host;
const issuer = origin + OAUTH_PATH;
const resource = origin + MCP_PATH;
const metadataPath = '/.well-known/oauth-protected-resource' + MCP_PATH;
const redirect = 'https://fixture.example.invalid/callback';
const client = { id: 'fixture-public', name: 'Fictional remote client', redirectUris: [redirect] };
const scopes = [...OAUTH_SCOPES];
let dir: string;
let tls: { key: Buffer; cert: Buffer };
let networkCalls = 0;

test.before(async () => {
  mock.method(globalThis, 'fetch', async () => {
    networkCalls++;
    throw new Error('OAuth remote fixture forbids global fetch/network');
  });
  dir = await mkdtemp(join(tmpdir(), 'hexu-oauth-remote-'));
  // Disposable, one-day fixture trust root. HTTPS below connects only to 127.0.0.1,
  // validates this cert and uses a fictional SNI/Host; no real credential or public listener.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=' + host,
      '-addext',
      'subjectAltName=DNS:' + host,
    ],
    { stdio: 'ignore' },
  );
  tls = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
});
test.after(async () => {
  mock.restoreAll();
  if (dir) await rm(dir, { recursive: true, force: true });
  assert.equal(networkCalls, 0);
});

interface HttpResult {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json(): any;
}
interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}
type Send = (path: string, options?: HttpOptions) => Promise<HttpResult>;
const ok = (response: HttpResult, status = 200) => {
  assert.equal(response.statusCode, status, response.body);
  return response.json();
};
const relative = (url: string) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, origin, 'fixture must never follow an external redirect');
  return parsed.pathname + parsed.search;
};
const location = (response: HttpResult, status = 302) => {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(typeof response.headers.location, 'string');
  return String(response.headers.location);
};
const unescapeHTML = (value: string) =>
  value.replace(
    /&(?:amp|quot|lt|gt|#39);/g,
    (match) =>
      ({
        '&amp;': '&',
        '&quot;': '"',
        '&lt;': '<',
        '&gt;': '>',
        '&#39;': "'",
      })[match]!,
  );
const inputs = (html: string) =>
  [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => ({
    tag,
    attributes: Object.fromEntries(
      [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [
        name!,
        unescapeHTML(value!),
      ]),
    ),
  }));
const input = (html: string, name: string, type?: string) => {
  const found = inputs(html).find(
    ({ attributes: a }) => a.name === name && (!type || a.type === type),
  );
  assert.ok(found, 'Missing input ' + name);
  assert.equal(typeof found.attributes.value, 'string');
  return found.attributes.value!;
};
const authorization = () => {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirect,
    response_type: 'code',
    resource,
    scope: scopes.join(' '),
    state: 'fixture state & ' + randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return { verifier, query, path: OAUTH_PATH + '/oauth2/authorize?' + query };
};
const formHeaders = (cookie = '') => ({
  origin,
  accept: 'text/html',
  'content-type': 'application/x-www-form-urlencoded',
  'sec-fetch-site': 'same-origin',
  ...(cookie ? { cookie } : {}),
});

async function fixture({ enabled = true, provision = true } = {}) {
  const f = await requesterFixture();
  let remote: Awaited<ReturnType<typeof createRemoteCollaboration>> | undefined;
  let db: DatabaseSync | undefined;
  try {
    const issued = ok(
      await f.call(`agent-participants/${f.receiver.id}/receiver-connections`, f.bob, {
        projectId: f.project.id,
        capabilityId: f.target.capabilityId,
        capabilityVersion: 1,
        endpointRevision: 1,
        grantId: f.target.grantId,
        grantRevision: 1,
        scopes: ['material_read', 'respond'],
        expiresAt: f.expiresAt,
        receiveConfirmed: true,
      }),
      201,
    );
    remote = await createRemoteCollaboration({
      store: f.store,
      publicOrigin: origin,
      tls,
      encryptionKey: Buffer.alloc(32, 23),
      automaticDrain: false,
      ...(enabled
        ? {
            oauth: {
              identityDatabasePath: f.identityPath,
              identitySecret: f.options.secret,
              client,
            },
          }
        : {}),
    });
    const app = remote.app;
    const send: Send = async (path, options = {}) =>
      app.inject({
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        url: path,
        headers: { host, ...options.headers },
        ...(options.body === undefined ? {} : { payload: options.body }),
      });
    const login = async (email = f.bob.user.email) => {
      const response = await send(OAUTH_PATH + '/sign-in', {
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      assert.deepEqual(ok(response), { ok: true });
      return { response, cookie: cookies(response) };
    };
    let cookie = '';
    if (enabled) {
      cookie = (await login()).cookie;
      if (provision) await remote.oauth!.provisionConfiguredClient(new Headers({ origin, cookie }));
    }
    db = new DatabaseSync(f.identityPath);
    const listen = async (): Promise<Send> => {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      return (path, options = {}) =>
        new Promise((resolve, reject) => {
          const req = httpsRequest(
            {
              hostname: '127.0.0.1',
              port: address.port,
              path,
              method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
              servername: host,
              ca: tls.cert,
              headers: { host, ...options.headers },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () =>
                resolve({
                  statusCode: res.statusCode!,
                  headers: res.headers,
                  body,
                  json: () => JSON.parse(body),
                }),
              );
              res.on('error', reject);
            },
          );
          req.on('error', reject);
          req.setTimeout(10000, () => req.destroy(new Error('Fixture HTTPS deadline')));
          req.end(options.body);
        });
    };
    return {
      ...f,
      remote,
      db,
      issuedReceiver: issued,
      send,
      login,
      cookie,
      listen,
      async close() {
        await app.close();
        db!.close();
        await f.close();
      },
    };
  } catch (error) {
    if (remote) await remote.app.close();
    db?.close();
    await f.close();
    throw error;
  }
}

async function htmlConsent(send: Send, cookie: string) {
  const auth = authorization();
  const authorized = await send(auth.path, { headers: { cookie, accept: 'text/html' } });
  const url = new URL(location(authorized));
  assert.equal(url.origin + url.pathname, issuer + '/consent');
  const view = await send(relative(url.href), { headers: { cookie, accept: 'text/html' } });
  assert.equal(view.statusCode, 200, view.body);
  assert.match(String(view.headers['content-type']), /^text\/html/);
  return {
    ...auth,
    html: view.body,
    oauthQuery: input(view.body, 'oauthQuery'),
    consentId: input(view.body, 'consentId'),
  };
}
function consentForm(view: Awaited<ReturnType<typeof htmlConsent>>, accept = true) {
  const body = new URLSearchParams({
    oauthQuery: view.oauthQuery,
    consentId: view.consentId,
    accept: String(accept),
  });
  body.append('scopes', 'hexu:material_read');
  if (accept) {
    body.append('scopes', 'hexu:respond');
    body.set('receiver', input(view.html, 'receiver', 'radio'));
  }
  return body.toString();
}
const exchange = (send: Send, code: string, verifier: string, extra: Record<string, string> = {}) =>
  send(OAUTH_PATH + '/oauth2/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.id,
      redirect_uri: redirect,
      resource,
      ...extra,
    }).toString(),
  });
const mcp = (
  send: Send,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  path = MCP_PATH,
) =>
  send(path, {
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_VERSION,
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_VERSION,
          'io.modelcontextprotocol/clientCapabilities': { events: {} },
        },
      },
    }),
  });

test('remote OAuth remains default-off and preserves the legacy receiver and local host boundaries', async () => {
  const f = await fixture({ enabled: false });
  try {
    assert.equal(f.remote.oauth, null);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name LIKE 'oauth%' OR name='jwks' OR name='hexu_oauth_interactions'",
        )
        .get()!.n,
      0,
    );
    for (const path of [
      metadataPath,
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server' + OAUTH_PATH,
      OAUTH_PATH + '/sign-in',
      OAUTH_PATH + '/tokens.css',
    ]) {
      assert.equal((await f.send(path)).statusCode, 404, path);
    }
    assert.equal(
      (
        await f.send('/agent-requester/v1/identity', {
          headers: {
            authorization: 'Bearer ' + f.issued.token,
            'x-hexu-agent-api': '1',
          },
        })
      ).statusCode,
      200,
    );
    assert.equal((await mcp(f.send, null, 'tools/list')).statusCode, 401);
    const legacy = ok(await mcp(f.send, f.issuedReceiver.token, 'tools/list'));
    assert.equal(legacy.error, undefined);
    assert.ok(legacy.result.tools.length > 0);
    assert.equal(
      legacy.result.tools.some((tool: any) => tool.securitySchemes),
      false,
    );
    assert.equal(f.app.hasRoute({ method: 'GET', url: metadataPath }), false);
    assert.equal(f.app.hasRoute({ method: 'POST', url: OAUTH_PATH + '/sign-in' }), false);
    assert.equal(
      (await f.app.inject({ url: '/api/v1/identity', headers: { host, cookie: f.bob.cookie } }))
        .statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test('explicit startup reuses identity and business mapping but never provisions a public client', async () => {
  const f = await fixture({ provision: false });
  try {
    assert.equal(f.remote.oauth!.resourceServer!.database, f.store.db);
    assert.deepEqual(
      f.db
        .prepare('SELECT id FROM "user" ORDER BY id')
        .all()
        .map((row) => row.id),
      [f.alice.user.id, f.bob.user.id].sort(),
    );
    assert.equal(f.db.prepare('SELECT count(*) n FROM account').get()!.n, 2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM oauthClient').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM hexu_oauth_receiver_bindings').get()!.n, 0);
    assert.equal(
      (await f.send(authorization().path, { headers: { cookie: f.cookie } })).statusCode,
      503,
    );
    assert.equal((await exchange(f.send, 'fixture-no-code', 'a'.repeat(43))).statusCode, 503);
    assert.equal(f.db.prepare('SELECT count(*) n FROM oauthClient').get()!.n, 0);
    const metadata = ok(await f.send('/.well-known/oauth-authorization-server' + OAUTH_PATH));
    assert.equal(metadata.issuer, issuer);
    assert.equal(metadata.authorization_endpoint, issuer + '/oauth2/authorize');
    assert.equal(metadata.token_endpoint, issuer + '/oauth2/token');
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.grant_types_supported, ['authorization_code']);
    assert.equal(metadata.registration_endpoint, undefined);
    const protectedResource = ok(await f.send(metadataPath));
    assert.equal(protectedResource.resource, resource);
    assert.deepEqual(protectedResource.authorization_servers, [issuer]);
    await f.remote.oauth!.provisionConfiguredClient(new Headers({ origin, cookie: f.cookie }));
    assert.equal(f.db.prepare('SELECT count(*) n FROM oauthClient').get()!.n, 1);
    const local = await f.app.inject({
      url: '/api/v1/identity',
      headers: { cookie: f.bob.cookie },
    });
    assert.equal(ok(local).user.id, f.bob.user.id, 'existing local session still authenticates');
  } finally {
    await f.close();
  }
});

test('loopback HTTPS executes native HTML login, signed return, consent, raw PKCE token exchange and finite MCP', async () => {
  const f = await fixture();
  try {
    const send = await f.listen();
    const auth = authorization();
    const signIn = new URL(location(await send(auth.path, { headers: { accept: 'text/html' } })));
    assert.equal(signIn.origin + signIn.pathname, issuer + '/sign-in');
    assert.ok(signIn.searchParams.get('sig'));
    const page = await send(relative(signIn.href), { headers: { accept: 'text/html' } });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(String(page.headers['content-type']), /^text\/html/);
    assert.match(page.body, /<form method="post" action="\/collaboration-auth\/sign-in"/);
    assert.match(page.body, /autocomplete="current-password"/);
    assert.match(String(page.headers['content-security-policy']), /form-action 'self'/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    const signedQuery = input(page.body, 'oauthQuery');
    assert.equal(
      signedQuery,
      signIn.search.slice(1),
      'HTML preserves the provider-signed query byte-for-byte',
    );
    // Programmatic form submission validates the HTTP contract, not a browser acceptance run.
    const login = await send(OAUTH_PATH + '/sign-in', {
      headers: formHeaders(),
      body: new URLSearchParams({
        email: f.bob.user.email,
        password: PASSWORD,
        oauthQuery: signedQuery,
      }).toString(),
    });
    const returned = new URL(location(login, 303));
    assert.equal(returned.origin + returned.pathname, issuer + '/oauth2/authorize');
    const expected = new URLSearchParams(auth.query);
    expected.set('prompt', 'consent');
    assert.deepEqual([...returned.searchParams].sort(), [...expected].sort());
    assert.equal(returned.searchParams.has('sig'), false);
    const setCookies = login.headers['set-cookie'];
    assert.ok(Array.isArray(setCookies) && setCookies.length > 0);
    for (const cookie of setCookies) {
      assert.equal(typeof cookie, 'string');
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /(?:^|;)\s*Secure(?:;|$)/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Path=\/collaboration-auth(?:;|$)/);
      assert.match(cookie, /^__Secure-hexu-oauth\./);
      assert.equal(
        (cookie.match(/__Secure-hexu-oauth\./g) ?? []).length,
        1,
        'each Set-Cookie is a separate header',
      );
    }
    const cookie = cookies(login);
    assert.equal(login.body.includes(PASSWORD), false);
    const localWithOAuthCookie = await f.app.inject({
      url: '/api/v1/identity',
      headers: { cookie },
    });
    assert.equal(
      ok(localWithOAuthCookie).user,
      null,
      'OAuth session cannot authenticate the local identity surface',
    );
    const consentURL = new URL(
      location(await send(relative(returned.href), { headers: { cookie, accept: 'text/html' } })),
    );
    assert.equal(consentURL.origin + consentURL.pathname, issuer + '/consent');
    const consentPage = await send(relative(consentURL.href), {
      headers: { cookie, accept: 'text/html' },
    });
    assert.equal(consentPage.statusCode, 200, consentPage.body);
    assert.ok(consentPage.body.includes(f.bob.user.email));
    assert.ok(consentPage.body.includes(f.project.id));
    assert.ok(consentPage.body.includes(f.issuedReceiver.credential.id));
    const view = {
      ...auth,
      html: consentPage.body,
      oauthQuery: input(consentPage.body, 'oauthQuery'),
      consentId: input(consentPage.body, 'consentId'),
    };
    assert.equal(f.db.prepare('SELECT count(*) n FROM hexu_oauth_receiver_bindings').get()!.n, 0);
    const approved = await send(OAUTH_PATH + '/consent', {
      headers: formHeaders(cookie),
      body: consentForm(view),
    });
    const callback = new URL(location(approved, 303));
    assert.equal(callback.origin + callback.pathname, redirect);
    assert.equal(callback.searchParams.get('state'), auth.query.get('state'));
    assert.equal(callback.searchParams.get('iss'), issuer);
    const code = callback.searchParams.get('code');
    assert.ok(code);
    assert.equal(
      (
        await send(OAUTH_PATH + '/consent', {
          headers: formHeaders(cookie),
          body: consentForm(view),
        })
      ).statusCode,
      409,
    );
    const token = ok(await exchange(send, code, auth.verifier));
    assert.equal(token.token_type, 'Bearer');
    assert.equal(token.refresh_token, undefined);
    assert.ok(token.expires_in > 0 && token.expires_in <= 300);
    const claims = JSON.parse(
      Buffer.from(token.access_token.split('.')[1], 'base64url').toString(),
    );
    assert.equal(claims.sub, f.bob.user.id);
    assert.equal(claims.iss, issuer);
    assert.equal(claims.aud, resource);
    const binding = f.db
      .prepare('SELECT subject, receiver FROM hexu_oauth_receiver_bindings WHERE id=?')
      .get(claims.hexu_binding)!;
    assert.equal(binding.subject, f.bob.user.id);
    assert.equal(JSON.parse(String(binding.receiver)).connectionId, f.issuedReceiver.credential.id);
    assert.equal(
      (await exchange(send, code, auth.verifier)).statusCode,
      400,
      'authorization code is single-use',
    );
    const discovery = ok(await mcp(send, null, 'tools/list'));
    assert.deepEqual(
      discovery.result.tools.map((tool: any) => tool.name),
      ['hexu_get_request', 'hexu_list_requests', 'hexu_read_materials', 'hexu_respond'],
    );
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const listed = await mcp(send, token.access_token, 'tools/call', {
      name: 'hexu_list_requests',
      arguments: {},
    });
    const items = ok(listed).result.structuredContent.items;
    assert.deepEqual(
      items.map((item: any) => item.requestId),
      [created.requestId],
    );
    for (const privateValue of [f.task.id, f.project.id, f.message.id, REQUESTER_HIDDEN])
      assert.equal(listed.body.includes(privateValue), false, privateValue);
    for (const headers of [{ cookie }, { origin }, { 'sec-fetch-site': 'same-origin' }] as Record<
      string,
      string
    >[]) {
      assert.equal(
        (await mcp(send, token.access_token, 'tools/list', {}, headers)).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await mcp(
          send,
          token.access_token,
          'tools/list',
          {},
          {},
          MCP_PATH + '?access_token=fixture',
        )
      ).statusCode,
      403,
    );
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM runs').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('HTML denial and failed PKCE stay single-use without granting extra receiver authority', async () => {
  const f = await fixture();
  try {
    const deniedView = await htmlConsent(f.send, f.cookie);
    assert.match(deniedView.html, /value="false" formnovalidate/);
    const denied = await f.send(OAUTH_PATH + '/consent', {
      headers: formHeaders(f.cookie),
      body: consentForm(deniedView, false),
    });
    const callback = new URL(location(denied, 303));
    assert.equal(callback.origin + callback.pathname, redirect);
    assert.equal(callback.searchParams.get('error'), 'access_denied');
    assert.equal(callback.searchParams.get('state'), deniedView.query.get('state'));
    assert.equal(callback.searchParams.has('code'), false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM hexu_oauth_receiver_bindings').get()!.n, 0);
    assert.equal(
      (
        await f.send(OAUTH_PATH + '/consent', {
          headers: formHeaders(f.cookie),
          body: consentForm(deniedView, false),
        })
      ).statusCode,
      409,
    );
    const view = await htmlConsent(f.send, f.cookie);
    const approved = await f.send(OAUTH_PATH + '/consent', {
      headers: formHeaders(f.cookie),
      body: consentForm(view),
    });
    const code = new URL(location(approved, 303)).searchParams.get('code')!;
    const wrongVerifier = await exchange(f.send, code, randomBytes(32).toString('base64url'));
    // Pinned provider rejects the PKCE mismatch as UNAUTHORIZED, consuming the code first.
    assert.equal(wrongVerifier.statusCode, 401);
    assert.equal(wrongVerifier.json().access_token, undefined);
    const replay = await exchange(f.send, code, view.verifier);
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().access_token, undefined);
    const alice = await f.login(f.alice.user.email);
    const empty = await htmlConsent(f.send, alice.cookie);
    assert.match(empty.html, /value="true" class="oauth-primary" disabled/);
    assert.equal(
      inputs(empty.html).some(({ attributes }) => attributes.name === 'receiver'),
      false,
    );
    const stale = await htmlConsent(f.send, f.cookie);
    f.store.db
      .prepare('UPDATE agent_receiver_connections SET expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), f.issuedReceiver.credential.id);
    const expired = await f.send(OAUTH_PATH + '/consent', {
      headers: formHeaders(f.cookie),
      body: consentForm(stale),
    });
    assert.equal(expired.statusCode, 400);
    assert.equal(
      expired.headers.location,
      undefined,
      'expired receiver does not resume authorization',
    );
    assert.equal(f.db.prepare('SELECT count(*) n FROM hexu_oauth_receiver_bindings').get()!.n, 1);
    assert.equal(
      (
        await f.send(OAUTH_PATH + '/consent', {
          headers: formHeaders(f.cookie),
          body: consentForm(stale),
        })
      ).statusCode,
      409,
      'failed stale selection still consumes its interaction',
    );
  } finally {
    await f.close();
  }
});

test('the remote allowlist rejects raw auth helpers, signup, wrong Host/proxy/CSRF, invalid forms and oversized bodies', async () => {
  const f = await fixture();
  try {
    for (const path of [
      '/',
      '/api/v1/identity',
      '/api/v1/tasks',
      '/runner/v1/poll',
      '/api/auth/get-session',
      OAUTH_PATH + '/get-session',
      OAUTH_PATH + '/sign-up/email',
      OAUTH_PATH + '/sign-in/email',
      OAUTH_PATH + '/oauth2/register',
      OAUTH_PATH + '/oauth2/consent',
      OAUTH_PATH + '/oauth2/introspect',
      OAUTH_PATH + '/admin/create-oauth-client',
      OAUTH_PATH + '/hexu/login-context',
      OAUTH_PATH + '/hexu/consent-context',
    ]) {
      for (const method of ['GET', 'POST'] as const)
        assert.equal((await f.send(path, { method })).statusCode, 404, method + ' ' + path);
    }
    assert.equal((await f.send(OAUTH_PATH + '/oauth2/token')).statusCode, 404);
    for (const path of ['/sign-in', '/consent', '/oauth2/authorize']) {
      const missingFlow = await f.send(OAUTH_PATH + path, { headers: { accept: 'text/html' } });
      assert.equal(missingFlow.statusCode, 400, path);
      assert.equal(missingFlow.headers.location, undefined);
      assert.equal(missingFlow.headers['set-cookie'], undefined);
    }
    for (const headers of [
      { host: 'attacker.example.invalid' },
      { forwarded: 'host=' + host },
      { 'x-forwarded-host': host },
      { 'x-forwarded-proto': 'https' },
    ] as Record<string, string>[]) {
      assert.equal((await f.send(OAUTH_PATH + '/sign-in', { headers })).statusCode, 403);
      assert.equal((await f.send(metadataPath, { headers })).statusCode, 403);
    }
    for (const headers of [
      { 'content-type': 'application/json' },
      { origin: 'https://attacker.example.invalid', 'content-type': 'application/json' },
      { origin, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      { origin, 'content-type': 'application/json', authorization: 'Bearer fixture' },
    ] as Record<string, string>[])
      assert.equal(
        (await f.send(OAUTH_PATH + '/sign-in', { headers, body: '{}' })).statusCode,
        403,
      );
    for (const body of [
      '{',
      'null',
      JSON.stringify({
        email: f.bob.user.email,
        password: PASSWORD,
        returnTo: 'https://attacker.example.invalid/',
      }),
    ]) {
      assert.equal(
        (
          await f.send(OAUTH_PATH + '/sign-in', {
            headers: { origin, 'content-type': 'application/json' },
            body,
          })
        ).statusCode,
        400,
      );
    }
    for (const path of [
      OAUTH_PATH + '/sign-in',
      OAUTH_PATH + '/consent',
      OAUTH_PATH + '/oauth2/token',
    ]) {
      const headers = path.endsWith('/token')
        ? { 'content-type': 'application/x-www-form-urlencoded' }
        : formHeaders(f.cookie);
      assert.equal(
        (await f.send(path, { headers, body: 'x='.padEnd(16385, 'x') })).statusCode,
        413,
        path,
      );
    }
    const auth = authorization();
    const url = new URL(location(await f.send(auth.path)));
    const signedQuery = url.search.slice(1);
    for (const query of [
      'sig=broken&exp=1',
      signedQuery.replace(/sig=[^&]+/, 'sig=broken'),
      signedQuery + '&returnTo=' + encodeURIComponent('https://attacker.example.invalid/'),
    ]) {
      const response = await f.send(OAUTH_PATH + '/sign-in?' + query, {
        headers: { accept: 'text/html' },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.headers.location, undefined);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    for (const patch of [
      { oauthQuery: 'sig=broken&exp=1' },
      { returnTo: 'https://attacker.example.invalid/' },
      { callbackURL: 'https://attacker.example.invalid/' },
    ] as Record<string, string>[]) {
      const response = await f.send(OAUTH_PATH + '/sign-in', {
        headers: formHeaders(),
        body: new URLSearchParams({
          email: f.bob.user.email,
          password: PASSWORD,
          oauthQuery: signedQuery,
          ...patch,
        }).toString(),
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.headers.location, undefined);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    const duplicated = new URLSearchParams({
      email: f.bob.user.email,
      password: PASSWORD,
      oauthQuery: signedQuery,
    });
    duplicated.append('email', f.alice.user.email);
    assert.equal(
      (
        await f.send(OAUTH_PATH + '/sign-in', {
          headers: formHeaders(),
          body: duplicated.toString(),
        })
      ).statusCode,
      400,
    );
    const invalidToken = await f.send(OAUTH_PATH + '/oauth2/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&grant_type=authorization_code',
    });
    assert.equal(invalidToken.statusCode, 400);
    assert.equal(f.db.prepare('SELECT count(*) n FROM hexu_oauth_receiver_bindings').get()!.n, 0);
    for (const path of [OAUTH_PATH + '/tokens.css', OAUTH_PATH + '/pages.css']) {
      const css = await f.send(path);
      assert.equal(css.statusCode, 200, css.body);
      assert.match(String(css.headers['content-type']), /^text\/css/);
      assert.equal((await f.send(path + '?arbitrary=1')).statusCode, 400);
    }
  } finally {
    await f.close();
  }
});

test('remote sign-in rate limit uses the peer IP and cannot be bypassed by forwarded headers', async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({
      email: f.bob.user.email,
      password: 'Fictional Wrong Password 2026!',
    });
    // The successful fixture login already accounts for attempt one from this peer.
    for (let attempt = 2; attempt <= 10; attempt++) {
      const denied = await f.send(OAUTH_PATH + '/sign-in', {
        headers: { origin, 'content-type': 'application/json' },
        body,
      });
      assert.equal(denied.statusCode, 401, 'attempt ' + attempt + ': ' + denied.body);
      assert.equal(denied.headers['set-cookie'], undefined);
    }
    const limited = await f.send(OAUTH_PATH + '/sign-in', {
      headers: { origin, 'content-type': 'application/json' },
      body,
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['set-cookie'], undefined);
    const spoofed = await f.send(OAUTH_PATH + '/sign-in', {
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.42' },
      body,
    });
    assert.equal(spoofed.statusCode, 403);
    assert.equal(spoofed.headers['set-cookie'], undefined);
    assert.equal(
      (
        await f.send(OAUTH_PATH + '/sign-in', {
          headers: { origin, 'content-type': 'application/json', 'x-real-ip': '192.0.2.43' },
          body,
        })
      ).statusCode,
      429,
    );
    assert.equal((await f.send(metadataPath)).statusCode, 200);
  } finally {
    await f.close();
  }
});

test(
  'unfinished HTTPS OAuth body reaches its deadline without blocking metadata or public MCP discovery',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    let slow: ReturnType<typeof httpsRequest> | undefined;
    try {
      const send = await f.listen();
      const address = f.remote.app.server.address();
      assert.ok(address && typeof address === 'object');
      let finished = false;
      const pending = new Promise<HttpResult>((resolve, reject) => {
        slow = httpsRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: OAUTH_PATH + '/sign-in',
            method: 'POST',
            servername: host,
            ca: tls.cert,
            headers: { host, ...formHeaders(), 'transfer-encoding': 'chunked' },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body += chunk;
            });
            response.on('end', () => {
              finished = true;
              resolve({
                statusCode: response.statusCode!,
                headers: response.headers,
                body,
                json: () => JSON.parse(body),
              });
            });
            response.on('error', reject);
          },
        );
        slow.on('error', reject);
        slow.flushHeaders();
        slow.write('email=fixture');
        // Deliberately leave the chunked body incomplete; no global fetch or external socket.
      });
      const [deadline] = await Promise.all([
        pending,
        (async () => {
          assert.equal((await send(metadataPath)).statusCode, 200);
          assert.equal((await mcp(send, null, 'tools/list')).statusCode, 200);
          assert.equal(
            finished,
            false,
            'read-only discovery completed before slow request deadline',
          );
        })(),
      ]);
      assert.equal(deadline.statusCode, 408, deadline.body);
      assert.deepEqual(deadline.json(), { error: 'invalid_request' });
      assert.equal(
        (await send(metadataPath)).statusCode,
        200,
        'listener remains usable after deadline',
      );
    } finally {
      slow?.destroy();
      await f.close();
    }
  },
);

test('OAuth environment opt-in is explicit and reads only pinned, private fixture configuration', async () => {
  for (const flag of [undefined, '0'])
    assert.equal(
      remoteOAuthFromEnvironment({
        HEXU_COLLABORATION_OAUTH_ENABLED: flag,
        HEXU_COLLABORATION_IDENTITY_SECRET_FILE: '/not-read-while-disabled',
      }),
      undefined,
    );
  assert.throws(
    () => remoteOAuthFromEnvironment({ HEXU_COLLABORATION_OAUTH_ENABLED: 'true' }),
    /opt-in/,
  );
  assert.throws(
    () => remoteOAuthFromEnvironment({ HEXU_COLLABORATION_OAUTH_ENABLED: '1' }),
    /required/,
  );
  const secretFile = join(dir, 'identity-secret.fixture');
  await writeFile(secretFile, 'fictional-identity-secret-not-real-0123456789\n', { mode: 0o600 });
  const configured = remoteOAuthFromEnvironment({
    HEXU_COLLABORATION_OAUTH_ENABLED: '1',
    HEXU_COLLABORATION_IDENTITY_DATABASE: join(dir, 'existing.sqlite'),
    HEXU_COLLABORATION_IDENTITY_SECRET_FILE: secretFile,
    HEXU_COLLABORATION_OAUTH_CLIENT: JSON.stringify(client),
  });
  assert.equal(configured!.identityDatabasePath, join(dir, 'existing.sqlite'));
  assert.equal(configured!.identitySecret, 'fictional-identity-secret-not-real-0123456789');
  assert.deepEqual(configured!.client, client);
});

test('native OAuth renderer escapes all displayed/form values and requires an explicit receiver choice', () => {
  const hostile = `\"><script>fixture()</script>&'`;
  const view: OAuthConsentPageView = {
    client: { id: hostile, name: hostile },
    account: { name: hostile, email: hostile },
    resource: hostile,
    redirectUri: hostile,
    scopes,
    consentId: hostile,
    expiresAt: hostile,
    businessAccess: 'select_existing_receiver',
    receivers: [
      {
        connectionId: hostile,
        connectionRevision: 1,
        participantId: hostile,
        projectId: hostile,
        target: {
          participantId: hostile,
          capabilityId: hostile,
          capabilityVersion: 1,
          endpointRevision: 1,
          grantId: hostile,
          grantRevision: 1,
        },
        scopes: ['material_read', 'respond'],
        expiresAt: hostile,
      },
    ],
  };
  for (const html of [
    renderOAuthConsent(view, hostile, hostile),
    renderOAuthSignIn(hostile, hostile),
  ]) {
    assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('&lt;script&gt;fixture()&lt;/script&gt;&amp;&#39;'));
    assert.match(html, /<html lang="zh-CN"/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /\/collaboration-auth\/tokens.css/);
    assert.match(html, /role="alert"/);
    assert.equal(input(html, 'oauthQuery'), hostile);
    assert.equal(/<script\b|<style\b|\son\w+=/i.test(html), false);
  }
  const html = renderOAuthConsent(view, hostile);
  const receiver = inputs(html).find(({ attributes }) => attributes.name === 'receiver')!;
  assert.equal(receiver.attributes.type, 'radio');
  assert.match(receiver.tag, /\brequired(?:\s|>)/);
  assert.equal(/\bchecked(?:\s|>)/.test(receiver.tag), false);
  assert.deepEqual(JSON.parse(receiver.attributes.value!), {
    connectionId: hostile,
    connectionRevision: 1,
  });
  assert.equal(input(html, 'consentId'), hostile);
  assert.match(html, /value="false" formnovalidate/);
  assert.match(OAUTH_PAGE_CSS, /:focus-visible/);
  assert.match(OAUTH_PAGE_CSS, /@media\s*\(max-width:/);
  assert.match(OAUTH_PAGE_CSS, /var\(--hx-/);
});
