import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { migrations } from '../packages/db/src/schema.js';
import { PermissionService } from '../packages/db/src/permissions.js';
import {
  AgentCapabilitiesStore,
  type AgentResourcesContext,
} from '../packages/db/src/agent-capabilities.js';
import { DomainError } from '../packages/contracts/src/index.js';
import type { Principal } from '../packages/contracts/src/identity.js';
import { attachAgentConnections } from '../apps/control/src/agent-connections.js';
import { authenticateAgentConnection } from '../packages/identity/src/agent-connections.js';
import { attachAgentCapabilities } from '../apps/control/src/agent-capabilities.js';

/** Deliberately only a request-context fixture: real SQLite, migrations, permissions,
 * resource service and routes. No Store/runner, Better Auth, listening port or remote model. */
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) db.exec(migration.sql);
  for (const id of ['a', 'b', 'c', 'outsider'])
    db.prepare('INSERT INTO collab_people VALUES(?,?,?)').run(id, id, `${id}@example.invalid`);
  db.prepare('INSERT INTO collab_spaces VALUES(?,?,?,?)').run(
    's',
    'Test',
    'team',
    new Date().toISOString(),
  );
  db.prepare('INSERT INTO collab_spaces VALUES(?,?,?,?)').run(
    'other',
    'Other',
    'team',
    new Date().toISOString(),
  );
  for (const id of ['a', 'b', 'c'])
    db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run(
      's',
      id,
      id === 'a' ? 'owner' : 'member',
    );
  db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run('other', 'outsider', 'owner');
  for (const id of ['p', 'hidden'])
    db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
      id,
      's',
      JSON.stringify({ id, archivedAt: null }),
    );
  for (const id of ['a', 'b', 'c'])
    db.prepare('INSERT INTO collab_project_members VALUES(?,?,?)').run(
      'p',
      id,
      id === 'a' ? 'manage' : 'edit',
    );
  db.prepare('INSERT INTO collab_project_members VALUES(?,?,?)').run('hidden', 'a', 'manage');
  const context = new AsyncLocalStorage<Principal>();
  const principal = () => {
    const p = context.getStore();
    if (!p) throw new DomainError('AUTH_REQUIRED', 'No test principal', 401);
    return p;
  };
  const permissions = new PermissionService(db, principal);
  const host: AgentResourcesContext = {
    db,
    teamMode: true,
    permissions,
    get actorId() {
      return principal().user.id;
    },
    get spaceId() {
      return principal().spaceId;
    },
  };
  const service = new AgentCapabilitiesStore(host);
  const as = <T>(id: string, action: () => T) =>
    context.run(
      {
        user: { id, name: id, email: `${id}@example.invalid` },
        spaceId: id === 'outsider' ? 'other' : 's',
      },
      action,
    );
  const counts = () =>
    [
      'agent_participants',
      'agent_delegation_grants',
      'idempotency_records',
      'outbox',
      'tasks',
      'runs',
    ].map(
      (table) =>
        (
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
    );
  return { db, context, host, service, as, counts };
}
const endpoint = {
  expectedRevision: 0,
  protocol: 'custom',
  address: 'https://agent.example.invalid/receive',
  implementation: 'Test receiver',
  implementationVersion: 'unverified-1',
  receiveMode: 'poll',
};
const capability = {
  expectedRevision: 0,
  title: '接口解释',
  description: '只读、有限文本专业协助',
};
const policy = () => ({
  projectId: 'p',
  audience: 'selected_members',
  requesterUserIds: ['b'],
  request: true,
  autoAccept: true,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  maxConcurrent: 1,
  costBearer: 'owner',
  expectedCapabilityVersion: 1,
  expectedEndpointRevision: 1,
});
function enrolled(f: ReturnType<typeof fixture>, owner = 'a', key = 'one') {
  return f.as(owner, () => {
    const agent = f.service.register(
      { name: `Agent ${key}`, nativeInstanceRef: null },
      `create-${key}`,
    );
    f.service.setEndpoint(agent.id, endpoint, `endpoint-${key}`);
    return f.service.setCapability(agent.id, capability, `capability-${key}`);
  });
}
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;

test('migration 36 preserves versions 1–35 and adds no fictional people, tasks or profiles', () => {
  const f = fixture();
  try {
    assert.equal(migrations.at(-1)?.version, 36);
    assert.equal(new Set(migrations.map((m) => m.version)).size, 36);
    assert.equal(f.counts()[0], 0);
    assert.deepEqual(f.counts().slice(-2), [0, 0]);
    assert.equal(
      (
        f.db.prepare('SELECT count(*) AS n FROM collab_people').get() as {
          n: number;
        }
      ).n,
      4,
    );
  } finally {
    f.db.close();
  }
});
test('multiple Agents keep real owner identity, isolated ownership and independent endpoint/version records', () => {
  const f = fixture();
  try {
    const a = enrolled(f),
      a2 = enrolled(f, 'a', 'two'),
      b = enrolled(f, 'b', 'three');
    assert.notEqual(a.id, a2.id);
    assert.equal(a.ownerUserId, 'a');
    assert.equal(b.ownerUserId, 'b');
    assert.equal(f.as('a', () => f.service.list()).length, 2);
    assert.throws(
      () =>
        f.as('b', () =>
          f.service.update(
            a.id,
            { expectedRevision: 1, name: 'stolen', nativeInstanceRef: null },
            'steal',
          ),
        ),
      code('NOT_FOUND'),
    );
    assert.throws(
      () => f.as('a', () => f.service.register({ name: 'bad', ownerUserId: 'b' }, 'spoof')),
      code('INVALID_INPUT'),
    );
    assert.throws(
      () =>
        f.as('a', () =>
          f.service.setEndpoint(a.id, { ...endpoint, ownerUserId: 'b' }, 'spoof-endpoint'),
        ),
      code('INVALID_INPUT'),
    );
    assert.throws(
      () =>
        f.as('a', () =>
          f.service.setCapability(
            a.id,
            { ...capability, providerSupport: 'supported' },
            'spoof-state',
          ),
        ),
      code('INVALID_INPUT'),
    );
    assert.equal(a.endpoint?.authentication, 'not_integrated');
    assert.equal(a.capability?.providerSupport, 'unverified');
  } finally {
    f.db.close();
  }
});
test('deterministic authorized directory, no endpoint leakage, select is read-only and dispatch fails closed', () => {
  const f = fixture();
  try {
    const a = enrolled(f),
      b = enrolled(f, 'b', 'other');
    f.as('a', () => f.service.grant(a.id, policy(), 'grant'));
    f.as('b', () => f.service.grant(b.id, { ...policy(), requesterUserIds: ['a'] }, 'grant'));
    assert.equal(f.as('c', () => f.service.discover('p')).length, 0);
    assert.throws(() => f.as('b', () => f.service.discover('hidden')), code('NOT_FOUND'));
    assert.throws(() => f.as('outsider', () => f.service.discover('p')), code('NOT_FOUND'));
    const items = f.as('b', () => f.service.discover('p'));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.participantId, a.id);
    assert.equal(items[0]!.callable, false);
    assert.equal(items[0]!.canRequest, true);
    assert.equal('address' in items[0]!, false);
    const before = f.counts();
    const selection = f.as('b', () =>
      f.service.select('p', a.capability!.id, { expectedVersion: 1 }),
    );
    assert.equal(selection.callable, false);
    assert.deepEqual(f.counts(), before);
    assert.throws(
      () =>
        f.as('b', () =>
          f.service.requireCallable('p', a.capability!.id, {
            expectedVersion: 1,
          }),
        ),
      code('CAPABILITY_UNAVAILABLE'),
    );
    assert.throws(
      () => f.as('c', () => f.service.select('p', a.capability!.id, { expectedVersion: 1 })),
      code('NOT_FOUND'),
    );
    assert.throws(
      () => f.as('b', () => f.service.select('p', a.capability!.id, { expectedVersion: 2 })),
      code('REVISION_CONFLICT'),
    );
  } finally {
    f.db.close();
  }
});
test('authorization expiry, strict scope, current version and finite concurrency are enforced', () => {
  const f = fixture();
  try {
    const a = enrolled(f);
    for (const patch of [
      { maxConcurrent: 0 },
      { maxConcurrent: 5 },
      { expiresAt: new Date(Date.now() - 1).toISOString() },
      { expiresAt: new Date(Date.now() + 31 * 86400_000).toISOString() },
      { costBearer: 'requester' },
      { execution: true },
      { request: false, autoAccept: true },
      { audience: 'project_members', requesterUserIds: ['b'] },
      { requesterUserIds: [] },
      { requesterUserIds: ['outsider'] },
    ]) {
      assert.throws(() => f.as('a', () => f.service.grant(a.id, { ...policy(), ...patch }, 'bad')));
    }
    assert.throws(
      () =>
        f.as('a', () =>
          f.service.grant(a.id, { ...policy(), expectedCapabilityVersion: 2 }, 'stale'),
        ),
      code('REVISION_CONFLICT'),
    );
    assert.equal(f.counts()[1], 0);
    const data = { ...policy(), request: false, autoAccept: false };
    f.as('a', () => f.service.grant(a.id, data, 'discover'));
    assert.equal(f.as('b', () => f.service.discover('p'))[0]!.canRequest, false);
    f.db
      .prepare("UPDATE agent_delegation_grants SET body=json_set(body,'$.expiresAt',?)")
      .run('2000-01-01T00:00:00.000Z');
    assert.deepEqual(
      f.as('b', () => f.service.discover('p')),
      [],
    );
    assert.throws(
      () => f.as('a', () => f.service.grant(a.id, data, 'discover')),
      code('AUTHORIZATION_EXPIRED'),
    );
  } finally {
    f.db.close();
  }
});
test('endpoint and capability updates invalidate grants; immutable versions and optimistic revisions', () => {
  const f = fixture();
  try {
    const a = enrolled(f);
    f.as('a', () => f.service.grant(a.id, policy(), 'grant'));
    const next = f.as('a', () =>
      f.service.setCapability(
        a.id,
        { ...capability, expectedRevision: 1, title: '新专业能力' },
        'v2',
      ),
    );
    assert.equal(next.capability?.version, 2);
    assert.ok(next.grants[0]!.revokedAt);
    assert.deepEqual(
      f.as('b', () => f.service.discover('p')),
      [],
    );
    assert.equal(
      (f.db.prepare('SELECT count(*) AS n FROM agent_capability_versions').get() as { n: number })
        .n,
      2,
    );
    assert.throws(
      () => f.db.prepare("UPDATE agent_capability_versions SET body='{}'").run(),
      /immutable/,
    );
    f.as('a', () => f.service.grant(a.id, { ...policy(), expectedCapabilityVersion: 2 }, 'grant2'));
    const updated = f.as('a', () =>
      f.service.setEndpoint(
        a.id,
        {
          ...endpoint,
          expectedRevision: 1,
          address: 'https://replacement.example.invalid/',
        },
        'e2',
      ),
    );
    assert.ok(updated.grants.every((g) => g.revokedAt));
    assert.equal(updated.endpoint?.id, a.endpoint?.id);
    assert.throws(
      () => f.as('a', () => f.service.setEndpoint(a.id, endpoint, 'conflict')),
      code('REVISION_CONFLICT'),
    );
  } finally {
    f.db.close();
  }
});
test('same key replays without duplicate writes and foreign payload conflicts, revoke prevents old registration replay', () => {
  const f = fixture();
  try {
    const data = { name: 'Agent', nativeInstanceRef: null };
    const a = f.as('a', () => f.service.register(data, 'create'));
    const before = f.counts();
    assert.equal(f.as('a', () => f.service.register(data, 'create')).id, a.id);
    assert.deepEqual(f.counts(), before);
    assert.throws(
      () => f.as('a', () => f.service.register({ ...data, name: 'changed' }, 'create')),
      code('IDEMPOTENCY_CONFLICT'),
    );
    f.as('a', () => f.service.revoke(a.id, { expectedRevision: 1 }, 'revoke'));
    assert.throws(() => f.as('a', () => f.service.register(data, 'create')), code('AGENT_REVOKED'));
    assert.ok(f.as('a', () => f.service.revoke(a.id, { expectedRevision: 1 }, 'revoke')).revokedAt);
  } finally {
    f.db.close();
  }
});
test('membership removal and rejoin cannot revive old owner or selected/project-wide grants', () => {
  for (const audience of ['selected_members', 'project_members']) {
    const f = fixture();
    try {
      const a = enrolled(f),
        data = {
          ...policy(),
          audience,
          requesterUserIds: audience === 'selected_members' ? ['b'] : [],
        };
      f.as('a', () => f.service.grant(a.id, data, 'grant'));
      f.db
        .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
        .run('p', 'b');
      assert.throws(() => f.as('b', () => f.service.discover('p')), code('NOT_FOUND'));
      f.db.prepare('INSERT INTO collab_project_members VALUES(?,?,?)').run('p', 'b', 'edit');
      assert.deepEqual(
        f.as('b', () => f.service.discover('p')),
        [],
      );
      assert.throws(
        () => f.as('a', () => f.service.grant(a.id, data, 'grant')),
        code('AUTHORIZATION_EXPIRED'),
      );
      f.as('a', () => f.service.grant(a.id, data, 'new-grant'));
      f.db.prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?').run('s', 'a');
      assert.throws(() => f.as('a', () => f.service.list()), code('NOT_FOUND'));
      f.db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run('s', 'a', 'owner');
      assert.ok(f.as('a', () => f.service.list())[0]!.revokedAt);
      assert.deepEqual(
        f.as('b', () => f.service.discover('p')),
        [],
      );
      assert.throws(
        () =>
          f.as('a', () =>
            f.service.register({ name: 'Agent one', nativeInstanceRef: null }, 'create-one'),
          ),
        code('AGENT_REVOKED'),
      );
    } finally {
      f.db.close();
    }
  }
});
test('downgrade permanently revokes grants, including owner downgrade followed by promotion', () => {
  const f = fixture();
  try {
    const a = enrolled(f);
    const data = policy();
    f.as('a', () => f.service.grant(a.id, data, 'g'));
    f.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id='p' AND user_id='a'")
      .run();
    f.db
      .prepare(
        "UPDATE collab_project_members SET role='manage' WHERE project_id='p' AND user_id='a'",
      )
      .run();
    assert.deepEqual(
      f.as('b', () => f.service.discover('p')),
      [],
    );
    assert.throws(
      () => f.as('a', () => f.service.grant(a.id, data, 'g')),
      code('AUTHORIZATION_EXPIRED'),
    );
  } finally {
    f.db.close();
  }
});
test('transaction failure rolls back business object, receipt, grant invalidation and outbox together', () => {
  const f = fixture();
  try {
    const a = enrolled(f);
    f.as('a', () => f.service.grant(a.id, policy(), 'g'));
    const before = f.counts();
    f.db.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    assert.throws(
      () =>
        f.as('a', () => f.service.setEndpoint(a.id, { ...endpoint, expectedRevision: 1 }, 'e2')),
      /injected failure/,
    );
    assert.deepEqual(f.counts(), before);
    const restored = f.as('a', () => f.service.view(a.id));
    assert.equal(restored.endpoint?.revision, 1);
    assert.equal(restored.grants[0]!.revokedAt, null);
  } finally {
    f.db.close();
  }
});
test('resource and withdrawal survive SQLite reopen; endpoint metadata never fetches or stores credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-agent-test-'));
  const path = join(dir, 'test.db');
  const f = fixture(path);
  try {
    const a = enrolled(f);
    for (const address of [
      'http://localhost/x',
      'https://user:password@example.invalid/x',
      'https://example.invalid/x?key=fake',
      'https://example.invalid/#fake',
    ])
      assert.throws(
        () =>
          f.as('a', () =>
            f.service.setEndpoint(a.id, { ...endpoint, expectedRevision: 1, address }, 'bad'),
          ),
        code('INVALID_INPUT'),
      );
    f.as('a', () => f.service.revoke(a.id, { expectedRevision: 1 }, 'r'));
    f.db.close();
    const db = new DatabaseSync(path);
    try {
      assert.ok(
        (
          db.prepare('SELECT revoked_at FROM agent_participants WHERE id=?').get(a.id) as {
            revoked_at: string;
          }
        ).revoked_at,
      );
    } finally {
      db.close();
    }
  } finally {
    try {
      f.db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test('external authentication rejects browser, node and missing credentials', () => {
  const f = fixture();
  try {
    for (const headers of [
      { cookie: 'fake-session' },
      { authorization: 'Bearer fake-node-token' },
      { 'x-user-id': 'a' },
      {},
    ])
      assert.throws(() => authenticateAgentConnection(f.db, headers));
  } finally {
    f.db.close();
  }
});

test('real Fastify inject uses explicit request-context fixture; routes validate owner, membership replay and read-only selection', async () => {
  const f = fixture();
  const app = Fastify();
  // Test-only principal injection; production attachment remains existing attachIdentity.
  app.addHook('onRequest', (request, _reply, done) => {
    const actor = request.headers['x-fixture-user'];
    if (typeof actor === 'string') f.as(actor, done);
    else done();
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as DomainError;
    reply.code(e.status ?? 500).send({ error: { code: e.code ?? 'INTERNAL' } });
  });
  attachAgentCapabilities(app, f.host);
  try {
    const inject = (
      method: 'POST' | 'GET',
      url: string,
      payload?: unknown,
      key = 'http',
      actor = 'a',
    ) =>
      app.inject({
        method,
        url,
        payload: payload as object,
        headers: { 'x-fixture-user': actor, 'idempotency-key': key },
      });
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/agent-participants' })).statusCode,
      401,
    );
    assert.equal(
      (
        await inject('POST', '/api/v1/agent-participants', {
          name: 'fake',
          ownerUserId: 'b',
        })
      ).statusCode,
      400,
    );
    const create = await inject(
      'POST',
      '/api/v1/agent-participants',
      { name: 'HTTP', nativeInstanceRef: null },
      'http-create',
    );
    assert.equal(create.statusCode, 201);
    const agent = create.json();
    assert.equal(
      (await inject('POST', `/api/v1/agent-participants/${agent.id}/endpoint`, endpoint, 'he'))
        .statusCode,
      200,
    );
    const cap = await inject(
      'POST',
      `/api/v1/agent-participants/${agent.id}/capability`,
      capability,
      'hc',
    );
    assert.equal(cap.statusCode, 200);
    assert.equal(
      (await inject('POST', `/api/v1/agent-participants/${agent.id}/grants`, policy(), 'hg'))
        .statusCode,
      201,
    );
    const before = f.counts();
    const selected = await inject(
      'POST',
      `/api/v1/projects/p/agent-capabilities/${cap.json().capability.id}/select`,
      { expectedVersion: 1 },
      'unused',
      'b',
    );
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json().callable, false);
    assert.deepEqual(f.counts(), before);
    f.db.prepare("DELETE FROM collab_memberships WHERE space_id='s' AND user_id='a'").run();
    assert.equal(
      (
        await inject(
          'POST',
          '/api/v1/agent-participants',
          { name: 'HTTP', nativeInstanceRef: null },
          'http-create',
        )
      ).statusCode,
      404,
    );
    f.host.teamMode = false;
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/agent-participants' })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/agent-participants',
          payload: { name: 'preview' },
          headers: { 'idempotency-key': 'preview' },
        })
      ).statusCode,
      422,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});

const connectionPolicy = () => ({
  expectedRevision: 0,
  projectId: 'p',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});
const bearer = (token: string | null) => ({ authorization: `Bearer ${token}` });
test('independent credential is hash-only, one-time delivery and scoped actor with rotation keeping participant identity', () => {
  const f = fixture();
  try {
    const agent = enrolled(f, 'b');
    const data = connectionPolicy();
    const issued = f.as('b', () => f.service.issueConnection(agent.id, data, 'connect'));
    assert.ok(typeof issued.token === 'string' && issued.token.startsWith('hexu_agent_'));
    const serialized = JSON.stringify(f.db.prepare('SELECT * FROM agent_connections').all());
    assert.equal(serialized.includes(issued.token!), false);
    assert.equal(
      JSON.stringify(f.db.prepare('SELECT * FROM idempotency_records').all()).includes(
        issued.token!,
      ),
      false,
    );
    assert.equal(
      JSON.stringify(f.db.prepare('SELECT * FROM outbox').all()).includes(issued.token!),
      false,
    );
    const actor = authenticateAgentConnection(f.db, bearer(issued.token));
    assert.equal(actor.actorType, 'agent');
    assert.equal(actor.participantId, agent.id);
    assert.equal(actor.ownerUserId, 'b');
    assert.equal(actor.scope, 'capability_read');
    const replay = f.as('b', () => f.service.issueConnection(agent.id, data, 'connect'));
    assert.equal(replay.token, null);
    assert.equal(replay.agent.connection?.revision, 1);
    const rotated = f.as('b', () =>
      f.service.issueConnection(agent.id, { ...data, expectedRevision: 1 }, 'rotate'),
    );
    assert.equal(rotated.agent.id, agent.id);
    assert.equal(rotated.agent.connection?.id, issued.agent.connection?.id);
    assert.equal(rotated.agent.connection?.revision, 2);
    assert.ok(rotated.token !== issued.token);
    assert.throws(
      () => authenticateAgentConnection(f.db, bearer(issued.token)),
      code('AGENT_AUTH_REQUIRED'),
    );
    assert.equal(authenticateAgentConnection(f.db, bearer(rotated.token)).participantId, agent.id);
    assert.equal(
      f.as('b', () =>
        f.service.issueConnection(agent.id, { ...data, expectedRevision: 1 }, 'rotate'),
      ).token,
      null,
    );
    f.as('b', () => f.service.revokeConnection(agent.id, { expectedRevision: 2 }, 'disconnect'));
    assert.throws(
      () => authenticateAgentConnection(f.db, bearer(rotated.token)),
      code('AGENT_AUTH_REQUIRED'),
    );
    assert.equal(
      f.as('b', () =>
        f.service.issueConnection(agent.id, { ...data, expectedRevision: 1 }, 'rotate'),
      ).token,
      null,
    );
    assert.ok(f.as('b', () => f.service.view(agent.id)).connection?.revokedAt);
  } finally {
    f.db.close();
  }
});
test('connection scope and validity are finite; endpoint and membership changes invalidate across rejoin and restart', () => {
  for (const change of [
    'endpoint',
    'project-remove',
    'project-downgrade',
    'space-remove',
    'participant-revoke',
    'expiry',
  ]) {
    const f = fixture();
    try {
      const agent = enrolled(f, 'b');
      const data = connectionPolicy();
      const issued = f.as('b', () => f.service.issueConnection(agent.id, data, 'connect'));
      for (const invalid of [
        { expiresAt: new Date(Date.now() + 25 * 3600_000).toISOString() },
        { projectId: 'hidden' },
        { scope: 'admin' },
        { ownerUserId: 'a' },
      ])
        assert.throws(() =>
          f.as('b', () => f.service.issueConnection(agent.id, { ...data, ...invalid }, 'invalid')),
        );
      if (change === 'endpoint')
        f.as('b', () =>
          f.service.setEndpoint(agent.id, { ...endpoint, expectedRevision: 1 }, 'endpoint-change'),
        );
      if (change === 'project-remove') {
        f.db
          .prepare("DELETE FROM collab_project_members WHERE project_id='p' AND user_id='b'")
          .run();
        f.db.prepare("INSERT INTO collab_project_members VALUES('p','b','edit')").run();
      }
      if (change === 'project-downgrade') {
        f.db
          .prepare(
            "UPDATE collab_project_members SET role='view' WHERE project_id='p' AND user_id='b'",
          )
          .run();
        f.db
          .prepare(
            "UPDATE collab_project_members SET role='edit' WHERE project_id='p' AND user_id='b'",
          )
          .run();
      }
      if (change === 'space-remove') {
        f.db.prepare("DELETE FROM collab_memberships WHERE space_id='s' AND user_id='b'").run();
        f.db.prepare("INSERT INTO collab_memberships VALUES('s','b','member')").run();
      }
      if (change === 'participant-revoke')
        f.as('b', () => f.service.revoke(agent.id, { expectedRevision: 1 }, 'revoke'));
      if (change === 'expiry')
        f.db.prepare("UPDATE agent_connections SET expires_at='2000-01-01T00:00:00.000Z'").run();
      assert.throws(
        () => authenticateAgentConnection(f.db, bearer(issued.token)),
        code('AGENT_AUTH_REQUIRED'),
      );
    } finally {
      f.db.close();
    }
  }
});
test('independent Fastify Agent route rejects mixed channels and body claims, limits project and never grants browser management', async () => {
  const f = fixture();
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const e = error as DomainError;
    reply.code(e.status ?? 500).send({ error: { code: e.code ?? 'INTERNAL' } });
  });
  attachAgentCapabilities(app, f.host);
  attachAgentConnections(app, f.host);
  try {
    const agent = enrolled(f, 'b'),
      target = enrolled(f, 'a', 'target');
    f.as('a', () => f.service.grant(target.id, policy(), 'grant'));
    const issued = f.as('b', () =>
      f.service.issueConnection(agent.id, connectionPolicy(), 'connect'),
    );
    const headers = bearer(issued.token);
    const identity = await app.inject({ method: 'GET', url: '/agent/v1/identity', headers });
    assert.equal(identity.statusCode, 200);
    assert.equal(identity.json().participantId, agent.id);
    assert.equal(identity.json().actorType, 'agent');
    const before = f.counts();
    const result = await app.inject({
      method: 'GET',
      url: '/agent/v1/projects/p/capabilities',
      headers,
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().items[0]!.participantId, target.id);
    assert.equal(result.json().items[0]!.callable, false);
    assert.deepEqual(f.counts(), before);
    for (const extra of [
      { cookie: 'fake-browser' },
      { origin: 'http://localhost:4310' },
      { 'x-hexu-space': 's' },
      { 'x-hexu-runner': '1' },
    ])
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/agent/v1/identity',
            headers: { ...headers, ...extra },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/agent/v1/identity',
          headers,
          payload: { ownerUserId: 'a' },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/agent/v1/projects/hidden/capabilities', headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/agent/v1/identity?ownerUserId=a', headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/agent/v1/identity',
          headers,
          payload: { ownerUserId: 'a' },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/agent-participants', headers })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/agent-participants',
          headers: { ...headers, 'idempotency-key': 'untrusted' },
          payload: { name: 'Injected' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/agent/v1/identity',
          headers: { authorization: 'Bearer fake-node-token' },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});

test('connection rotation is atomic with receipt/outbox and persistent revoked generation stays invalid after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-agent-connection-test-'));
  const path = join(dir, 'test.db');
  const f = fixture(path);
  try {
    const agent = enrolled(f, 'b');
    const data = connectionPolicy();
    const issued = f.as('b', () => f.service.issueConnection(agent.id, data, 'connect'));
    const before = f.counts();
    f.db.exec(
      "CREATE TRIGGER fail_connection_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected connection failure'); END",
    );
    assert.throws(
      () =>
        f.as('b', () =>
          f.service.issueConnection(agent.id, { ...data, expectedRevision: 1 }, 'rotate'),
        ),
      /injected connection failure/,
    );
    assert.deepEqual(f.counts(), before);
    assert.equal(authenticateAgentConnection(f.db, bearer(issued.token)).connectionRevision, 1);
    f.db.exec('DROP TRIGGER fail_connection_outbox');
    f.db.close();
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(
        authenticateAgentConnection(reopened, bearer(issued.token)).participantId,
        agent.id,
      );
      reopened
        .prepare("DELETE FROM collab_project_members WHERE project_id='p' AND user_id='b'")
        .run();
      reopened.prepare("INSERT INTO collab_project_members VALUES('p','b','edit')").run();
    } finally {
      reopened.close();
    }
    const after = new DatabaseSync(path);
    try {
      assert.throws(
        () => authenticateAgentConnection(after, bearer(issued.token)),
        code('AGENT_AUTH_REQUIRED'),
      );
    } finally {
      after.close();
    }
  } finally {
    try {
      f.db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test('renaming an Agent preserves authority but rebinding its native instance invalidates credentials and grants', () => {
  const f = fixture();
  try {
    const agent = enrolled(f);
    f.as('a', () => f.service.grant(agent.id, policy(), 'g'));
    const issued = f.as('a', () => f.service.issueConnection(agent.id, connectionPolicy(), 'c'));
    f.as('a', () =>
      f.service.update(
        agent.id,
        { expectedRevision: 1, name: 'renamed', nativeInstanceRef: null },
        'name',
      ),
    );
    assert.equal(authenticateAgentConnection(f.db, bearer(issued.token)).participantId, agent.id);
    const rebound = f.as('a', () =>
      f.service.update(
        agent.id,
        { expectedRevision: 2, name: 'renamed', nativeInstanceRef: 'different-instance' },
        'rebind',
      ),
    );
    assert.ok(rebound.connection?.revokedAt);
    assert.ok(rebound.grants.every((g) => g.revokedAt));
    assert.throws(
      () => authenticateAgentConnection(f.db, bearer(issued.token)),
      code('AGENT_AUTH_REQUIRED'),
    );
  } finally {
    f.db.close();
  }
});

test('project archive permanently withdraws grants and connections; restore does not revive old authority', () => {
  const f = fixture();
  try {
    const agent = enrolled(f);
    const policyData = policy();
    f.as('a', () => f.service.grant(agent.id, policyData, 'g'));
    const issued = f.as('a', () => f.service.issueConnection(agent.id, connectionPolicy(), 'c'));
    const priorOutbox = f.counts()[3]!;
    f.db
      .prepare("UPDATE projects SET body=json_set(body,'$.archivedAt',?) WHERE id='p'")
      .run(new Date().toISOString());
    assert.throws(() => f.as('b', () => f.service.discover('p')), code('PROJECT_ARCHIVED'));
    assert.throws(
      () => authenticateAgentConnection(f.db, bearer(issued.token)),
      code('AGENT_AUTH_REQUIRED'),
    );
    f.db.prepare("UPDATE projects SET body=json_set(body,'$.archivedAt',NULL) WHERE id='p'").run();
    assert.deepEqual(
      f.as('b', () => f.service.discover('p')),
      [],
    );
    assert.throws(
      () => authenticateAgentConnection(f.db, bearer(issued.token)),
      code('AGENT_AUTH_REQUIRED'),
    );
    assert.throws(
      () => f.as('a', () => f.service.grant(agent.id, policyData, 'g')),
      code('AUTHORIZATION_EXPIRED'),
    );
    const view = f.as('a', () => f.service.view(agent.id));
    assert.ok(view.grants[0]!.revokedAt);
    assert.ok(view.connection?.revokedAt);
    assert.ok(f.counts()[3]! > priorOutbox);
  } finally {
    f.db.close();
  }
});
