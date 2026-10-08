import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { mock } from 'node:test';
import Fastify from 'fastify';
import {
  requesterFixture,
  REQUESTER_HIDDEN,
  REQUESTER_VISIBLE,
} from './helpers/agent-requester.js';
import { PASSWORD } from './helpers/team.js';
import { createIdentity } from '../packages/identity/src/index.js';
import { OAUTH_PATH, OAUTH_SCOPES } from '../packages/identity/src/oauth.js';
import { revalidateAgentReceiverConnection } from '../packages/identity/src/agent-receiver-connections.js';
import { AgentEvents, EVENT_NAME } from '../apps/control/src/agent-events.js';
import { attachAgentMcpHttp, MCP_PATH, MCP_VERSION } from '../apps/control/src/agent-mcp-http.js';
import type { WebhookSender } from '../apps/control/src/event-webhook.js';

const origin = 'https://hexu.example.invalid';
const resource = origin + MCP_PATH;
const issuer = origin + OAUTH_PATH;
const redirect = 'https://fixture.example.invalid/callback';
const client = { id: 'fixture-public', name: 'Fixture client', redirectUris: [redirect] };
const key = Buffer.alloc(32, 71);
const callback = 'https://callback.example.invalid/fixture';
const secret = 'whsec_' + Buffer.alloc(32, 19).toString('base64');
const scopes = [...OAUTH_SCOPES];
const cookies = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
const ok = (r: { statusCode: number; body: string; json(): any }, status = 200) => {
  assert.equal(r.statusCode, status, r.body);
  return r.json();
};
const result = (r: Parameters<typeof ok>[0]) => {
  const b = ok(r);
  assert.equal(b.error, undefined, JSON.stringify(b));
  return b.result;
};
const subscribe = () => ({
  name: EVENT_NAME,
  arguments: {},
  delivery: { mode: 'webhook', url: callback, secret },
  ttlMs: 600000,
});
const response = (v: any) => ({
  type: 'accept',
  expectedRevision: v.revision,
  inputRevision: v.inputRevision,
  expectedInputHash: v.inputHash,
  expectedAccessRevision: v.accessRevision,
});
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

async function fixture(connectionScopes = ['material_read', 'respond']) {
  const f = await requesterFixture();
  const base = `agent-participants/${f.receiver.id}/receiver-connections`;
  const issue = {
    projectId: f.project.id,
    capabilityId: f.target.capabilityId,
    capabilityVersion: 1,
    endpointRevision: 1,
    grantId: f.target.grantId,
    grantRevision: 1,
    scopes: connectionScopes,
    expiresAt: f.expiresAt,
    receiveConfirmed: true,
  };
  const issued = ok(await f.call(base, f.bob, issue), 201);
  const identity = await createIdentity({
    ...f.options,
    oauth: { origin, resource, client, receiverDatabase: f.store.db },
  });
  const oauth = identity.oauth!;
  const db = new DatabaseSync(f.identityPath);
  const headers = (cookie = '') =>
    new Headers({ cookie, origin, 'content-type': 'application/json' });
  const call = (path: string, options: RequestInit = {}) =>
    oauth.handler(new Request(origin + path, options));
  const login = async (email: string) => {
    const r = await call(OAUTH_PATH + '/sign-in', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(r.status, 200);
    return headers(cookies(r));
  };
  const bob = await login(f.bob.user.email);
  await oauth.provisionConfiguredClient(bob);
  const interaction = async (h = bob, requested = scopes) => {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirect,
      response_type: 'code',
      resource,
      scope: requested.join(' '),
      state: randomUUID(),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const auth = await call(OAUTH_PATH + '/oauth2/authorize?' + query, { headers: h });
    assert.equal(auth.status, 302, await auth.clone().text());
    const url = auth.headers.get('location')!;
    const r = await oauth.handler(new Request(url, { headers: h }));
    assert.equal(r.status, 200, await r.clone().text());
    return { verifier, oauthQuery: new URL(url).search.slice(1), view: await r.json(), headers: h };
  };
  const consent = (
    i: Awaited<ReturnType<typeof interaction>>,
    accepted = scopes,
    receiver: unknown = {
      connectionId: issued.credential.id,
      connectionRevision: 1,
    },
  ) =>
    call(OAUTH_PATH + '/consent', {
      method: 'POST',
      headers: i.headers,
      body: JSON.stringify({
        consentId: i.view.consentId,
        oauthQuery: i.oauthQuery,
        accept: true,
        scopes: accepted,
        receiver,
      }),
    });
  const code = async (accepted = scopes) => {
    const i = await interaction();
    const r = await consent(i, accepted);
    assert.equal(r.status, 200, await r.clone().text());
    return { ...i, code: new URL((await r.json()).url).searchParams.get('code')! };
  };
  const exchange = (i: { code: string; verifier: string }, extra: Record<string, string> = {}) =>
    call(OAUTH_PATH + '/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: i.code,
        code_verifier: i.verifier,
        client_id: client.id,
        redirect_uri: redirect,
        resource,
        ...extra,
      }),
    });
  const mint = async (accepted = scopes) => {
    const i = await code(accepted),
      r = await exchange(i);
    assert.equal(r.status, 200, await r.clone().text());
    const token = await r.json();
    assert.equal(token.refresh_token, undefined);
    const access = await oauth.resourceServer!.authenticate({
      authorization: 'Bearer ' + token.access_token,
    });
    return { token: token.access_token as string, access, code: i };
  };
  const sent: any[] = [];
  const behavior: { beforeAuthorize?: () => void; challengeGate?: () => Promise<void> } = {};
  const sender: WebhookSender = async (_url, body, _headers, authorize) => {
    behavior.beforeAuthorize?.();
    authorize();
    const value = JSON.parse(body);
    sent.push(value);
    if (value.type === 'verification') {
      await behavior.challengeGate?.();
      return { status: 200, body: JSON.stringify({ challenge: value.challenge }) };
    }
    return { status: 204, body: '' };
  };
  const events = new AgentEvents(f.store, key, sender, oauth.resourceServer!);
  const app = Fastify({ logger: false });
  attachAgentMcpHttp(app, events);
  const mcp = (
    token: string | null,
    method: string,
    params: Record<string, unknown> = {},
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: MCP_PATH,
      headers: {
        host: new URL(origin).host,
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        'mcp-protocol-version': MCP_VERSION,
        'mcp-method': method,
        ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
        ...extra,
      },
      payload: {
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
      },
    });
  const tool = (token: string, name: string, args: Record<string, unknown> = {}) =>
    mcp(token, 'tools/call', { name, arguments: args });
  const revoke = (id: string, h = bob) =>
    call(OAUTH_PATH + '/receiver-binding/revoke', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ bindingId: id }),
    });
  const bindings = () => db.prepare('SELECT * FROM hexu_oauth_receiver_bindings').all();
  const deliveries = () => f.store.db.prepare('SELECT * FROM agent_event_deliveries').all();
  return {
    ...f,
    base,
    issue,
    issued,
    identity,
    oauth,
    db,
    legacyApp: f.app,
    app,
    events,
    sender,
    sent,
    behavior,
    oauthCall: call,
    login,
    bobHeaders: bob,
    interaction,
    consent,
    code,
    exchange,
    mint,
    mcp,
    tool,
    revoke,
    bindings,
    deliveries,
    async close() {
      await app.close();
      identity.close();
      db.close();
      await f.close();
    },
  };
}

test('OAuth opt-in publishes only public metadata and proper HTTP/tool challenges; legacy app remains unchanged', async () => {
  const f = await fixture();
  try {
    const metadata = ok(
      await f.app.inject({
        url: '/.well-known/oauth-protected-resource/collaboration/mcp',
        headers: { host: new URL(origin).host },
      }),
    );
    assert.equal(metadata.resource, resource);
    assert.deepEqual(metadata.authorization_servers, [issuer]);
    assert.equal(result(await f.mcp(null, 'server/discover')).supportedVersions[0], MCP_VERSION);
    const tools = result(await f.mcp(null, 'tools/list')).tools;
    assert.deepEqual(tools.find((t: any) => t.name === 'hexu_respond').securitySchemes, [
      { type: 'oauth2', scopes },
    ]);
    for (const method of ['events/list', 'events/subscribe', 'events/unsubscribe']) {
      const r = await f.mcp(null, method);
      assert.equal(r.statusCode, 401);
      assert.match(String(r.headers['www-authenticate']), /resource_metadata=/);
    }
    const denied = await f.tool('invalid.jwt.fixture', 'hexu_list_requests');
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.json().result.isError, true);
    assert.match(denied.json().result._meta['mcp/www_authenticate'][0], /error="invalid_token"/);
    assert.equal(denied.body.includes('invalid.jwt.fixture'), false);
    assert.equal((await f.mcp(f.issued.token, 'tools/list')).statusCode, 401);
    assert.equal((await f.app.inject({ url: `/api/v1/tasks/${f.task.id}` })).statusCode, 404);
    // Original full app still has no OAuth resource server, issuer or public metadata mounted.
    assert.equal(
      f.legacyApp.hasRoute({ method: 'GET', url: '/.well-known/oauth-protected-resource' }),
      false,
    );
    assert.equal(f.legacyApp.hasRoute({ method: 'POST', url: OAUTH_PATH + '/sign-in' }), false);
    assert.equal(
      (await f.oauthCall(OAUTH_PATH + '/oauth2/revoke', { method: 'POST' })).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test('explicit consent selects only an owned current receiver revision; login alone never creates business authority', async () => {
  const f = await fixture();
  try {
    const i = await f.interaction();
    assert.equal(i.view.businessAccess, 'select_existing_receiver');
    assert.equal(i.view.receivers[0].connectionId, f.issued.credential.id);
    assert.equal(f.bindings().length, 0);
    const alice = await f.login(f.alice.user.email);
    const other = await f.interaction(alice);
    assert.deepEqual(other.view.receivers, []);
    assert.equal((await f.consent(other)).status, 400);
    for (const selection of [
      null,
      { connectionId: f.issued.credential.id, connectionRevision: 2 },
      { connectionId: f.issued.credential.id, connectionRevision: 1, subject: f.bob.user.id },
      { connectionId: 'missing', connectionRevision: 1 },
    ])
      assert.equal((await f.consent(await f.interaction(), scopes, selection)).status, 400);
    assert.equal(f.bindings().length, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM oauthConsent').get()!.n, 0);
    const token = await f.mint();
    assert.equal(token.access.actor.ownerUserId, f.bob.user.id);
    assert.equal(token.access.actor.connectionId, f.issued.credential.id);
    assert.equal((await f.revoke(token.access.subscription.bindingId, alice)).status, 400);
    assert.equal((await f.revoke(token.access.subscription.bindingId, f.bobHeaders)).status, 200);
  } finally {
    await f.close();
  }
});

test('provider consent, receiver binding and code mapping roll back together while a failed interaction stays consumed', async () => {
  const f = await fixture();
  try {
    const i = await f.interaction();
    f.db.exec(
      "CREATE TRIGGER fixture_binding_failure BEFORE INSERT ON hexu_oauth_receiver_codes BEGIN SELECT RAISE(ABORT,'fixture binding write failure'); END",
    );
    assert.equal((await f.consent(i)).status, 400);
    assert.equal(f.bindings().length, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM oauthConsent').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM hexu_oauth_receiver_codes').get()!.n, 0);
    f.db.exec('DROP TRIGGER fixture_binding_failure');
    assert.equal((await f.consent(i)).status, 409);
    await f.mint();
    assert.equal(f.bindings().length, 1);
  } finally {
    await f.close();
  }
});

test('OAuth scope intersection is independent from the original receiver principal and never leaks parent authority', async () => {
  const f = await fixture();
  try {
    const a = await f.mint(['hexu:material_read']);
    assert.deepEqual(a.access.actor.scopes, ['material_read', 'respond']);
    assert.doesNotThrow(() => revalidateAgentReceiverConnection(f.store.db, a.access.actor));
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const view = result(
      await f.tool(a.token, 'hexu_get_request', { requestId: created.requestId }),
    ).structuredContent;
    assert.ok(JSON.stringify(view).includes(REQUESTER_VISIBLE));
    for (const hidden of [REQUESTER_HIDDEN, f.task.id, f.project.id, f.message.id, f.bob.user.id])
      assert.equal(JSON.stringify(view).includes(hidden), false);
    assert.equal(
      result(
        await f.tool(a.token, 'hexu_read_materials', {
          requestId: created.requestId,
          inputRevision: 1,
        }),
      ).structuredContent.revision,
      1,
    );
    const args = {
      requestId: created.requestId,
      operationKey: randomUUID(),
      response: response(view),
    };
    const denied = await f.tool(a.token, 'hexu_respond', args);
    assert.equal(denied.statusCode, 403);
    assert.match(String(denied.headers['www-authenticate']), /insufficient_scope/);
    assert.throws(
      () =>
        f.events.receiver.respond(
          a.access.actor,
          created.requestId,
          args.response,
          args.operationKey,
          a.access,
        ),
      /scope/,
    );
    const full = await f.mint();
    const accepted = result(await f.tool(full.token, 'hexu_respond', args)).structuredContent;
    assert.equal(accepted.phase, 'accepted');
    assert.deepEqual(
      result(await f.tool(full.token, 'hexu_respond', args)).structuredContent,
      accepted,
    );
    assert.equal((await f.revoke(full.access.subscription.bindingId)).status, 200);
    assert.equal((await f.tool(full.token, 'hexu_respond', args)).statusCode, 401);
    assert.throws(() =>
      f.events.receiver.respond(
        full.access.actor,
        created.requestId,
        args.response,
        args.operationKey,
        full.access,
      ),
    );
    // Existing parent and independent read-only binding keep their valid history access.
    assert.equal(
      result(await f.tool(a.token, 'hexu_get_request', { requestId: created.requestId }))
        .structuredContent.phase,
      'accepted',
    );
    assert.equal(ok(await f.requesterCall(`requests/${created.requestId}`)).phase, 'accepted');
    assert.equal(
      (await f.tool(a.token, 'hexu_get_request', { requestId: 'other-request' })).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('a broad OAuth scope cannot expand an existing read-only receiver', async () => {
  const f = await fixture(['material_read']);
  try {
    const a = await f.mint();
    assert.deepEqual(a.access.actor.scopes, ['material_read']);
    assert.throws(() => a.access.require('respond'), /scope/);
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const view = result(
      await f.tool(a.token, 'hexu_get_request', { requestId: created.requestId }),
    ).structuredContent;
    assert.equal(
      (
        await f.tool(a.token, 'hexu_respond', {
          requestId: created.requestId,
          operationKey: randomUUID(),
          response: response(view),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      result(await f.tool(a.token, 'hexu_list_requests')).structuredContent.items.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('OAuth is rechecked inside the original business transaction before replaying a saved receipt', async () => {
  const f = await fixture();
  try {
    const a = await f.mint();
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const view = f.events.receiver.get(a.access.actor, created.requestId, a.access);
    const body = response(view),
      operation = randomUUID();
    f.events.receiver.respond(a.access.actor, created.requestId, body, operation, a.access);
    const atomic = f.store.atomic.bind(f.store);
    f.store.atomic = (action) =>
      atomic(() => {
        f.db
          .prepare('UPDATE hexu_oauth_receiver_bindings SET revoked_at=? WHERE id=?')
          .run(new Date().toISOString(), a.access.subscription.bindingId);
        return action();
      });
    assert.throws(
      () => f.events.receiver.respond(a.access.actor, created.requestId, body, operation, a.access),
      /OAuth/,
    );
    f.store.atomic = atomic;
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM assistance_replies').get()!.n, 1);
  } finally {
    await f.close();
  }
});

// Only synthetic short-lived signing material. The production verifier is unchanged and uses local JWKS.
function syntheticSigner(f: Awaited<ReturnType<typeof fixture>>, base: Record<string, unknown>) {
  const pair = generateKeyPairSync('ed25519'),
    kid = 'fixture-' + randomUUID();
  f.db
    .prepare('INSERT INTO jwks(id,publicKey,privateKey,createdAt,alg,crv) VALUES(?,?,?,?,?,?)')
    .run(
      kid,
      JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
      'not-a-real-private-key',
      1,
      'EdDSA',
      'Ed25519',
    );
  return (patch: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const head = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'at+jwt', kid, ...header }),
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...base, ...patch })).toString('base64url');
    return (
      head +
      '.' +
      payload +
      '.' +
      sign(null, Buffer.from(head + '.' + payload), pair.privateKey).toString('base64url')
    );
  };
}

test('resource verifier rejects wrong issuer/audience/subject/client/binding/signature/time and missing scopes', async () => {
  const f = await fixture();
  try {
    const a = await f.mint();
    const claims = JSON.parse(Buffer.from(a.token.split('.')[1]!, 'base64url').toString());
    const signed = syntheticSigner(f, claims),
      now = Math.floor(Date.now() / 1000);
    assert.equal((await f.tool(signed(), 'hexu_list_requests')).statusCode, 200);
    for (const patch of [
      { iss: origin + '/wrong' },
      { aud: resource + '/wrong' },
      { aud: [resource, resource + '/other'] },
      { sub: f.alice.user.id },
      { client_id: 'other-client' },
      { hexu_binding: randomUUID() },
      { hexu_binding: undefined },
      { scope: 'hexu:respond' },
      { exp: now - 1 },
      { exp: undefined },
      { iat: now + 60 },
      { exp: now + 10000 },
      { nbf: now + 60 },
      { cnf: { jkt: 'not-supported' } },
    ]) {
      const r = await f.tool(signed(patch), 'hexu_list_requests');
      assert.equal(r.statusCode, 401, JSON.stringify(patch));
    }
    assert.equal((await f.tool(signed({}, { typ: 'JWT' }), 'hexu_list_requests')).statusCode, 401);
    assert.equal(
      (await f.tool(signed().slice(0, -8) + 'AAAAAAAA', 'hexu_list_requests')).statusCode,
      401,
    );
    for (const extra of [
      { cookie: 'fixture' },
      { origin },
      { 'x-hexu-space': f.bob.spaceId },
      { dpop: 'fixture' },
      { 'x-forwarded-host': new URL(origin).host },
    ])
      assert.equal(
        (await f.mcp(a.token, 'tools/list', {}, extra as unknown as Record<string, string>))
          .statusCode,
        401,
      );
    assert.equal((await f.exchange(a.code)).status, 400);
  } finally {
    await f.close();
  }
});

test('each consent has an immutable binding generation; old JWT and unexchanged code cannot migrate to a new receiver', async () => {
  const f = await fixture();
  try {
    const a = await f.mint(),
      pending = await f.code();
    const list = await (
      await f.oauthCall(OAUTH_PATH + '/receiver-bindings', { headers: f.bobHeaders })
    ).json();
    assert.equal(list.bindings.length, 2);
    const pendingId = list.bindings.find((x: any) => x.id !== a.access.subscription.bindingId).id;
    assert.equal((await f.revoke(a.access.subscription.bindingId)).status, 200);
    assert.equal((await f.revoke(pendingId)).status, 200);
    assert.equal((await f.exchange(pending)).status, 400);
    const next = await f.mint();
    assert.notEqual(next.access.subscription.bindingId, a.access.subscription.bindingId);
    assert.equal((await f.tool(next.token, 'hexu_list_requests')).statusCode, 200);
    assert.equal((await f.tool(a.token, 'hexu_list_requests')).statusCode, 401);
    assert.equal((await f.mcp(a.token, 'events/subscribe', subscribe())).statusCode, 401);
  } finally {
    await f.close();
  }
});

for (const mutation of [
  'receiver-revoke',
  'member-rejoin',
  'project-rejoin',
  'downgrade',
  'endpoint',
  'capability',
  'grant',
  'connection-revision',
  'expiry',
  'client-disabled',
] as const) {
  test(`current ${mutation} prevents OAuth calls, old receipts and event delivery`, async () => {
    const f = await fixture();
    try {
      const a = await f.mint();
      result(await f.mcp(a.token, 'events/subscribe', subscribe()));
      const created = ok(await f.requesterCall('requests', f.createBody), 201);
      const view = result(
        await f.tool(a.token, 'hexu_get_request', { requestId: created.requestId }),
      ).structuredContent;
      const args = {
        requestId: created.requestId,
        operationKey: randomUUID(),
        response: response(view),
      };
      result(await f.tool(a.token, 'hexu_respond', args));
      if (mutation === 'receiver-revoke')
        ok(
          await f.call(`${f.base}/${f.issued.credential.id}/revoke`, f.bob, {
            expectedRevision: 1,
          }),
        );
      if (mutation === 'member-rejoin') {
        const member = f.store.db
          .prepare('SELECT * FROM collab_memberships WHERE space_id=? AND user_id=?')
          .get(f.bob.spaceId, f.bob.user.id)!;
        f.store.db
          .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
          .run(f.bob.spaceId, f.bob.user.id);
        f.store.db
          .prepare('INSERT INTO collab_memberships(space_id,user_id,role) VALUES(?,?,?)')
          .run(f.bob.spaceId, f.bob.user.id, member.role!);
      }
      if (mutation === 'project-rejoin') {
        f.store.db
          .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
          .run(f.project.id, f.bob.user.id);
        f.store.db
          .prepare('INSERT INTO collab_project_members(project_id,user_id,role) VALUES(?,?,?)')
          .run(f.project.id, f.bob.user.id, 'edit');
      }
      if (mutation === 'downgrade')
        f.store.db
          .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
          .run(f.project.id, f.bob.user.id);
      if (mutation === 'endpoint')
        f.store.db
          .prepare('UPDATE agent_endpoints SET revision=revision+1 WHERE participant_id=?')
          .run(f.receiver.id);
      if (mutation === 'capability')
        f.store.db
          .prepare('UPDATE agent_capabilities SET version=version+1 WHERE participant_id=?')
          .run(f.receiver.id);
      if (mutation === 'grant')
        f.store.db
          .prepare('UPDATE agent_delegation_grants SET revision=revision+1 WHERE id=?')
          .run(f.target.grantId);
      if (mutation === 'connection-revision')
        f.store.db
          .prepare('UPDATE agent_receiver_connections SET revision=revision+1 WHERE id=?')
          .run(f.issued.credential.id);
      if (mutation === 'expiry')
        f.store.db
          .prepare(
            "UPDATE agent_receiver_connections SET expires_at='1970-01-01T00:00:00.000Z' WHERE id=?",
          )
          .run(f.issued.credential.id);
      if (mutation === 'client-disabled')
        f.db.prepare('UPDATE oauthClient SET disabled=1 WHERE clientId=?').run(client.id);
      assert.equal(
        (await f.tool(a.token, 'hexu_get_request', { requestId: created.requestId })).statusCode,
        401,
      );
      assert.equal((await f.tool(a.token, 'hexu_respond', args)).statusCode, 401);
      const before = f.sent.length;
      await f.events.drain();
      assert.equal(f.sent.length, before);
      assert.ok(f.deliveries().every((d) => d.state === 'suppressed'));
    } finally {
      await f.close();
    }
  });
}

test('OAuth subscription is binding-specific, token-expiry bounded and fail-closed across restart without its verifier', async () => {
  const f = await fixture();
  try {
    const a = await f.mint(),
      sub = result(await f.mcp(a.token, 'events/subscribe', subscribe()));
    assert.ok(Date.parse(sub.refreshBefore) <= a.access.subscription.tokenExpiresAt);
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    await f.events.drain();
    assert.ok(f.sent.some((v) => v.data?.requestId === created.requestId));
    const before = f.sent.length;
    f.store.db
      .prepare(
        "UPDATE agent_event_deliveries SET state='pending',next_at='1970-01-01T00:00:00.000Z'",
      )
      .run();
    await new AgentEvents(f.store, key, f.sender).drain();
    assert.equal(f.sent.length, before);
    assert.ok(f.deliveries().every((d) => d.state === 'suppressed'));
    f.store.db
      .prepare(
        "UPDATE agent_event_deliveries SET state='pending',next_at='1970-01-01T00:00:00.000Z'",
      )
      .run();
    assert.equal((await f.revoke(a.access.subscription.bindingId)).status, 200);
    await f.events.drain();
    assert.equal(f.sent.length, before);
    const fresh = await f.mint(),
      freshSub = result(await f.mcp(fresh.token, 'events/subscribe', subscribe()));
    assert.notEqual(freshSub.id, sub.id);
    assert.equal((await f.mcp(a.token, 'events/subscribe', subscribe())).statusCode, 401);
    // Resuming the configured verifier still cannot revive the revoked generation.
    f.store.db
      .prepare(
        "UPDATE agent_event_deliveries SET state='pending',next_at='1970-01-01T00:00:00.000Z'",
      )
      .run();
    await new AgentEvents(f.store, key, f.sender, f.oauth.resourceServer!).drain();
    assert.ok(f.deliveries().every((d) => d.state === 'suppressed'));
  } finally {
    await f.close();
  }
});

test('revocation during callback verification blocks subscription commit and revalidation occurs immediately before event send', async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    const a = await f.mint();
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.behavior.challengeGate = () => {
      entered();
      return gate;
    };
    const pending = f.mcp(a.token, 'events/subscribe', subscribe()).then((x) => x);
    await started;
    assert.equal((await f.revoke(a.access.subscription.bindingId)).status, 200);
    release!();
    assert.equal((await pending).statusCode, 401);
    assert.equal(
      f.store.db.prepare('SELECT count(*) n FROM agent_event_subscriptions').get()!.n,
      0,
    );
    f.behavior.challengeGate = undefined;
    const next = await f.mint();
    result(await f.mcp(next.token, 'events/subscribe', subscribe()));
    ok(await f.requesterCall('requests', f.createBody), 201);
    const before = f.sent.length;
    f.behavior.beforeAuthorize = () =>
      f.db
        .prepare('UPDATE hexu_oauth_receiver_bindings SET revoked_at=? WHERE id=?')
        .run(new Date().toISOString(), next.access.subscription.bindingId);
    await f.events.drain();
    assert.equal(f.sent.length, before);
    f.behavior.beforeAuthorize = undefined;
    f.store.db
      .prepare("UPDATE agent_event_deliveries SET next_at='1970-01-01T00:00:00.000Z'")
      .run();
    await f.events.drain();
    assert.ok(f.deliveries().every((d) => d.state === 'suppressed'));
  } finally {
    release?.();
    await f.close();
  }
});

test('an unfinished unauthenticated body never blocks existing JWT authentication or binding revocation', async () => {
  const f = await fixture();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  try {
    const a = await f.mint();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(Buffer.from('{'));
      },
    });
    const request = new Request(origin + OAUTH_PATH + '/sign-in', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    const pending = f.oauth.handler(request);
    // Body is deliberately still incomplete. Both operations must finish without releasing it.
    await Promise.race([
      (async () => {
        assert.equal((await f.tool(a.token, 'hexu_list_requests')).statusCode, 200);
        assert.equal((await f.revoke(a.access.subscription.bindingId)).status, 200);
      })(),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('Unfinished body blocked issuer queue')), 1000);
        t.unref();
      }),
    ]);
    controller.close();
    assert.equal((await pending).status, 400);
  } finally {
    try {
      controller?.close();
    } catch {}
    await f.close();
  }
});

test('an established subscription and retained authority stop when the OAuth token expires', async (t) => {
  const f = await fixture();
  try {
    const a = await f.mint();
    result(await f.mcp(a.token, 'events/subscribe', subscribe()));
    ok(await f.requesterCall('requests', f.createBody), 201);
    const before = f.sent.length;
    t.mock.timers.enable({ apis: ['Date'], now: a.access.subscription.tokenExpiresAt + 1 });
    assert.throws(() => a.access.require('material_read'), /OAuth/);
    assert.equal((await f.tool(a.token, 'hexu_list_requests')).statusCode, 401);
    await f.events.drain();
    assert.equal(f.sent.length, before);
    assert.ok(f.deliveries().every((d) => d.state === 'suppressed'));
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('an unfinished request body hits its bounded deadline without occupying the issuer queue', async (t) => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from('{'));
      },
    });
    const pending = f.oauth.handler(
      new Request(origin + OAUTH_PATH + '/sign-in', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    t.mock.timers.tick(5001);
    assert.equal((await pending).status, 408);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('a new consent for another owned connection cannot retarget an existing JWT', async () => {
  const f = await fixture();
  try {
    const first = await f.mint();
    const other = ok(await f.call(f.base, f.bob, f.issue), 201);
    const i = await f.interaction();
    const r = await f.consent(i, scopes, {
      connectionId: other.credential.id,
      connectionRevision: 1,
    });
    assert.equal(r.status, 200);
    const code = new URL((await r.json()).url).searchParams.get('code')!;
    const response = await f.exchange({ code, verifier: i.verifier });
    assert.equal(response.status, 200);
    const token = (await response.json()).access_token;
    const access = await f.oauth.resourceServer!.authenticate({ authorization: 'Bearer ' + token });
    assert.equal(access.actor.connectionId, other.credential.id);
    assert.equal(
      (await f.oauth.resourceServer!.authenticate({ authorization: 'Bearer ' + first.token })).actor
        .connectionId,
      f.issued.credential.id,
    );
    ok(await f.call(`${f.base}/${f.issued.credential.id}/revoke`, f.bob, { expectedRevision: 1 }));
    assert.equal((await f.tool(first.token, 'hexu_list_requests')).statusCode, 401);
    assert.equal((await f.tool(token, 'hexu_list_requests')).statusCode, 200);
  } finally {
    await f.close();
  }
});
