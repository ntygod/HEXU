import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  requesterFixture,
  REQUESTER_HIDDEN,
  REQUESTER_VISIBLE,
} from './helpers/agent-requester.js';
import { AgentReceiverStore } from '../packages/db/src/agent-receiver.js';
import {
  authenticateAgentReceiverConnection,
  deriveAgentReceiverRequestPrincipal,
} from '../packages/identity/src/agent-receiver-connections.js';
const ok = (r: { statusCode: number; body: string; json(): any }, code = 200) => {
  assert.equal(r.statusCode, code, r.body);
  return r.json();
};
async function fixture() {
  const f = await requesterFixture();
  const base = `agent-participants/${f.receiver.id}/receiver-connections`;
  const issueBody = {
    projectId: f.project.id,
    capabilityId: f.target.capabilityId,
    capabilityVersion: 1,
    endpointRevision: 1,
    grantId: f.target.grantId,
    grantRevision: 1,
    scopes: ['material_read', 'respond'],
    expiresAt: f.expiresAt,
    receiveConfirmed: true,
  };
  const key = randomUUID();
  const issued = ok(await f.call(base, f.bob, issueBody, key), 201);
  const headers = { authorization: `Bearer ${issued.token}`, 'x-hexu-agent-api': '1' };
  const receive = (
    path: string,
    payload?: unknown,
    key = randomUUID(),
    extra: Record<string, string> = {},
  ) =>
    f.app.inject({
      url: path.startsWith('/') ? path : `/agent-receiver/v1/${path}`,
      method: payload === undefined ? 'GET' : 'POST',
      headers: { ...headers, 'idempotency-key': key, ...extra },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  return { ...f, base, issueBody, issued, key, headers, receive };
}
function response(view: any, type = 'accept') {
  return {
    type,
    ...(type === 'accept' ? {} : { body: 'Finite answer.' }),
    expectedRevision: view.revision,
    inputRevision: view.inputRevision,
    expectedInputHash: view.inputHash,
    expectedAccessRevision: view.accessRevision,
  };
}

test('receiver bootstrap receives later requests without per-request token transfer and isolates owner authority', async () => {
  const f = await fixture();
  try {
    assert.match(f.issued.token, /^hexu_receiver_[A-Za-z0-9_-]{43}$/);
    const replay = ok(await f.call(f.base, f.bob, f.issueBody, f.key), 201);
    assert.equal(replay.token, null);
    assert.equal(
      ok(await f.call(`${f.base}/${f.issued.credential.id}`, f.bob)).credential.id,
      f.issued.credential.id,
    );
    assert.equal((await f.call(f.base, f.alice, f.issueBody)).statusCode, 404);
    assert.equal(
      (await f.call(f.base, f.bob, { ...f.issueBody, receiveConfirmed: false })).statusCode,
      422,
    );
    assert.deepEqual(ok(await f.receive('requests')).items, []);
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const view = ok(await f.receive(`requests/${created.requestId}`));
    assert.equal(ok(await f.receive('requests')).items.length, 1);
    assert.equal(
      ok(await f.receive(`requests/${created.requestId}/input-revisions/1`)).revision,
      1,
    );
    const serialized = JSON.stringify(view);
    assert.ok(serialized.includes(REQUESTER_VISIBLE));
    for (const secret of [
      REQUESTER_HIDDEN,
      f.task.id,
      f.task.title,
      f.project.id,
      f.message.id,
      f.alice.user.id,
      f.bob.user.id,
      f.alice.spaceId,
    ])
      assert.equal(serialized.includes(secret), false, secret);
    const actor = authenticateAgentReceiverConnection(f.store.db, f.headers);
    const assistanceId = f.store.agentAssistance.byRequestId(created.requestId);
    const principal = deriveAgentReceiverRequestPrincipal(f.store.db, actor, assistanceId);
    const key = randomUUID(),
      body = response(view);
    const accepted = ok(await f.receive(`requests/${created.requestId}/responses`, body, key));
    assert.equal(accepted.phase, 'accepted');
    assert.deepEqual(
      ok(await f.receive(`requests/${created.requestId}/responses`, body, key)),
      accepted,
    );
    const answered = ok(
      await f.receive(`requests/${created.requestId}/responses`, response(accepted, 'answer')),
    );
    assert.equal(answered.phase, 'answered');
    assert.equal(answered.responses.at(-1).actor.connectionId, f.issued.credential.id);
    assert.equal(
      ok(await f.requesterCall(`requests/${created.requestId}`)).responses.at(-1).body,
      'Finite answer.',
    );
    assert.equal(
      (
        f.store.db.prepare('SELECT count(*) n FROM assistance_agent_credentials').get() as {
          n: number;
        }
      ).n,
      0,
    );
    for (const extra of [
      { cookie: f.bob.cookie },
      { origin: 'http://127.0.0.1:4310' },
      { 'x-hexu-space': f.bob.spaceId },
      { 'x-hexu-runner': '1' },
      { 'x-hexu-client': 'web' },
      { 'sec-fetch-site': 'same-origin' },
    ] as Record<string, string>[])
      assert.equal((await f.receive('identity', undefined, randomUUID(), extra)).statusCode, 403);
    for (const path of [
      '/agent/v1/identity',
      '/agent-assistance/v1/identity',
      '/agent-requester/v1/identity',
      `/api/v1/tasks/${f.task.id}`,
    ])
      assert.equal((await f.receive(path)).statusCode, 401, path);
    assert.equal(
      (
        await f.receive('identity', undefined, randomUUID(), {
          authorization: `Bearer ${f.issued.token.replace('hexu_receiver_', 'hexu_request_')}`,
        })
      ).statusCode,
      401,
    );
    assert.equal((await f.receive('requests?expand=task')).statusCode, 404);
    assert.equal(
      (await f.receive('identity', undefined, randomUUID(), { 'x-hexu-agent-api': '2' }))
        .statusCode,
      409,
    );
    ok(await f.call(`${f.base}/${f.issued.credential.id}/revoke`, f.bob, { expectedRevision: 1 }));
    assert.equal(
      (await f.receive(`requests/${created.requestId}/responses`, body, key)).statusCode,
      401,
    );
    assert.throws(() => f.store.agentAssistance.respond(assistanceId, body, key, principal));
    assert.throws(() => new AgentReceiverStore(f.store).get(actor, created.requestId));
    assert.equal((await f.call(f.base, f.bob, f.issueBody, f.key)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('receiver read-only scope cannot respond and endpoint changes invalidate durable credentials', async () => {
  const f = await fixture();
  try {
    const ro = ok(await f.call(f.base, f.bob, { ...f.issueBody, scopes: ['material_read'] }), 201);
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const view = ok(await f.receive(`requests/${created.requestId}`));
    const denied = await f.receive(
      `requests/${created.requestId}/responses`,
      response(view),
      randomUUID(),
      { authorization: `Bearer ${ro.token}` },
    );
    assert.equal(denied.statusCode, 404, denied.body);
    const old = ok(
      await f.call(`agent-participants/${f.receiver.id}/connection`, f.bob, {
        expectedRevision: 0,
        projectId: f.project.id,
        expiresAt: f.expiresAt,
      }),
    );
    assert.equal(
      (
        await f.receive('identity', undefined, randomUUID(), {
          authorization: `Bearer ${old.token}`,
        })
      ).statusCode,
      401,
    );
    ok(
      await f.call(`agent-participants/${f.receiver.id}/endpoint`, f.bob, {
        expectedRevision: 1,
        protocol: 'custom',
        address: 'https://fixture.example.invalid/revised',
        implementation: 'Synthetic receiver',
        implementationVersion: '2',
        receiveMode: 'poll',
      }),
    );
    assert.equal((await f.receive('identity')).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('receiver membership removal permanently revokes bootstrap even after rejoining', async () => {
  const f = await fixture();
  try {
    const actor = authenticateAgentReceiverConnection(f.store.db, f.headers);
    // Simulate the durable membership mutation itself; triggers apply to every writer.
    f.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(f.project.id, f.bob.user.id);
    f.store.db
      .prepare('INSERT INTO collab_project_members(project_id,user_id,role) VALUES(?,?,?)')
      .run(f.project.id, f.bob.user.id, 'edit');
    assert.equal((await f.receive('identity')).statusCode, 401);
    assert.throws(() => new AgentReceiverStore(f.store).list(actor));
  } finally {
    await f.close();
  }
});

test('receiver durable authority is rechecked inside response transaction before old receipt replay', async () => {
  const f = await fixture();
  try {
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const view = ok(await f.receive(`requests/${created.requestId}`));
    const body = response(view),
      key = randomUUID();
    ok(await f.receive(`requests/${created.requestId}/responses`, body, key));
    const actor = authenticateAgentReceiverConnection(f.store.db, f.headers);
    const assistanceId = f.store.agentAssistance.byRequestId(created.requestId);
    const principal = deriveAgentReceiverRequestPrincipal(f.store.db, actor, assistanceId);
    const atomic = f.store.atomic.bind(f.store);
    // Real SQLite + business transaction: inject revocation after the preflight guard.
    f.store.atomic = (action) =>
      atomic(() => {
        f.store.db
          .prepare(
            'UPDATE agent_receiver_connections SET revoked_at=?,revision=revision+1 WHERE id=?',
          )
          .run(new Date().toISOString(), actor.connectionId);
        return action();
      });
    assert.throws(
      () => f.store.agentAssistance.respond(assistanceId, body, key, principal),
      /接收连接/,
    );
    f.store.atomic = atomic;
    assert.equal(
      (
        f.store.db
          .prepare('SELECT count(*) n FROM assistance_replies WHERE assistance_id=?')
          .get(assistanceId) as { n: number }
      ).n,
      1,
    );
    ok(
      await f.call(`agent-participants/${f.receiver.id}/grants/${f.target.grantId}/revoke`, f.bob, {
        expectedRevision: 1,
      }),
    );
    assert.equal((await f.receive('identity')).statusCode, 401);
    assert.throws(() => new AgentReceiverStore(f.store).get(actor, created.requestId));
  } finally {
    await f.close();
  }
});
