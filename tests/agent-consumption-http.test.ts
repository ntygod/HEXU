import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../apps/control/src/app.js';
import { Store } from '../packages/db/src/store.js';
import {
  requesterFixture,
  receiverCredential,
  REQUESTER_HIDDEN,
} from './helpers/agent-requester.js';

const success = (r: { statusCode: number; body: string; json(): any }, expected = 200) => {
  assert.equal(r.statusCode, expected, r.body);
  return r.json();
};
const origin = {
  provider: 'codex',
  threadRef: 'fictional-original-thread',
  sessionRef: 'fictional-original-session',
};
const hash = (text: string) => createHash('sha256').update(JSON.stringify(text)).digest('hex');
const count = (f: Awaited<ReturnType<typeof requesterFixture>>, table: string) =>
  (f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

async function consumptionFixture(bind: boolean | 'atomic' = true) {
  const f = await requesterFixture();
  try {
    const createKey = randomUUID();
    const atomicCreated =
      bind === 'atomic'
        ? success(
            await f.requesterCall('bound-requests', { request: f.createBody, origin }, createKey),
            201,
          )
        : null;
    const request =
      atomicCreated?.request ??
      success(await f.requesterCall('requests', f.createBody, createKey), 201);
    const path = `requests/${request.requestId}`;
    const receiver = await receiverCredential(f, request.requestId);
    const respond = async (type: 'accept' | 'answer', body?: string) => {
      const current = success(await f.requesterCall(path));
      return success(
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
            ...(body === undefined ? {} : { body }),
          },
        }),
        201,
      );
    };
    const bindKey = randomUUID();
    const bound =
      atomicCreated ??
      (bind
        ? success(await f.requesterCall(`${path}/binding`, { origin }, bindKey))
        : { binding: { id: 'not-bound' }, consumption: null });
    const answer = async () => {
      await respond('accept');
      const result = await respond(
        'answer',
        'Use the API v2 compatibility adapter for finite text.',
      );
      const response = result.responses.find((r: { type: string }) => r.type === 'answer');
      assert.ok(response);
      return {
        result,
        response,
        claim: {
          responseId: response.id,
          inputRevision: result.inputRevision,
          inputHash: result.inputHash,
          accessRevision: result.accessRevision,
          bindingId: bound.binding.id,
        },
      };
    };
    return { ...f, createKey, request, path, receiver, respond, bindKey, bound, answer };
  } catch (error) {
    await f.close();
    throw error;
  }
}

// Real createApp + BetterAuth + SQLite fixtures only. No model execution, native resume, or file writes.
test('consumption freezes original binding and saved answer source without changing Task or Run', async () => {
  const f = await consumptionFixture();
  try {
    const beforeTask = success(await f.call(`tasks/${f.task.id}`, f.alice));
    const beforeCounts = { tasks: count(f, 'tasks'), runs: count(f, 'runs') };
    assert.deepEqual(f.bound.binding.origin, origin);
    assert.equal(f.bound.binding.source, 'host_reported');
    assert.equal(f.bound.binding.requestId, f.request.requestId);
    assert.equal(f.bound.binding.requesterParticipantId, f.requester.id);
    assert.equal(f.bound.binding.requesterConnectionId, f.issued.credential.id);
    assert.equal(f.bound.consumption, null);
    const { response, claim } = await f.answer();
    const consumed = success(await f.requesterCall(`${f.path}/consume`, claim));
    assert.equal(consumed.delivery, 'first');
    const c = consumed.consumption;
    assert.equal(c.requestId, f.request.requestId);
    assert.equal(c.bindingId, f.bound.binding.id);
    assert.equal(c.responseId, response.id);
    assert.equal(c.inputRevision, claim.inputRevision);
    assert.equal(c.inputHash, claim.inputHash);
    assert.equal(c.accessRevision, claim.accessRevision);
    assert.equal(c.answer, response.body);
    assert.equal(c.answerHash, hash(response.body));
    assert.deepEqual(c.sourceActor, response.actor);
    assert.equal(JSON.stringify(c).includes(f.bob.user.id), false);
    assert.deepEqual(c.materialIds, f.input.materialIds);
    assert.equal(c.acknowledgement, null);
    assert.equal(JSON.stringify(c).includes(REQUESTER_HIDDEN), false);
    assert.deepEqual(
      success(await f.requesterCall(`${f.path}/binding`, { origin }, f.bindKey)).binding,
      f.bound.binding,
    );
    assert.equal(
      (
        await f.requesterCall(`${f.path}/binding`, {
          origin: { ...origin, threadRef: 'different-thread' },
        })
      ).statusCode,
      409,
    );
    const ack = {
      consumptionId: c.id,
      bindingId: c.bindingId,
      threadRef: origin.threadRef,
      sessionRef: origin.sessionRef,
      turnRef: 'fictional-turn-2',
      output: 'Observed fixture output: add the v2 adapter.',
    };
    const acknowledged = success(await f.requesterCall(`${f.path}/ack`, ack));
    assert.equal(acknowledged.consumption.acknowledgement.output, ack.output);
    assert.equal(acknowledged.consumption.acknowledgement.evidence, 'external_self_report');
    assert.equal(acknowledged.consumption.acknowledgement.outputHash, hash(ack.output));
    assert.equal(acknowledged.consumption.acknowledgement.late, false);
    assert.equal(acknowledged.consumption.acknowledgement.cancelled, false);
    assert.equal(acknowledged.consumption.answer, response.body);
    for (const table of [
      'agent_original_work_bindings',
      'agent_result_consumptions',
      'agent_consumption_acknowledgements',
    ]) {
      assert.throws(() => f.store.db.prepare(`UPDATE ${table} SET body=body`).run(), /immutable/);
      assert.throws(() => f.store.db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
    }
    assert.deepEqual(success(await f.call(`tasks/${f.task.id}`, f.alice)), beforeTask);
    assert.deepEqual({ tasks: count(f, 'tasks'), runs: count(f, 'runs') }, beforeCounts);
    const history = await f.call(`tasks/${f.task.id}/agent-consumptions`, f.alice);
    success(history);
    assert.ok(history.body.includes(c.id));
    for (const hidden of [
      origin.threadRef,
      origin.sessionRef,
      f.issued.credential.id,
      f.issued.token,
    ])
      assert.equal(history.body.includes(hidden), false, hidden);
  } finally {
    await f.close();
  }
});

test('concurrent and duplicate delivery allow one claim; ACK original-key recovery never rewrites output', async () => {
  const f = await consumptionFixture();
  try {
    const { claim } = await f.answer();
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const results = await Promise.all(
      keys.map((key) => f.requesterCall(`${f.path}/consume`, claim, key)),
    );
    const values = results.map((r) => success(r));
    assert.deepEqual(values.map((v) => v.delivery).sort(), ['first', 'replay', 'replay']);
    assert.equal(new Set(values.map((v) => v.consumption.id)).size, 1);
    const outbox = count(f, 'outbox');
    assert.equal(
      success(await f.requesterCall(`${f.path}/consume`, claim, keys[0])).delivery,
      'replay',
    );
    assert.equal(count(f, 'outbox'), outbox);
    const c = values[0].consumption;
    const ack = {
      consumptionId: c.id,
      bindingId: c.bindingId,
      threadRef: origin.threadRef,
      sessionRef: origin.sessionRef,
      turnRef: 'fictional-observed-turn',
      output: 'Bounded fixture follow-up.',
    };
    const key = randomUUID();
    const first = success(await f.requesterCall(`${f.path}/ack`, ack, key));
    const afterAck = count(f, 'outbox');
    const recovered = success(await f.requesterCall(`${f.path}/ack`, ack, key));
    assert.equal(recovered.delivery, 'replay');
    assert.deepEqual(recovered.consumption, first.consumption);
    assert.equal(success(await f.requesterCall(`${f.path}/ack`, ack)).delivery, 'replay');
    assert.equal(
      (await f.requesterCall(`${f.path}/ack`, { ...ack, output: 'Changed output' }, key))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.requesterCall(`${f.path}/ack`, { ...ack, turnRef: 'another-turn' })).statusCode,
      409,
    );
    assert.equal(count(f, 'outbox'), afterAck);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('consume rejects wrong request, response, input versions and binding; ACK rejects foreign original-work references', async () => {
  const f = await consumptionFixture();
  try {
    const { result, claim } = await f.answer();
    const accepted = result.responses.find((r: { type: string }) => r.type === 'accept');
    for (const patch of [
      { responseId: randomUUID() },
      { responseId: accepted.id },
      { inputRevision: claim.inputRevision + 1 },
      { inputHash: '0'.repeat(64) },
      { accessRevision: claim.accessRevision + 1 },
      { bindingId: randomUUID() },
    ])
      assert.equal(
        (await f.requesterCall(`${f.path}/consume`, { ...claim, ...patch })).statusCode,
        409,
      );
    assert.equal(
      (await f.requesterCall(`requests/${randomUUID()}/consume`, claim)).statusCode,
      404,
    );
    assert.equal(success(await f.requesterCall(`${f.path}/consumption`)).consumption, null);
    const c = success(await f.requesterCall(`${f.path}/consume`, claim)).consumption;
    const ack = {
      consumptionId: c.id,
      bindingId: c.bindingId,
      threadRef: origin.threadRef,
      sessionRef: origin.sessionRef,
      turnRef: 'fictional-turn',
      output: 'Fixture output.',
    };
    for (const patch of [
      { consumptionId: randomUUID() },
      { bindingId: randomUUID() },
      { threadRef: 'other-thread' },
      { sessionRef: 'other-session' },
    ])
      assert.equal((await f.requesterCall(`${f.path}/ack`, { ...ack, ...patch })).statusCode, 409);
    assert.equal(
      success(await f.requesterCall(`${f.path}/consumption`)).consumption.acknowledgement,
      null,
    );
    for (const [suffix, body] of [
      ['consume', { ...claim, verified: true }],
      ['ack', { ...ack, verified: true }],
      ['cancel-consumption', { bindingId: c.bindingId, stop: true }],
    ] as const)
      assert.equal((await f.requesterCall(`${f.path}/${suffix}`, body)).statusCode, 400);
  } finally {
    await f.close();
  }
});

test('input revision change before answer prevents consumption using the original input version', async () => {
  const f = await consumptionFixture();
  try {
    const original = success(await f.requesterCall(f.path));
    const input = {
      ...f.input,
      clarification: 'Only use the selected message.',
      materialIds: ['message'],
    };
    const preview = success(await f.requesterCall('preview', input));
    const revised = success(
      await f.requesterCall(`${f.path}/input-revisions`, {
        ...input,
        expectedRevision: original.revision,
        expectedInputRevision: original.inputRevision,
        expectedAccessRevision: original.accessRevision,
        expectedTaskRevision: preview.expectedTaskRevision,
        causeResponseId: null,
        expectedInputHash: preview.inputHash,
      }),
      201,
    );
    assert.equal(revised.inputRevision, original.inputRevision + 1);
    const { claim } = await f.answer();
    assert.equal(
      (
        await f.requesterCall(`${f.path}/consume`, {
          ...claim,
          inputRevision: original.inputRevision,
          inputHash: original.inputHash,
          accessRevision: original.accessRevision,
        })
      ).statusCode,
      409,
    );
    assert.equal(success(await f.requesterCall(`${f.path}/consumption`)).consumption, null);
    assert.deepEqual(
      success(await f.requesterCall(`${f.path}/consume`, claim)).consumption.materialIds,
      ['message'],
    );
  } finally {
    await f.close();
  }
});

test('current requester authority is checked before claim and does not manufacture a Run', async () => {
  const f = await consumptionFixture();
  try {
    const { claim } = await f.answer();
    success(
      await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
        role: 'manage',
      }),
    );
    success(
      await f.call(`projects/${f.project.id}/members/${f.alice.user.id}`, f.bob, { role: 'view' }),
    );
    assert.equal((await f.requesterCall(`${f.path}/consume`, claim)).statusCode, 401);
    assert.equal(count(f, 'runs'), 0);
    const parent = await f.call(`tasks/${f.task.id}/agent-consumptions`, f.bob);
    success(parent);
    assert.equal(parent.body.includes('"claimedAt"'), false);
  } finally {
    await f.close();
  }
});

test('future-consumption cancellation is separate from request cancellation and late ACK stays observed', async () => {
  const f = await consumptionFixture();
  try {
    const { claim } = await f.answer();
    const c = success(await f.requesterCall(`${f.path}/consume`, claim)).consumption;
    const cancelBody = { bindingId: f.bound.binding.id };
    const key = randomUUID();
    const cancelled = success(
      await f.requesterCall(`${f.path}/cancel-consumption`, cancelBody, key),
    );
    assert.ok(cancelled.binding.cancelledAt);
    assert.equal(success(await f.requesterCall(f.path)).phase, 'answered');
    assert.equal(
      success(await f.requesterCall(`${f.path}/cancel-consumption`, cancelBody, key)).delivery,
      'replay',
    );
    assert.equal((await f.requesterCall(`${f.path}/consume`, claim)).statusCode, 409);
    const late = success(
      await f.requesterCall(`${f.path}/ack`, {
        consumptionId: c.id,
        bindingId: c.bindingId,
        threadRef: origin.threadRef,
        sessionRef: origin.sessionRef,
        turnRef: 'late-observed-turn',
        output: 'An already-started external continuation finished.',
      }),
    );
    assert.equal(late.consumption.acknowledgement.late, true);
    assert.equal(late.consumption.acknowledgement.cancelled, true);
    assert.equal(late.binding.cancelledAt, cancelled.binding.cancelledAt);
    assert.throws(
      () =>
        f.store.db
          .prepare('UPDATE agent_consumption_cancellations SET cancelled_at=cancelled_at')
          .run(),
      /immutable/,
    );
    assert.throws(
      () => f.store.db.prepare('DELETE FROM agent_consumption_cancellations').run(),
      /immutable/,
    );
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('cancellation before claim forbids later answer consumption and cannot rebind', async () => {
  const f = await consumptionFixture();
  try {
    success(
      await f.requesterCall(`${f.path}/cancel-consumption`, { bindingId: f.bound.binding.id }),
    );
    const { claim } = await f.answer();
    assert.equal((await f.requesterCall(`${f.path}/consume`, claim)).statusCode, 409);
    assert.equal(
      (
        await f.requesterCall(`${f.path}/binding`, {
          origin: { ...origin, sessionRef: 'replacement-session' },
        })
      ).statusCode,
      409,
    );
    assert.equal(success(await f.requesterCall(`${f.path}/consumption`)).consumption, null);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('offline answer and unknown claim survive application restart; GET never starts continuation', async () => {
  const f = await consumptionFixture();
  let reopened: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const { claim } = await f.answer();
    const before = success(await f.requesterCall(`${f.path}/consumption`));
    assert.equal(before.consumption, null);
    const c = success(await f.requesterCall(`${f.path}/consume`, claim)).consumption;
    await f.app.close();
    const store = new Store(f.dbPath, undefined, { team: true });
    reopened = await createApp({ store, identity: f.options, port: 4310 });
    const read = () =>
      reopened!.inject({
        url: `/agent-requester/v1/${f.path}/consumption`,
        headers: { authorization: `Bearer ${f.issued.token}`, 'x-hexu-agent-api': '1' },
      });
    const recovered = success(await read());
    assert.deepEqual(recovered.binding, before.binding);
    assert.deepEqual(recovered.consumption, c);
    assert.equal(
      recovered.consumption.acknowledgement,
      null,
      'unknown external work is not restarted or acknowledged',
    );
    assert.deepEqual(success(await read()), recovered);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n, 0);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('external answer adoption is explicit human work, preserves source, and needs no invented assist Run', async () => {
  const f = await consumptionFixture();
  try {
    const before = success(await f.call(`tasks/${f.task.id}`, f.alice)).task;
    const { response, claim } = await f.answer();
    success(await f.requesterCall(`${f.path}/consume`, claim));
    assert.equal(
      success(await f.call(`tasks/${f.task.id}`, f.alice)).task.description,
      before.description,
    );
    const path = `tasks/${f.task.id}/assistances/${f.receiver.assistanceId}`;
    const preview = success(
      await f.call(`${path}/replies/${response.id}/adoption-preview`, f.alice),
    );
    assert.equal(preview.source.external.requestId, f.request.requestId);
    assert.equal(preview.source.external.response.id, response.id);
    assert.equal(preview.source.external.response.body, response.body);
    assert.deepEqual(preview.source.external.response.actor, {
      ...response.actor,
      ownerUserId: f.bob.user.id,
    });
    const body = {
      replyId: response.id,
      expectedAssistanceRevision: preview.source.assistanceRevision,
      expectedSnapshotHash: preview.source.snapshotHash,
      expectedReplyHash: preview.source.replyHash,
      expectedTaskRevision: preview.target.revision,
      ranges: [{ start: 0, end: response.body.length }],
      mode: 'append',
    };
    const key = randomUUID();
    const adopted = success(await f.call(`${path}/adoptions`, f.alice, body, key), 201);
    assert.equal(adopted.selectedText, response.body);
    assert.deepEqual(adopted.source.external, preview.source.external);
    const changed = success(await f.call(`tasks/${f.task.id}`, f.alice)).task;
    assert.ok(changed.description.includes(response.body));
    assert.equal(changed.revision, before.revision + 1);
    assert.deepEqual(success(await f.call(`${path}/adoptions`, f.alice, body, key), 201), adopted);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('external adoption rejects non-answer responses and cancelled answer cannot create a new adoption', async () => {
  const f = await consumptionFixture();
  try {
    const { result, response } = await f.answer();
    const path = `tasks/${f.task.id}/assistances/${f.receiver.assistanceId}`;
    const accepted = result.responses.find((r: { type: string }) => r.type === 'accept');
    const nonAnswer = await f.call(`${path}/replies/${accepted.id}/adoption-preview`, f.alice);
    assert.equal(nonAnswer.statusCode, 422, nonAnswer.body);
    assert.equal(nonAnswer.json().error.code, 'ASSISTANCE_NOT_SUGGESTION');
    const preview = success(
      await f.call(`${path}/replies/${response.id}/adoption-preview`, f.alice),
    );
    const body = {
      replyId: response.id,
      expectedAssistanceRevision: preview.source.assistanceRevision,
      expectedSnapshotHash: preview.source.snapshotHash,
      expectedReplyHash: preview.source.replyHash,
      expectedTaskRevision: preview.target.revision,
      ranges: [{ start: 0, end: response.body.length }],
      mode: 'append',
    };
    const current = success(await f.requesterCall(f.path));
    success(await f.requesterCall(`${f.path}/cancel`, { expectedRevision: current.revision }));
    const denied = await f.call(`${path}/adoptions`, f.alice, body);
    assert.ok([403, 404, 409].includes(denied.statusCode), denied.body);
    assert.equal(count(f, 'assistance_adoptions'), 0);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('changed approved source before claim prevents stale answer consumption', async () => {
  const f = await consumptionFixture();
  try {
    const { claim } = await f.answer();
    success(
      await f.call(
        `projects/${f.project.id}/sources/${f.source.id}`,
        f.alice,
        {
          expectedRevision: f.source.revision,
          title: f.source.title,
          content: 'Unapproved replacement source version.',
          url: null,
        },
        randomUUID(),
        'PATCH',
      ),
    );
    const denied = await f.requesterCall(`${f.path}/consume`, claim);
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(
      (
        f.store.db.prepare('SELECT count(*) AS n FROM agent_result_consumptions').get() as {
          n: number;
        }
      ).n,
      0,
    );
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('original-work identity must exist before answer and cannot be retrofitted afterwards', async () => {
  const f = await consumptionFixture(false);
  try {
    assert.deepEqual(success(await f.requesterCall(`${f.path}/consumption`)), {
      binding: null,
      consumption: null,
    });
    const { claim } = await f.answer();
    assert.equal((await f.requesterCall(`${f.path}/binding`, { origin })).statusCode, 409);
    assert.equal((await f.requesterCall(`${f.path}/consume`, claim)).statusCode, 409);
    assert.deepEqual(success(await f.requesterCall(`${f.path}/consumption`)), {
      binding: null,
      consumption: null,
    });
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('human-authored reply cannot masquerade as authenticated receiver Agent evidence for adoption', async () => {
  const f = await consumptionFixture();
  try {
    for (const type of ['accept', 'answer']) {
      const current = success(await f.requesterCall(f.path));
      success(
        await f.call(`assistances/${f.receiver.assistanceId}/responses`, f.bob, {
          expectedRevision: current.revision,
          inputRevision: current.inputRevision,
          expectedInputHash: current.inputHash,
          expectedAccessRevision: current.accessRevision,
          type,
          ...(type === 'answer'
            ? { body: 'This is a human-authored answer, not agent evidence.' }
            : {}),
        }),
        201,
      );
    }
    const result = success(await f.requesterCall(f.path));
    const response = result.responses.find((r: { type: string }) => r.type === 'answer');
    assert.equal(response.actor.kind, 'human');
    const consume = await f.requesterCall(`${f.path}/consume`, {
      responseId: response.id,
      inputRevision: result.inputRevision,
      inputHash: result.inputHash,
      accessRevision: result.accessRevision,
      bindingId: f.bound.binding.id,
    });
    assert.equal(consume.statusCode, 409, consume.body);
    assert.equal(success(await f.requesterCall(`${f.path}/consumption`)).consumption, null);
    const preview = await f.call(
      `tasks/${f.task.id}/assistances/${f.receiver.assistanceId}/replies/${response.id}/adoption-preview`,
      f.alice,
    );
    assert.equal(preview.statusCode, 422, preview.body);
    assert.equal(preview.json().error.code, 'ASSISTANCE_NOT_SUGGESTION');
    assert.equal(count(f, 'assistance_adoptions'), 0);
  } finally {
    await f.close();
  }
});

test('atomic bound request already has original-work identity when a fast receiver answers', async () => {
  const f = await consumptionFixture('atomic');
  try {
    assert.equal(f.bound.binding.requestId, f.request.requestId);
    assert.deepEqual(f.bound.binding.origin, origin);
    const { claim } = await f.answer();
    const recovered = success(
      await f.requesterCall('bound-requests', { request: f.createBody, origin }, f.createKey),
      201,
    );
    assert.equal(recovered.request.requestId, f.request.requestId);
    assert.equal(recovered.request.phase, 'answered');
    assert.deepEqual(recovered.binding, f.bound.binding);
    assert.equal(success(await f.requesterCall(`${f.path}/consume`, claim)).delivery, 'first');
    assert.equal(count(f, 'assistances'), 1);
    assert.equal(count(f, 'agent_original_work_bindings'), 1);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('atomic bound creation same-key recovery cannot change origin or leave another request or binding', async () => {
  const f = await requesterFixture();
  try {
    const key = randomUUID();
    const body = { request: f.createBody, origin };
    const first = success(await f.requesterCall('bound-requests', body, key), 201);
    const counts = () =>
      [
        'assistances',
        'assistance_input_revisions',
        'assistance_input_grants',
        'agent_original_work_bindings',
        'idempotency_records',
        'outbox',
      ].map((table) => count(f, table));
    const after = counts();
    assert.deepEqual(success(await f.requesterCall('bound-requests', body, key), 201), first);
    assert.deepEqual(counts(), after);
    const changed = await f.requesterCall(
      'bound-requests',
      { ...body, origin: { ...origin, threadRef: 'replacement-original-thread' } },
      key,
    );
    assert.equal(changed.statusCode, 409, changed.body);
    assert.deepEqual(counts(), after);
    const current = success(
      await f.requesterCall(`requests/${first.request.requestId}/consumption`),
    );
    assert.deepEqual(current.binding, first.binding);
    assert.equal(current.consumption, null);
  } finally {
    await f.close();
  }
});

test('atomic bound creation rejects invalid origin and stale request before any business rows commit', async () => {
  const f = await requesterFixture();
  try {
    const counts = () =>
      [
        'assistances',
        'assistance_input_revisions',
        'assistance_input_grants',
        'agent_original_work_bindings',
        'idempotency_records',
        'outbox',
      ].map((table) => count(f, table));
    const before = counts();
    const invalid = await f.requesterCall('bound-requests', {
      request: f.createBody,
      origin: { ...origin, threadRef: '/unapproved/path' },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.deepEqual(counts(), before);
    const stale = await f.requesterCall('bound-requests', {
      request: { ...f.createBody, expectedTaskRevision: f.createBody.expectedTaskRevision + 1 },
      origin,
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual(counts(), before);
  } finally {
    await f.close();
  }
});

test('binding insert failure rolls back bound request, grants, outbox and receipt; original key can recover once', async () => {
  const f = await requesterFixture();
  try {
    const counts = () =>
      [
        'assistances',
        'assistance_agent_requests',
        'assistance_input_revisions',
        'assistance_input_grants',
        'agent_original_work_bindings',
        'idempotency_records',
        'outbox',
      ].map((table) => count(f, table));
    const before = counts();
    const key = randomUUID(),
      body = { request: f.createBody, origin };
    // Only this disposable business DB and new binding insert. No native/file restoration fault injection.
    f.store.db.exec(
      "CREATE TRIGGER test_only_bound_request_insert_abort BEFORE INSERT ON agent_original_work_bindings BEGIN SELECT RAISE(ABORT, 'test-only binding insert abort'); END;",
    );
    const failed = await f.requesterCall('bound-requests', body, key);
    assert.equal(failed.statusCode, 500, failed.body);
    f.store.db.exec('DROP TRIGGER test_only_bound_request_insert_abort;');
    assert.deepEqual(counts(), before);
    const recovered = success(await f.requesterCall('bound-requests', body, key), 201);
    assert.equal(recovered.binding.requestId, recovered.request.requestId);
    assert.equal(count(f, 'assistances'), 1);
    assert.equal(count(f, 'agent_original_work_bindings'), 1);
    const committed = counts();
    assert.deepEqual(success(await f.requesterCall('bound-requests', body, key), 201), recovered);
    assert.deepEqual(counts(), committed);
  } finally {
    await f.close();
  }
});

test('a legacy unbound creation receipt cannot be retroactively converted into an atomic bound request', async () => {
  const f = await consumptionFixture(false);
  try {
    const outbox = count(f, 'outbox');
    const denied = await f.requesterCall(
      'bound-requests',
      { request: f.createBody, origin },
      f.createKey,
    );
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(count(f, 'assistances'), 1);
    assert.equal(count(f, 'agent_original_work_bindings'), 0);
    assert.equal(count(f, 'outbox'), outbox);
    assert.deepEqual(success(await f.requesterCall(`${f.path}/consumption`)), {
      binding: null,
      consumption: null,
    });
  } finally {
    await f.close();
  }
});
