import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson } from '../packages/domain/src/index.js';
import {
  requesterFixture,
  approveRequesterSources,
  receiverCredential,
  REQUESTER_VISIBLE,
  REQUESTER_HIDDEN,
} from './helpers/agent-requester.js';

const success = (r: { statusCode: number; body: string; json(): any }, expected = 200) => {
  assert.equal(r.statusCode, expected, r.body);
  return r.json();
};
const count = (f: Awaited<ReturnType<typeof requesterFixture>>, table: string) =>
  (f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

// Each test uses the original full app, actual BetterAuth sessions, and a disposable SQLite store.
test('requester owner issuance is explicit, one-time, current-authority scoped, and cookie/role separated', async () => {
  const f = await requesterFixture();
  try {
    assert.match(f.issued.token, /^hexu_requester_[A-Za-z0-9_-]{43}$/);
    const replay = success(
      await f.call(
        `tasks/${f.task.id}/agent-requester-credentials`,
        f.alice,
        f.issueBody,
        f.issueKey,
      ),
      201,
    );
    assert.equal(replay.token, null);
    assert.equal(replay.credential.id, f.issued.credential.id);
    const metadata = success(
      await f.call(`tasks/${f.task.id}/agent-requester-credentials`, f.alice),
    );
    assert.equal(JSON.stringify(metadata).includes(f.issued.token), false);
    assert.equal(
      (await f.call(`tasks/${f.task.id}/agent-requester-credentials`, f.bob, f.issueBody))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await f.call(`tasks/${f.task.id}/agent-requester-credentials`, f.alice, {
          ...f.issueBody,
          shareConfirmed: false,
        })
      ).statusCode,
      422,
    );
    const identity = success(await f.requesterCall('identity'));
    assert.equal(identity.kind, 'agent');
    assert.equal(identity.role, 'requester');
    assert.equal(identity.participantId, f.requester.id);
    assert.equal(identity.connectionId, f.issued.credential.id);
    for (const hidden of [f.task.id, f.project.id, f.alice.user.id, f.bob.user.id, f.alice.spaceId])
      assert.equal(JSON.stringify(identity).includes(hidden), false, hidden);
    for (const extra of [
      { cookie: f.alice.cookie },
      { origin: 'http://127.0.0.1:4310' },
      { 'x-hexu-client': 'web' },
      { 'x-hexu-space': f.alice.spaceId },
      { 'x-hexu-runner': '1' },
      { 'sec-fetch-site': 'same-origin' },
    ])
      assert.equal(
        (await f.requesterCall('identity', undefined, randomUUID(), extra)).statusCode,
        403,
      );
    for (const path of [
      '/agent/v1/identity',
      '/agent-assistance/v1/identity',
      `/api/v1/tasks/${f.task.id}`,
    ])
      assert.equal((await f.requesterCall(path)).statusCode, 401, path);
    const old = success(
      await f.call(`agent-participants/${f.requester.id}/connection`, f.alice, {
        expectedRevision: 0,
        projectId: f.project.id,
        expiresAt: f.expiresAt,
      }),
    );
    assert.equal(
      (
        await f.requesterCall('identity', undefined, randomUUID(), {
          authorization: `Bearer ${old.token}`,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: '/agent-requester/v1/identity',
          headers: { cookie: f.alice.cookie, 'x-hexu-agent-api': '1' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test('requester API rejects version/schema mismatch and exposes only fixed selected material', async () => {
  const f = await requesterFixture();
  try {
    for (const version of [undefined, '0', '2']) {
      const rejected = await f.requesterCall('identity', undefined, randomUUID(), {
        'x-hexu-agent-api': version,
      });
      assert.equal(rejected.statusCode, 409, rejected.body);
    }
    for (const path of ['materials?expand=task', 'events', 'requests/unknown/events'])
      assert.equal((await f.requesterCall(path)).statusCode, 404, path);
    const materialsResponse = await f.requesterCall('materials');
    const materials = success(materialsResponse);
    assert.equal(materialsResponse.headers['cache-control'], 'no-store');
    assert.deepEqual(
      materials.materials.map((m: { id: string }) => m.id),
      f.preview.materials.map((material: { id: string }) => material.id),
    );
    assert.ok(materialsResponse.body.includes(REQUESTER_VISIBLE));
    for (const hidden of [
      REQUESTER_HIDDEN,
      f.task.title,
      f.task.id,
      f.project.id,
      f.message.id,
      f.source.id,
      f.unshared.content,
    ])
      assert.equal(materialsResponse.body.includes(hidden), false, hidden);
    for (const body of [
      { ...f.input, ownerUserId: f.bob.user.id },
      { ...f.input, taskId: 'foreign-task' },
      { ...f.input, materialIds: ['message', f.unshared.id] },
      { ...f.input, materialIds: ['message', 'unapproved-material'] },
      { ...f.input, materialIds: f.input.materialIds.filter((id: string) => id !== 'message') },
    ]) {
      const rejected = await f.requesterCall('preview', body);
      assert.ok([400, 403, 404, 422].includes(rejected.statusCode), rejected.body);
    }
    const subset = success(
      await f.requesterCall('preview', { ...f.input, materialIds: ['message'] }),
    );
    assert.deepEqual(
      subset.materials.map((m: { id: string }) => m.id),
      ['message'],
    );
    assert.equal(
      (await f.requesterCall('requests', { ...f.createBody, expectedInputHash: '0'.repeat(64) }))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await f.requesterCall('requests', {
          ...f.createBody,
          expectedTaskRevision: f.createBody.expectedTaskRevision + 1,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.requesterCall('requests', {
          ...f.createBody,
          actor: { kind: 'human', userId: f.alice.user.id },
        })
      ).statusCode,
      400,
    );
    assert.equal(count(f, 'assistances'), 0);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('requester creation receipt survives lost result, rejects changed replay, and records real agent source', async () => {
  const f = await requesterFixture();
  try {
    const key = randomUUID();
    assert.deepEqual(success(await f.requesterCall(`receipts/${key}`)), { status: 'not_recorded' });
    const created = success(await f.requesterCall('requests', f.createBody, key), 201);
    const createdOutbox = count(f, 'outbox');
    const recovered = success(await f.requesterCall(`receipts/${key}`));
    assert.equal(recovered.status, 'recorded');
    assert.equal(recovered.request.requestId, created.requestId);
    assert.equal(
      success(await f.requesterCall('requests', f.createBody, key), 201).requestId,
      created.requestId,
    );
    assert.equal(
      (await f.requesterCall('requests', { ...f.createBody, question: 'Changed replay' }, key))
        .statusCode,
      409,
    );
    assert.equal(count(f, 'assistances'), 1);
    assert.equal(count(f, 'assistance_agent_requests'), 1);
    assert.equal(
      count(f, 'outbox'),
      createdOutbox,
      'create replay and receipt reads do not append outbox',
    );
    assert.equal(count(f, 'runs'), 0);
    const storedInput = f.store.db
      .prepare('SELECT body FROM assistance_input_revisions WHERE revision=1')
      .get() as { body: string };
    const actor = JSON.parse(storedInput.body).actor;
    assert.equal(actor.kind, 'agent');
    assert.equal(actor.participantId, f.requester.id);
    assert.equal(actor.ownerUserId, f.alice.user.id);
    assert.equal(actor.connectionId, f.issued.credential.id);
    const listed = success(await f.requesterCall('requests'));
    assert.deepEqual(
      listed.items.map((item: { requestId: string }) => item.requestId),
      [created.requestId],
    );
    const alternate = success(
      await f.call(`tasks/${f.task.id}/agent-requester-credentials`, f.alice, f.issueBody),
      201,
    );
    const otherHeaders = { authorization: `Bearer ${alternate.token}` };
    const foreign = await f.requesterCall(
      'requests/unknown',
      undefined,
      randomUUID(),
      otherHeaders,
    );
    assert.equal(foreign.statusCode, 404);
    const receiver = await receiverCredential(f, created.requestId);
    assert.equal(
      (
        await f.requesterCall('identity', undefined, randomUUID(), {
          authorization: `Bearer ${receiver.token}`,
        })
      ).statusCode,
      401,
    );
    const revoke = await f.call(
      `tasks/${f.task.id}/agent-requester-credentials/${f.issued.credential.id}/revoke`,
      f.alice,
      { expectedRevision: f.issued.credential.revision },
    );
    success(revoke);
    for (const [path, body] of [
      [`receipts/${key}`, undefined],
      [`requests/${created.requestId}`, undefined],
      ['requests', f.createBody],
      [`requests/${created.requestId}/cancel`, { expectedRevision: created.revision }],
    ] as const)
      assert.equal((await f.requesterCall(path, body, key)).statusCode, 401, path);
    assert.equal(count(f, 'assistances'), 1);
  } finally {
    await f.close();
  }
});

test('requester current project authority wins over old credential and committed receipt', async () => {
  const f = await requesterFixture();
  try {
    const key = randomUUID();
    success(await f.requesterCall('requests', f.createBody, key), 201);
    success(
      await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
        role: 'manage',
      }),
    );
    success(
      await f.call(`projects/${f.project.id}/members/${f.alice.user.id}`, f.bob, { role: 'view' }),
    );
    assert.equal((await f.requesterCall('identity')).statusCode, 401);
    assert.equal((await f.requesterCall(`receipts/${key}`)).statusCode, 401);
    assert.equal((await f.requesterCall('requests', f.createBody, key)).statusCode, 401);
    assert.equal(count(f, 'assistances'), 1);
  } finally {
    await f.close();
  }
});

test('requester cancellation revokes receiver material and response access without creating a Run', async () => {
  const f = await requesterFixture();
  try {
    const created = success(await f.requesterCall('requests', f.createBody), 201);
    const receiver = await receiverCredential(f, created.requestId);
    const url = `/agent-assistance/v1/requests/${created.requestId}`;
    const headers = { authorization: `Bearer ${receiver.token}` };
    assert.equal((await f.app.inject({ url, headers })).statusCode, 200);
    const cancelled = success(
      await f.requesterCall(`requests/${created.requestId}/cancel`, {
        expectedRevision: success(await f.requesterCall(`requests/${created.requestId}`)).revision,
      }),
    );
    assert.equal(cancelled.state, 'cancelled');
    assert.equal((await f.app.inject({ url, headers })).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          url: `${url}/responses`,
          method: 'POST',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: {},
        })
      ).statusCode,
      401,
    );
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('requester request visibility is bound to participant and approved material scope; receipts remain connection scoped', async () => {
  const f = await requesterFixture();
  try {
    const createKey = randomUUID();
    const created = success(await f.requesterCall('requests', f.createBody, createKey), 201);
    const narrowSelection = {
      ...f.selection,
      input: { ...f.preview.input, projectTexts: { items: [], expectedHash: '0'.repeat(64) } },
    };
    const narrowPreview = success(
      await f.call(`tasks/${f.task.id}/agent-assistance-preview`, f.alice, narrowSelection),
    );
    const narrow = success(
      await f.call(`tasks/${f.task.id}/agent-requester-credentials`, f.alice, {
        ...f.issueBody,
        preview: { ...narrowSelection, input: narrowPreview.input },
        expectedTaskRevision: narrowPreview.expectedTaskRevision,
        expectedInputHash: narrowPreview.inputHash,
      }),
      201,
    );
    const headers = { authorization: `Bearer ${narrow.token}` };
    const scoped = await f.requesterCall(
      `requests/${created.requestId}`,
      undefined,
      randomUUID(),
      headers,
    );
    assert.equal(scoped.statusCode, 403, scoped.body);
    assert.equal(scoped.body.includes(f.source.content), false);
    assert.deepEqual(success(await f.requesterCall('requests', undefined, randomUUID(), headers)), {
      items: [],
    });
    assert.deepEqual(
      success(await f.requesterCall(`receipts/${createKey}`, undefined, randomUUID(), headers)),
      { status: 'not_recorded' },
    );
    const humanPreview = success(
      await f.call(`tasks/${f.task.id}/agent-assistance-preview`, f.alice, {
        ...f.selection,
        requesterParticipantId: null,
      }),
    );
    const humanRequest = success(
      await f.call(`tasks/${f.task.id}/agent-assistances`, f.alice, {
        target: f.target,
        requesterParticipantId: null,
        input: humanPreview.input,
        expectedTaskRevision: humanPreview.expectedTaskRevision,
        expectedInputHash: humanPreview.inputHash,
        shareConfirmed: true,
      }),
      201,
    );
    const otherId = humanRequest.assistance.agent.requestId;
    const actual = await f.requesterCall(`requests/${otherId}`);
    const unknown = await f.requesterCall('requests/unknown');
    assert.equal(actual.statusCode, 404, actual.body);
    assert.equal(unknown.statusCode, 404, unknown.body);
    assert.deepEqual(actual.json().error, unknown.json().error);
    assert.deepEqual(
      success(await f.requesterCall('requests')).items.map(
        (item: { requestId: string }) => item.requestId,
      ),
      [created.requestId],
    );
    assert.equal(
      (
        await f.requesterCall(`requests/${otherId}/cancel`, {
          expectedRevision: humanRequest.assistance.revision,
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('requester can narrow immutable inputs but cannot re-expand removed material or send changed source versions', async () => {
  const f = await requesterFixture();
  try {
    const created = success(await f.requesterCall('requests', f.createBody), 201);
    const narrowInput = {
      ...f.input,
      clarification: 'Only the selected message is needed.',
      materialIds: ['message'],
    };
    const preview = success(await f.requesterCall('preview', narrowInput));
    const revised = success(
      await f.requesterCall(`requests/${created.requestId}/input-revisions`, {
        ...narrowInput,
        expectedRevision: created.revision,
        expectedInputRevision: created.inputRevision,
        expectedAccessRevision: created.accessRevision,
        expectedTaskRevision: preview.expectedTaskRevision,
        causeResponseId: null,
        expectedInputHash: preview.inputHash,
      }),
      201,
    );
    assert.equal(revised.inputRevision, 2);
    assert.deepEqual(
      revised.materials.map((material: { id: string }) => material.id),
      ['message'],
    );
    const fullInput = { ...f.input, clarification: 'Try to add removed project note again.' };
    const fullPreview = success(await f.requesterCall('preview', fullInput));
    const expanded = await f.requesterCall(`requests/${created.requestId}/input-revisions`, {
      ...fullInput,
      expectedRevision: revised.revision,
      expectedInputRevision: revised.inputRevision,
      expectedAccessRevision: revised.accessRevision,
      expectedTaskRevision: fullPreview.expectedTaskRevision,
      causeResponseId: null,
      expectedInputHash: fullPreview.inputHash,
    });
    assert.equal(expanded.statusCode, 403, expanded.body);
    assert.equal(count(f, 'assistance_input_revisions'), 2);
    const originalInput = f.store.db
      .prepare('SELECT body FROM assistance_input_revisions WHERE revision=1')
      .get() as { body: string };
    assert.equal(JSON.parse(originalInput.body).materials.length, 2);
    success(
      await f.call(
        `projects/${f.project.id}/sources/${f.source.id}`,
        f.alice,
        {
          expectedRevision: f.source.revision,
          title: f.source.title,
          content: 'A new unapproved version.',
          url: null,
        },
        randomUUID(),
        'PATCH',
      ),
    );
    const stalePreview = await f.requesterCall('preview', f.input);
    assert.equal(stalePreview.statusCode, 409, stalePreview.body);
    assert.equal(stalePreview.json().error.code, 'INPUT_STALE');
    assert.equal((await f.requesterCall('requests', f.createBody)).statusCode, 409);
    assert.equal(count(f, 'assistances'), 1);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});

test('project material IDs track source identity across order, subsets, independent requester grants and new versions', async () => {
  const f = await requesterFixture();
  try {
    const b = success(
      await f.call(`projects/${f.project.id}/sources`, f.alice, {
        kind: 'text',
        title: 'Explicit second approved note',
        content: 'Stable source B, version 1.',
        url: null,
      }),
      201,
    );
    const all = await approveRequesterSources(f, [f.source, b]);
    const onlyB = await approveRequesterSources(f, [b]);
    const reverse = await approveRequesterSources(f, [b, f.source]);
    const bId = `text-${createHash('sha256').update(b.id).digest('hex')}`;
    const aId = `text-${createHash('sha256').update(f.source.id).digest('hex')}`;
    assert.notEqual(bId, aId);
    assert.deepEqual(
      all.preview.materials.map((material: { id: string }) => material.id),
      ['message', aId, bId],
    );
    assert.deepEqual(
      onlyB.preview.materials.map((material: { id: string }) => material.id),
      ['message', bId],
    );
    assert.deepEqual(
      reverse.preview.materials.map((material: { id: string }) => material.id),
      ['message', bId, aId],
    );
    const allHeaders = { authorization: `Bearer ${all.issued.token}` };
    const limited = {
      question: f.input.question,
      clarification: null,
      materialIds: ['message', bId],
    };
    const subset = success(await f.requesterCall('preview', limited, randomUUID(), allHeaders));
    assert.deepEqual(subset.materials, onlyB.preview.materials);
    assert.equal(subset.inputHash, onlyB.preview.inputHash);
    const catalog = success(
      await f.requesterCall('materials', undefined, randomUUID(), {
        authorization: `Bearer ${onlyB.issued.token}`,
      }),
    );
    assert.deepEqual(catalog.materials, onlyB.preview.materials);
    assert.equal(
      JSON.stringify(catalog).includes(b.id),
      false,
      'opaque IDs must not reveal source IDs',
    );
    const updated = success(
      await f.call(
        `projects/${f.project.id}/sources/${b.id}`,
        f.alice,
        {
          expectedRevision: b.revision,
          title: b.title,
          content: 'Stable source B, version 2.',
          url: null,
        },
        randomUUID(),
        'PATCH',
      ),
    );
    const next = await approveRequesterSources(f, [updated]);
    assert.deepEqual(
      next.preview.materials.map((material: { id: string }) => material.id),
      ['message', bId],
    );
    assert.notEqual(next.preview.inputHash, onlyB.preview.inputHash);
    assert.equal(next.preview.materials[1].text, updated.content);
    const stale = await f.requesterCall('preview', limited, randomUUID(), allHeaders);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, 'INPUT_STALE');
    const denied = await f.requesterCall(
      'requests',
      {
        ...limited,
        expectedTaskRevision: next.preview.expectedTaskRevision,
        expectedInputHash: next.preview.inputHash,
      },
      randomUUID(),
      { authorization: `Bearer ${onlyB.issued.token}` },
    );
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(count(f, 'assistances'), 0);
  } finally {
    await f.close();
  }
});

test('pre-existing legacy material snapshots stay immutable and receiver-readable without new requester takeover', async () => {
  const f = await requesterFixture();
  try {
    const modern = success(await f.requesterCall('requests', f.createBody), 201);
    const envelope = f.store.db
      .prepare('SELECT * FROM assistance_agent_requests WHERE request_id=?')
      .get(modern.requestId) as Record<string, any>;
    const assistance = JSON.parse(
      (
        f.store.db
          .prepare('SELECT body FROM assistances WHERE id=?')
          .get(envelope.assistance_id) as { body: string }
      ).body,
    );
    const input = JSON.parse(
      (
        f.store.db
          .prepare(
            'SELECT body FROM assistance_input_revisions WHERE assistance_id=? AND revision=1',
          )
          .get(envelope.assistance_id) as { body: string }
      ).body,
    );
    const legacyAssistanceId = randomUUID(),
      legacyRequestId = randomUUID();
    assistance.id = legacyAssistanceId;
    input.materials = input.materials.map(
      (material: { id: string; label: string; text: string }, index: number) => ({
        ...material,
        id: index ? `text-${index}` : 'message',
      }),
    );
    const digest = (value: unknown) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex');
    input.selection.projectTexts.expectedHash = digest(input.materials.slice(1));
    input.inputHash = digest({ selection: input.selection, materials: input.materials });
    input.actor = { kind: 'human', userId: f.alice.user.id };
    const savedLegacyInput = JSON.stringify(input);
    // Seed a separate pre-existing slice-2 fixture, preserving its original positional IDs.
    // Never update an immutable input, drop a trigger, or run a data migration to create it.
    f.store.atomic(() => {
      f.store.db
        .prepare('INSERT INTO assistances VALUES(?,?,?,?,?,?,?)')
        .run(
          legacyAssistanceId,
          f.alice.spaceId,
          f.task.id,
          f.alice.user.id,
          f.bob.user.id,
          assistance.state,
          JSON.stringify(assistance),
        );
      f.store.db
        .prepare('INSERT INTO assistance_agent_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          legacyAssistanceId,
          legacyRequestId,
          envelope.recipient_participant_id,
          envelope.requester_participant_id,
          envelope.grant_id,
          envelope.capability_id,
          envelope.capability_version,
          envelope.endpoint_revision,
          envelope.grant_revision,
          1,
          envelope.access_revision,
          null,
          envelope.body,
        );
      f.store.db
        .prepare('INSERT INTO assistance_input_revisions VALUES(?,?,?,?)')
        .run(legacyAssistanceId, 1, input.inputHash, savedLegacyInput);
      for (const scope of ['material_read', 'respond'])
        f.store.db
          .prepare('INSERT INTO assistance_input_grants VALUES(?,?,?,?,?,?,?,NULL)')
          .run(legacyAssistanceId, 1, f.receiver.id, scope, input.inputHash, 1, f.expiresAt);
    });
    const owner = success(await f.call(`assistances/${legacyAssistanceId}`, f.alice));
    assert.equal(owner.assistance.sourceChanged, false);
    assert.deepEqual(
      owner.assistance.agent.materials.map((material: { id: string }) => material.id),
      ['message', 'text-1'],
    );
    const denied = await f.requesterCall(`requests/${legacyRequestId}`);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error.code, 'AGENT_SCOPE_REQUIRED');
    assert.deepEqual(
      success(await f.requesterCall('requests')).items.map(
        (item: { requestId: string }) => item.requestId,
      ),
      [modern.requestId],
    );
    const receiver = await receiverCredential(f, legacyRequestId);
    const read = () =>
      f.app.inject({
        url: `/agent-assistance/v1/requests/${legacyRequestId}`,
        headers: { authorization: `Bearer ${receiver.token}` },
      });
    let current = success(await read());
    const respond = (type: string, body?: string) =>
      f.app.inject({
        url: `/agent-assistance/v1/requests/${legacyRequestId}/responses`,
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
      });
    current = success(await respond('accept'), 201);
    current = success(
      await respond(
        'answer',
        'The legacy source remains readable under its original receiver grant.',
      ),
      201,
    );
    assert.equal(current.phase, 'answered');
    const after = f.store.db
      .prepare('SELECT body FROM assistance_input_revisions WHERE assistance_id=? AND revision=1')
      .get(legacyAssistanceId) as { body: string };
    assert.equal(after.body, savedLegacyInput);
    assert.equal((await f.requesterCall(`requests/${legacyRequestId}`)).statusCode, 403);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await f.close();
  }
});
