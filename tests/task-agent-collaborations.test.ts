import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AgentEvents, EVENT_NAME } from '../apps/control/src/agent-events.js';
import type { WebhookSender } from '../apps/control/src/event-webhook.js';
import { NativeRuntime } from '../apps/runner/src/runtime.js';
import { DomainError } from '../packages/contracts/src/index.js';
import { parseAssistanceList } from '../packages/contracts/src/assistance.js';
import {
  parseTaskAgentCollaborationList,
  type TaskAgentCollaboration,
} from '../packages/contracts/src/task-agent-collaborations.js';
import { TaskAgentCollaborationsStore } from '../packages/db/src/task-agent-collaborations.js';
import { agentReceiverConnectionById } from '../packages/identity/src/agent-receiver-connections.js';
import {
  requesterFixture,
  receiverCredential,
  REQUESTER_HIDDEN,
} from './helpers/agent-requester.js';

const ok = (response: { statusCode: number; body: string; json(): any }, status = 200) => {
  assert.equal(response.statusCode, status, response.body);
  return response.json();
};
const origin = {
  provider: 'codex',
  threadRef: 'fictional-private-thread',
  sessionRef: 'fictional-private-session',
};
type Fixture = Awaited<ReturnType<typeof requesterFixture>>;
const base = (f: Fixture) => `tasks/${f.task.id}/agent-collaborations`;
const list = async (f: Fixture) => ok(await f.call(base(f), f.alice));
const row = async (f: Fixture, id: string): Promise<TaskAgentCollaboration> =>
  ok(await f.call(`${base(f)}/${id}`, f.alice));
const count = (f: Fixture, table: string) =>
  (f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
async function request(f: Fixture, bound = false) {
  const made = bound
    ? ok(await f.requesterCall('bound-requests', { request: f.createBody, origin }), 201)
    : { request: ok(await f.requesterCall('requests', f.createBody), 201) };
  const receiver = await receiverCredential(f, made.request.requestId);
  const path = `requests/${made.request.requestId}`;
  const respond = async (type: string, body?: string, extra = {}) => {
    const current = ok(await f.requesterCall(path));
    return ok(
      await f.app.inject({
        url: `/agent-assistance/v1/${path}/responses`,
        method: 'POST',
        headers: { authorization: `Bearer ${receiver.token}`, 'idempotency-key': randomUUID() },
        payload: {
          expectedRevision: current.revision,
          inputRevision: current.inputRevision,
          expectedInputHash: current.inputHash,
          expectedAccessRevision: current.accessRevision,
          type,
          ...(body ? { body } : {}),
          ...extra,
        },
      }),
      201,
    );
  };
  return { ...made, receiver, path, respond, id: receiver.assistanceId };
}

// Original createApp, BetterAuth and SQLite only. Team mode must not initialize the host runtime.
test('Task HTTP projection separates response, consumption claim, self-report and future cancellation', async (t) => {
  const initialize = t.mock.method(NativeRuntime.prototype, 'initialize', async () => {
    throw new Error('Team projection must not initialize native resources');
  });
  const f = await requesterFixture();
  try {
    const q = await request(f, true);
    const first = await row(f, q.id);
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(first.requestId, q.request.requestId);
    assert.equal(first.currentInputRevision, 1);
    assert.equal(first.purpose, f.input.question);
    assert.equal(first.requester.participantId, f.requester.id);
    assert.equal(first.requester.name, f.requester.name);
    assert.equal(first.recipient.participantId, f.receiver.id);
    assert.equal(first.recipient.owner.id, f.bob.user.id);
    assert.equal(first.initiatedBy.kind, 'agent');
    assert.equal(first.canManage, true);
    assert.equal(first.phase, 'awaiting_acceptance');
    assert.equal(first.waitingFor, 'acceptance');
    assert.equal(first.delivery.state, 'not_observed');
    assert.equal(first.consumption.status, 'waiting_answer');
    await q.respond('accept');
    assert.equal((await row(f, q.id)).waitingFor, 'answer');
    const answer = await q.respond('answer', 'A finite fixture answer.');
    const response = answer.responses.find((item: { type: string }) => item.type === 'answer');
    const answered = await row(f, q.id);
    assert.equal(answered.phase, 'answered');
    assert.equal(answered.latestResponse?.actor.kind, 'agent');
    assert.equal(answered.waitingFor, 'continuation');
    assert.equal(answered.consumption.status, 'answer_available');
    const consumed = ok(
      await f.requesterCall(`${q.path}/consume`, {
        responseId: response.id,
        inputRevision: answer.inputRevision,
        inputHash: answer.inputHash,
        accessRevision: answer.accessRevision,
        bindingId: q.binding.id,
      }),
    );
    const claimed = await row(f, q.id);
    assert.equal(claimed.consumption.status, 'claimed');
    assert.equal(claimed.waitingFor, 'continuation_confirmation');
    assert.equal(claimed.consumption.acknowledgement, null);
    assert.equal(claimed.latestConfirmation.source, 'consumption_claim');
    ok(await f.requesterCall(`${q.path}/cancel-consumption`, { bindingId: q.binding.id }));
    const cancelled = await row(f, q.id);
    assert.ok(cancelled.consumption.futureContinuationCancelledAt);
    assert.equal(cancelled.state, 'responded');
    assert.equal(cancelled.waitingFor, null);
    assert.equal(cancelled.consumption.status, 'claimed');
    const turnRef = 'fictional-private-turn';
    const output = 'Private self-reported output is not repeated in the summary';
    ok(
      await f.requesterCall(`${q.path}/ack`, {
        consumptionId: consumed.consumption.id,
        bindingId: q.binding.id,
        threadRef: origin.threadRef,
        sessionRef: origin.sessionRef,
        turnRef,
        output,
      }),
    );
    const reported = await row(f, q.id);
    assert.equal(reported.consumption.status, 'reported');
    assert.equal(reported.consumption.acknowledgement?.evidence, 'external_self_report');
    assert.equal(reported.consumption.acknowledgement?.late, true);
    assert.equal(reported.consumption.acknowledgement?.cancelled, true);
    const responseBody = await f.call(`${base(f)}/${q.id}`, f.alice);
    assert.equal(responseBody.headers['cache-control'], 'no-store');
    for (const hidden of [
      origin.threadRef,
      origin.sessionRef,
      turnRef,
      output,
      f.issued.token,
      q.receiver.token,
      f.issued.credential.id,
      REQUESTER_HIDDEN,
      'https://fixture.example.invalid/never-fetched',
    ])
      assert.equal(responseBody.body.includes(hidden), false, hidden);
    assert.equal(count(f, 'runs'), 0);
    assert.equal(count(f, 'tasks'), 1);
    assert.deepEqual((await list(f)).items, [reported]);
  } finally {
    await f.close();
  }
});

test('callback observations use the latest input event; delivery is never acceptance or an invented receipt time', async () => {
  let lose = false;
  const callback = 'https://callback.example.invalid/private-fixture';
  const secret = `whsec_${Buffer.alloc(32, 91).toString('base64')}`;
  const sender: WebhookSender = async (url, raw, _headers, authorize) => {
    assert.equal(url, callback);
    authorize();
    const body = JSON.parse(raw);
    if (body.type === 'verification')
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    if (lose) throw new Error('Synthetic lost receipt');
    return { status: 204, body: '' };
  };
  const key = Buffer.alloc(32, 74);
  const f = await requesterFixture({ encryptionKey: key, sender, automaticDrain: false });
  try {
    const receiver = ok(
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
    const events = new AgentEvents(f.store, key, sender);
    await events.subscribe(agentReceiverConnectionById(f.store.db, receiver.credential.id), {
      name: EVENT_NAME,
      arguments: {},
      delivery: { mode: 'webhook', url: callback, secret },
      ttlMs: 600000,
    });
    const q = await request(f);
    assert.equal((await row(f, q.id)).delivery.state, 'pending');
    await events.drain();
    const delivered = await row(f, q.id);
    assert.equal(delivered.delivery.state, 'delivered');
    assert.equal(delivered.delivery.inputRevision, 1);
    assert.equal(delivered.delivery.confirmedAt, null);
    assert.equal(delivered.delivery.recipient, 'receiver');
    assert.equal(delivered.phase, 'awaiting_acceptance');
    await q.respond('accept');
    await q.respond('request_input', 'Which API version?');
    const pending = await row(f, q.id);
    assert.equal(pending.waitingFor, 'clarification');
    assert.equal(pending.latestResponse?.type, 'request_input');
    await events.drain();
    const current = ok(await f.requesterCall(q.path));
    const input = { ...f.input, clarification: 'API v2 only.', materialIds: ['message'] };
    const preview = ok(await f.requesterCall('preview', input));
    ok(
      await f.requesterCall(`${q.path}/input-revisions`, {
        ...input,
        expectedRevision: current.revision,
        expectedInputRevision: current.inputRevision,
        expectedAccessRevision: current.accessRevision,
        expectedTaskRevision: preview.expectedTaskRevision,
        causeResponseId: current.responses.at(-1).id,
        expectedInputHash: preview.inputHash,
      }),
      201,
    );
    const revised = await row(f, q.id);
    assert.equal(revised.currentInputRevision, 2);
    assert.equal(revised.phase, 'awaiting_acceptance');
    assert.equal(revised.delivery.inputRevision, 2);
    assert.equal(revised.delivery.eventType, 'input_revised');
    assert.equal(revised.delivery.state, 'pending');
    lose = true;
    await events.drain();
    const unknown = await row(f, q.id);
    assert.equal(unknown.delivery.state, 'unknown');
    assert.equal(unknown.phase, 'awaiting_acceptance');
    assert.equal(unknown.consumption.status, 'unbound');
    for (const hidden of [callback, secret, receiver.token, receiver.credential.id])
      assert.equal(JSON.stringify(unknown).includes(hidden), false, hidden);
  } finally {
    await f.close();
  }
});

test('Task projection is bounded, direct-ID scoped and rechecks current parent authority', async () => {
  const f = await requesterFixture();
  try {
    const a = await request(f),
      b = await request(f),
      c = await request(f);
    const first = ok(await f.call(`${base(f)}?limit=2`, f.alice));
    assert.deepEqual(
      first.items.map((item: TaskAgentCollaboration) => item.assistanceId),
      [c.id, b.id],
    );
    assert.equal(first.nextCursor, b.id);
    const next = ok(await f.call(`${base(f)}?limit=2&cursor=${first.nextCursor}`, f.alice));
    assert.deepEqual(
      next.items.map((item: TaskAgentCollaboration) => item.assistanceId),
      [a.id],
    );
    assert.equal(next.nextCursor, null);
    assert.equal((await row(f, a.id)).assistanceId, a.id);
    const other = ok(
      await f.call(`spaces/${f.alice.spaceId}/tasks`, f.alice, {
        title: 'Other synthetic task',
        projectId: f.project.id,
      }),
      201,
    );
    assert.equal(
      (await f.call(`tasks/${other.id}/agent-collaborations/${a.id}`, f.alice)).statusCode,
      404,
    );
    assert.equal(
      (await f.call(`tasks/${other.id}/agent-collaborations?cursor=${a.id}`, f.alice)).statusCode,
      409,
    );
    for (const query of ['limit=51', 'limit=0', 'limit=1.5', 'expand=task'])
      assert.equal((await f.call(`${base(f)}?${query}`, f.alice)).statusCode, 400);
    for (const token of [f.issued.token, a.receiver.token]) {
      const denied = await f.app.inject({
        url: `/api/v1/${base(f)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.body.includes(a.request.requestId), false);
    }
    assert.equal(ok(await f.call(`${base(f)}/${a.id}`, f.bob)).canManage, false);
    ok(await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null }));
    assert.equal((await f.call(base(f), f.bob)).statusCode, 404);
    assert.equal((await f.call(`${base(f)}/${a.id}`, f.bob)).statusCode, 404);
    const retained = await row(f, a.id);
    assert.equal(retained.accessEnded, true);
    assert.equal(retained.canManage, false);
    assert.equal(retained.waitingFor, null);
    assert.equal(retained.terminalReason, 'access_revoked');
    const service = new TaskAgentCollaborationsStore(f.store);
    f.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(f.project.id, f.alice.user.id);
    assert.throws(
      () =>
        f.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
          service.get(f.task.id, a.id),
        ),
      (error: unknown) => error instanceof DomainError && error.code === 'NOT_FOUND',
    );
  } finally {
    await f.close();
  }
});

test('domain read projection performs no writes, including expired grants, and identifies a human initiator', async () => {
  const f = await requesterFixture();
  try {
    const created = ok(
      await f.call(`tasks/${f.task.id}/agent-assistances`, f.alice, {
        ...f.selection,
        input: f.preview.input,
        expectedTaskRevision: f.preview.expectedTaskRevision,
        expectedInputHash: f.preview.inputHash,
        shareConfirmed: true,
      }),
      201,
    );
    const id = created.assistance.id;
    // Synthetic expiry only. Keep the same revision so the revocation trigger is not invoked.
    f.store.db
      .prepare(
        "UPDATE agent_delegation_grants SET body=json_set(body,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE id=?",
      )
      .run(f.target.grantId);
    const service = new TaskAgentCollaborationsStore(f.store);
    const before = f.store.db.prepare('SELECT total_changes() AS n').get();
    f.store.db.exec('PRAGMA query_only=ON');
    try {
      f.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
        const projected = service.get(f.task.id, id);
        assert.equal(projected.initiatedBy.kind, 'human');
        assert.equal(projected.requester.participantId, f.requester.id);
        assert.equal(projected.initiatedBy.participantId, null);
        assert.equal(projected.accessEnded, true);
        assert.equal(projected.canManage, false);
        assert.equal(projected.waitingFor, null);
        assert.equal(projected.terminalReason, 'access_revoked');
        assert.deepEqual(service.list(f.task.id, { limit: 20, cursor: null }).items, [projected]);
      });
      assert.deepEqual(f.store.db.prepare('SELECT total_changes() AS n').get(), before);
      assert.equal(
        (
          f.store.db
            .prepare('SELECT revoked_at FROM assistance_agent_requests WHERE assistance_id=?')
            .get(id) as { revoked_at: string | null }
        ).revoked_at,
        null,
      );
    } finally {
      f.store.db.exec('PRAGMA query_only=OFF');
    }
  } finally {
    await f.close();
  }
});

test('collaboration list parser allows only bounded cursor pagination', () => {
  assert.deepEqual(parseTaskAgentCollaborationList({}), { limit: 20, cursor: null });
  assert.deepEqual(parseTaskAgentCollaborationList({ limit: '50', cursor: 'request-id' }), {
    limit: 50,
    cursor: 'request-id',
  });
  for (const value of [
    { limit: '51' },
    { limit: '0' },
    { limit: 2 },
    { state: 'all' },
    { actorId: 'other' },
  ])
    assert.throws(() => parseTaskAgentCollaborationList(value), DomainError);
});

test('Agent attention filters before paging: old clarification survives twenty newer answers', async () => {
  const f = await requesterFixture();
  const pending = (cursor?: string, limit = 20) =>
    f.call(
      `assistances?box=sent&state=agent_attention&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      f.alice,
    );
  try {
    const old = await request(f);
    await old.respond('request_input', 'Which version needs clarification?');
    for (let i = 0; i < 20; i++) {
      const answered = await request(f);
      await answered.respond('accept');
      await answered.respond('answer', `Synthetic answer ${i}`);
    }
    const ordinary = ok(await f.call('assistances?box=sent&state=active', f.alice));
    assert.equal(ordinary.items.length, 20);
    assert.equal(
      ordinary.items.some((item: { id: string }) => item.id === old.id),
      false,
    );
    const attention = ok(await pending());
    assert.deepEqual(
      attention.items.map((item: { id: string }) => item.id),
      [old.id],
    );
    assert.equal(attention.nextCursor, null);
    assert.equal(attention.items[0].agent.phase, 'waiting_input');
    const scope = await request(f);
    await scope.respond('propose_scope', 'Only the message is needed.', {
      scope: { question: f.input.question, materialIds: ['message'] },
    });
    const accepting = await request(f);
    await accepting.respond('accept');
    const first = ok(await pending(undefined, 1));
    assert.deepEqual(
      first.items.map((item: { id: string }) => item.id),
      [scope.id],
    );
    assert.equal(first.nextCursor, scope.id);
    // A newly inserted attention item does not duplicate a page already seen.
    const fresh = await request(f);
    await fresh.respond('request_input', 'New clarification after first page.');
    const second = ok(await pending(first.nextCursor, 1));
    assert.deepEqual(
      second.items.map((item: { id: string }) => item.id),
      [old.id],
    );
    assert.equal(second.nextCursor, null);
    // Receiving or accepting Agent work never becomes a human todo by inference.
    assert.deepEqual(
      ok(await f.call('assistances?box=received&state=agent_attention', f.bob)).items,
      [],
    );
    assert.deepEqual(
      ok(
        await f.call('assistances?box=sent&state=agent_attention', {
          ...f.alice,
          spaceId: `personal-${f.alice.user.id}`,
        }),
      ).items,
      [],
    );
    const before = f.store.db.prepare('SELECT total_changes() AS n').get();
    f.store.db.exec('PRAGMA query_only=ON');
    try {
      f.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
        const page = f.store.assistance.list(
          parseAssistanceList({ box: 'sent', state: 'agent_attention' }),
        );
        assert.deepEqual(
          page.items.map((item) => item.id),
          [fresh.id, scope.id, old.id],
        );
      });
      assert.deepEqual(f.store.db.prepare('SELECT total_changes() AS n').get(), before);
    } finally {
      f.store.db.exec('PRAGMA query_only=OFF');
    }
    ok(await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null }));
    assert.deepEqual(ok(await pending()).items, []);
    assert.equal((await pending(first.nextCursor, 1)).statusCode, 409);
    assert.deepEqual(
      ok(await f.call('assistances?box=received&state=agent_attention', f.bob)).items,
      [],
    );
  } finally {
    await f.close();
  }
});

test('Agent attention remains read-only when a pending request grant expires', async () => {
  const f = await requesterFixture();
  try {
    const q = await request(f);
    await q.respond('request_input', 'Synthetic pending clarification.');
    const query = parseAssistanceList({ box: 'sent', state: 'agent_attention' });
    assert.equal(query.state, 'agent_attention');
    f.store.db
      .prepare(
        "UPDATE agent_delegation_grants SET body=json_set(body,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE id=?",
      )
      .run(f.target.grantId);
    f.store.db.exec('PRAGMA query_only=ON');
    try {
      f.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
        assert.deepEqual(f.store.assistance.list(query), { items: [], nextCursor: null });
      });
      assert.equal(
        (
          f.store.db
            .prepare('SELECT revoked_at FROM assistance_agent_requests WHERE assistance_id=?')
            .get(q.id) as { revoked_at: string | null }
        ).revoked_at,
        null,
      );
    } finally {
      f.store.db.exec('PRAGMA query_only=OFF');
    }
  } finally {
    await f.close();
  }
});
