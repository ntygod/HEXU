// Full, unmodified createApp and Store registration; only ephemeral test accounts/data.
// Calls Fastify.inject only. No listener, browser, runner dispatch, files apply, or model.
// Compile original server sources first; HEXU_SERVER_DIST selects that exact output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = resolve(process.env.HEXU_SERVER_DIST ?? 'dist');
const { createApp } = await import(pathToFileURL(resolve(dist, 'apps/control/src/app.js')));
const origin = 'http://127.0.0.1:4310';
const password = () => randomBytes(24).toString('hex');
const cookies = (r) =>
  (Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'] : [r.headers['set-cookie']])
    .filter(Boolean)
    .map((s) => s.split(';')[0])
    .join('; ');
test('real createApp / BetterAuth / Store integrates the Agent capability entry', async (t) => {
  const code = randomBytes(32).toString('hex');
  const app = await createApp({
    databasePath: ':memory:',
    port: 4310,
    logger: false,
    identity: {
      databasePath: ':memory:',
      secret: randomBytes(32).toString('hex'),
      setupCode: code,
      baseURL: origin,
      trustedOrigins: [origin],
    },
  });
  let key = 0,
    space,
    project,
    a,
    b,
    agent,
    issued;
  const request = (method, url, user, payload, extras = {}) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: {
        host: '127.0.0.1:4310',
        ...(method === 'GET'
          ? {}
          : { origin, 'x-hexu-client': 'web', 'idempotency-key': `real-${++key}` }),
        ...(user ? { cookie: user.cookie } : {}),
        ...(space ? { 'x-hexu-space': space } : {}),
        ...extras,
      },
    });
  const ok = async (promise, expected = 200) => {
    const r = await promise;
    assert.equal(
      r.statusCode,
      expected,
      JSON.stringify(r.json().error ?? { status: r.statusCode }),
    );
    return r;
  };
  const rawAgent = (url, headers = {}) =>
    app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4310', ...headers } });
  try {
    await t.test(
      'setup and invitation create two real BetterAuth members through actual routes',
      async () => {
        const setup = await ok(
          request('POST', '/api/v1/identity/setup', null, {
            code,
            name: 'Ephemeral A',
            email: 'a@example.invalid',
            password: password(),
          }),
        );
        assert.deepEqual(setup.json(), { ok: true });
        a = { cookie: cookies(setup) };
        a.id = (await ok(request('GET', '/api/v1/identity', a))).json().user.id;
        space = (
          await ok(request('POST', '/api/v1/spaces', a, { name: 'Ephemeral team' }), 201)
        ).json().id;
        const invite = (
          await ok(
            request('POST', `/api/v1/spaces/${space}/invitations`, a, {
              email: 'b@example.invalid',
            }),
            201,
          )
        ).json();
        const joined = await ok(
          request('POST', '/api/v1/identity/join', null, {
            token: invite.token,
            name: 'Ephemeral B',
            password: password(),
          }),
        );
        b = { cookie: cookies(joined) };
        b.id = (await ok(request('GET', '/api/v1/identity', b))).json().user.id;
        assert.notEqual(a.id, b.id);
        project = (
          await ok(
            request('POST', `/api/v1/spaces/${space}/projects`, a, {
              name: 'Ephemeral project',
              description: '',
            }),
            201,
          )
        ).json().id;
        await ok(
          request('POST', `/api/v1/projects/${project}/members/${b.id}`, a, { role: 'edit' }),
        );
      },
    );
    await t.test('registered routes retain Host, Origin and client-header guards', async () => {
      assert.equal(
        (
          await request('GET', '/api/v1/agent-participants', a, undefined, {
            host: 'external.example.invalid',
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            'POST',
            '/api/v1/agent-participants',
            a,
            { name: 'blocked' },
            { origin: 'https://evil.example.invalid' },
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            'POST',
            '/api/v1/agent-participants',
            a,
            { name: 'blocked' },
            { 'x-hexu-client': 'invalid' },
          )
        ).statusCode,
        403,
      );
      assert.equal((await request('GET', '/api/v1/agent-participants', null)).statusCode, 401);
    });
    await t.test(
      'session-derived owners remain isolated across concurrent requests and spoofed headers',
      async () => {
        const results = await Promise.all(
          [a, b].map((u) =>
            ok(
              request(
                'POST',
                '/api/v1/agent-participants',
                u,
                { name: `Agent ${u === a ? 'A' : 'B'}`, nativeInstanceRef: null },
                { 'x-hexu-user': u === a ? b.id : a.id },
              ),
              201,
            ),
          ),
        );
        agent = results[0].json();
        assert.equal(agent.ownerUserId, a.id);
        assert.equal(results[1].json().ownerUserId, b.id);
        const lists = await Promise.all(
          [a, b].map((u) => ok(request('GET', '/api/v1/agent-participants', u))),
        );
        lists.forEach((r, i) => {
          assert.equal(r.json().items.length, 1);
          assert.equal(r.json().items[0].ownerUserId, [a, b][i].id);
        });
        assert.equal(
          (
            await request('PATCH', `/api/v1/agent-participants/${agent.id}`, b, {
              expectedRevision: 1,
              name: 'stolen',
              nativeInstanceRef: null,
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await request('POST', '/api/v1/agent-participants', a, {
              name: 'spoof',
              ownerUserId: b.id,
            })
          ).statusCode,
          400,
        );
      },
    );
    await t.test(
      'endpoint, capability and grant become discoverable but remain non-callable',
      async () => {
        await ok(
          request('POST', `/api/v1/agent-participants/${agent.id}/endpoint`, a, {
            expectedRevision: 0,
            protocol: 'custom',
            address: 'https://agent.example.invalid/receive',
            implementation: 'Ephemeral test',
            implementationVersion: '1',
            receiveMode: 'poll',
          }),
        );
        await ok(
          request('POST', `/api/v1/agent-participants/${agent.id}/capability`, a, {
            expectedRevision: 0,
            title: 'Read-only expertise',
            description: 'Finite text response',
          }),
        );
        await ok(
          request('POST', `/api/v1/agent-participants/${agent.id}/grants`, a, {
            projectId: project,
            audience: 'selected_members',
            requesterUserIds: [b.id],
            request: true,
            autoAccept: true,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            maxConcurrent: 1,
            costBearer: 'owner',
            expectedCapabilityVersion: 1,
            expectedEndpointRevision: 1,
          }),
          201,
        );
        const items = (
          await ok(request('GET', `/api/v1/projects/${project}/agent-capabilities`, b))
        ).json().items;
        assert.equal(items.length, 1);
        assert.equal(items[0].callable, false);
      },
    );
    await t.test(
      'real browser Cookie and independent Agent Bearer are not interchangeable',
      async () => {
        issued = (
          await ok(
            request('POST', `/api/v1/agent-participants/${agent.id}/connection`, a, {
              expectedRevision: 0,
              projectId: project,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            }),
          )
        ).json();
        assert.ok(issued.token.startsWith('hexu_agent_'));
        const headers = { authorization: `Bearer ${issued.token}` };
        const principal = (await ok(rawAgent('/agent/v1/identity', headers))).json();
        assert.equal(principal.ownerUserId, a.id);
        assert.equal(principal.participantId, agent.id);
        assert.equal((await rawAgent('/agent/v1/identity', { cookie: a.cookie })).statusCode, 403);
        assert.equal(
          (await rawAgent('/agent/v1/identity', { ...headers, cookie: a.cookie })).statusCode,
          403,
        );
        assert.equal(
          (await request('GET', '/api/v1/agent-participants', null, undefined, headers)).statusCode,
          401,
        );
        assert.equal(
          (await rawAgent('/agent/v1/identity', { ...headers, origin })).statusCode,
          403,
        );
        assert.equal((await rawAgent('/agent/v1/identity?scope=other', headers)).statusCode, 404);
        assert.equal(
          (await rawAgent('/agent/v1/projects/unknown/capabilities', headers)).statusCode,
          404,
        );
      },
    );
    await t.test(
      'current project revocation invalidates an issued independent credential',
      async () => {
        await ok(
          request('POST', `/api/v1/projects/${project}/members/${b.id}`, a, { role: 'manage' }),
        );
        await ok(
          request('POST', `/api/v1/projects/${project}/members/${a.id}`, a, { role: 'view' }),
        );
        assert.equal(
          (await rawAgent('/agent/v1/identity', { authorization: `Bearer ${issued.token}` }))
            .statusCode,
          401,
        );
        const items = (
          await ok(request('GET', `/api/v1/projects/${project}/agent-capabilities`, b))
        ).json().items;
        assert.equal(items.length, 0);
      },
    );
    await t.test(
      'sign-out revokes the actual browser session on Agent management routes',
      async () => {
        await ok(request('POST', '/api/v1/identity/sign-out', b, {}));
        assert.equal((await request('GET', '/api/v1/agent-participants', b)).statusCode, 401);
      },
    );
  } finally {
    await app.close();
  }
});
