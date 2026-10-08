import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { teamFixture } from './helpers/team.js';

const visible = '明确选择的接口问题';
const hidden = '不应外发的后半段';

test('真实账号 HTTP：请求限定 Agent 凭据、材料投影、协商回复、幂等与撤权隔离', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const member = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'edit',
    });
    assert.equal(member.statusCode, 200, member.body);
    const task = await f.task(alice, project.id, '不可披露的父任务标题');
    const posted = await f.call(`tasks/${task.id}/messages`, alice, { body: visible + hidden });
    assert.equal(posted.statusCode, 201, posted.body);
    const message = posted.json();
    const source = await f.call(
      `tasks/${task.id}/messages/${message.id}/assistance-preview`,
      alice,
    );
    assert.equal(source.statusCode, 200, source.body);
    const registered = await f.call('agent-participants', bob, {
      name: '有限文本接收端',
      nativeInstanceRef: null,
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const participantId = registered.json().id;
    const endpoint = await f.call(`agent-participants/${participantId}/endpoint`, bob, {
      expectedRevision: 0,
      protocol: 'custom',
      address: 'https://fixture.example.invalid/agent',
      implementation: 'fictional test',
      implementationVersion: '1',
      receiveMode: 'poll',
    });
    assert.equal(endpoint.statusCode, 200, endpoint.body);
    const capability = await f.call(`agent-participants/${participantId}/capability`, bob, {
      expectedRevision: 0,
      title: '文本分析',
      description: '仅分析明确提供的材料',
    });
    assert.equal(capability.statusCode, 200, capability.body);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const granted = await f.call(`agent-participants/${participantId}/grants`, bob, {
      projectId: project.id,
      audience: 'selected_members',
      requesterUserIds: [alice.user.id],
      request: true,
      autoAccept: false,
      expiresAt,
      maxConcurrent: 2,
      costBearer: 'owner',
      expectedCapabilityVersion: 1,
      expectedEndpointRevision: 1,
    });
    assert.equal(granted.statusCode, 201, granted.body);
    const resource = granted.json();
    const target = {
      participantId,
      capabilityId: resource.capability.id,
      capabilityVersion: 1,
      endpointRevision: 1,
      grantId: resource.grants[0].id,
      grantRevision: 1,
    };
    const selection = {
      target,
      requesterParticipantId: null,
      input: {
        question: '请分析所选问题',
        clarification: null,
        message: {
          sourceMessageId: message.id,
          expectedSourceHash: source.json().sourceHash,
          range: { start: 0, end: visible.length },
        },
        projectTexts: { items: [], expectedHash: '0'.repeat(64) },
      },
    };
    const preview = await f.call(`tasks/${task.id}/agent-assistance-preview`, alice, selection);
    assert.equal(preview.statusCode, 200, preview.body);
    const createBody = {
      ...selection,
      input: preview.json().input,
      expectedTaskRevision: preview.json().expectedTaskRevision,
      expectedInputHash: preview.json().inputHash,
      shareConfirmed: true,
    };
    const created = await f.call(`tasks/${task.id}/agent-assistances`, alice, createBody);
    assert.equal(created.statusCode, 201, created.body);
    const assistanceId = created.json().assistance.id;
    const requestId = created.json().assistance.agent.requestId;
    const base = `/agent-assistance/v1/requests/${requestId}`;
    const credentialBody = { expectedRevision: 0, scopes: ['material_read', 'respond'], expiresAt };
    const deniedIssue = await f.call(
      `assistances/${assistanceId}/credentials`,
      alice,
      credentialBody,
    );
    assert.equal(deniedIssue.statusCode, 404, deniedIssue.body);
    const issueKey = randomUUID();
    const issued = await f.call(
      `assistances/${assistanceId}/credentials`,
      bob,
      credentialBody,
      issueKey,
    );
    assert.equal(issued.statusCode, 200, issued.body);
    const token = issued.json().token as string;
    assert.match(token, /^hexu_request_[A-Za-z0-9_-]{43}$/);
    const issueReplay = await f.call(
      `assistances/${assistanceId}/credentials`,
      bob,
      credentialBody,
      issueKey,
    );
    assert.equal(issueReplay.statusCode, 200, issueReplay.body);
    assert.equal(issueReplay.json().token, null);
    assert.equal(
      JSON.stringify(
        f.store.db.prepare('SELECT * FROM assistance_agent_credentials').all(),
      ).includes(token),
      false,
    );
    const agent = (
      path: string,
      payload?: unknown,
      key = randomUUID(),
      extra: Record<string, string | undefined> = {},
    ) =>
      f.app.inject({
        url: path,
        method: payload === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, ...extra },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    const identity = await agent('/agent-assistance/v1/identity');
    assert.equal(identity.statusCode, 200, identity.body);
    assert.deepEqual(Object.keys(identity.json()).sort(), [
      'connectionId',
      'connectionRevision',
      'kind',
      'participantId',
    ]);
    const detail = await agent(base);
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.headers['cache-control'], 'no-store');
    for (const secret of [
      hidden,
      task.title,
      task.id,
      project.id,
      message.id,
      alice.user.id,
      bob.user.id,
      alice.spaceId,
    ])
      assert.equal(detail.body.includes(secret), false, secret);
    assert.ok(detail.body.includes(visible));
    assert.equal((await agent(`${base}/input-revisions/1`)).statusCode, 200);
    for (const extra of [
      { cookie: bob.cookie },
      { origin: 'http://127.0.0.1:4310' },
      { 'x-hexu-runner': '1' },
      { 'x-hexu-space': bob.spaceId },
      { 'sec-fetch-site': 'same-origin' },
    ])
      assert.equal((await agent(base, undefined, randomUUID(), extra)).statusCode, 403);
    assert.equal((await agent(`${base}?expand=task`)).statusCode, 404);
    assert.equal((await agent(`${base}/events`)).statusCode, 404);
    const otherCreated = await f.call(`tasks/${task.id}/agent-assistances`, alice, createBody);
    assert.equal(otherCreated.statusCode, 201, otherCreated.body);
    const foreignRequestId = otherCreated.json().assistance.agent.requestId;
    for (const [suffix, payload] of [
      ['', undefined],
      ['/input-revisions/1', undefined],
      ['/responses', {}],
    ] as const) {
      const unknown = await agent(
        `/agent-assistance/v1/requests/unknown-request${suffix}`,
        payload,
      );
      const foreign = await agent(
        `/agent-assistance/v1/requests/${foreignRequestId}${suffix}`,
        payload,
      );
      assert.equal(unknown.statusCode, 404, unknown.body);
      assert.equal(foreign.statusCode, 404, foreign.body);
      // Correlation IDs are necessarily per-request; all semantic payload fields must match.
      assert.equal(typeof unknown.json().requestId, 'string');
      assert.equal(typeof foreign.json().requestId, 'string');
      assert.deepEqual(
        { ...unknown.json<Record<string, unknown>>(), requestId: '<correlation>' },
        { ...foreign.json<Record<string, unknown>>(), requestId: '<correlation>' },
      );
    }

    assert.equal((await agent('/agent/v1/identity')).statusCode, 401);
    assert.equal((await agent(`/api/v1/tasks/${task.id}`)).statusCode, 401);
    const oldConnection = await f.call(`agent-participants/${participantId}/connection`, bob, {
      expectedRevision: 0,
      projectId: project.id,
      expiresAt,
    });
    assert.equal(oldConnection.statusCode, 200, oldConnection.body);
    assert.equal(
      (
        await f.app.inject({
          url: base,
          headers: { authorization: `Bearer ${oldConnection.json().token}` },
        })
      ).statusCode,
      401,
    );
    for (const path of ['/agent/v1/identity', `/agent/v1/projects/${project.id}/capabilities`]) {
      const capabilityRead = await f.app.inject({
        url: path,
        headers: { authorization: `Bearer ${oldConnection.json().token}` },
      });
      assert.equal(capabilityRead.statusCode, 200, capabilityRead.body);
    }
    const capabilityWrite = await f.app.inject({
      url: `${base}/responses`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${oldConnection.json().token}`,
        'idempotency-key': randomUUID(),
      },
      payload: {},
    });
    assert.equal(capabilityWrite.statusCode, 401, capabilityWrite.body);
    const response = (view: Record<string, unknown>, type: string, body?: string) => ({
      expectedRevision: view.revision,
      inputRevision: view.inputRevision,
      expectedInputHash: view.inputHash,
      expectedAccessRevision: view.accessRevision,
      type,
      ...(body === undefined ? {} : { body }),
    });
    const acceptBody = response(detail.json(), 'accept');
    const acceptKey = randomUUID();
    const accepted = await agent(`${base}/responses`, acceptBody, acceptKey);
    assert.equal(accepted.statusCode, 201, accepted.body);
    const replay = await agent(`${base}/responses`, acceptBody, acceptKey);
    assert.equal(replay.statusCode, 201, replay.body);
    let afterAccept = await agent(base);
    assert.equal(afterAccept.json().phase, 'accepted');
    const clarificationRequest = await agent(
      `${base}/responses`,
      response(afterAccept.json(), 'request_input', '请补充预期结果'),
    );
    assert.equal(clarificationRequest.statusCode, 201, clarificationRequest.body);
    assert.equal(clarificationRequest.json().phase, 'waiting_input');
    const revisedSelection = {
      ...selection,
      input: { ...preview.json().input, clarification: '预期只返回建议文字' },
    };
    const revisedPreview = await f.call(
      `tasks/${task.id}/agent-assistance-preview`,
      alice,
      revisedSelection,
    );
    assert.equal(revisedPreview.statusCode, 200, revisedPreview.body);
    const waiting = clarificationRequest.json();
    const revised = await f.call(`assistances/${assistanceId}/input-revisions`, alice, {
      expectedRevision: waiting.revision,
      expectedInputRevision: waiting.inputRevision,
      expectedAccessRevision: waiting.accessRevision,
      expectedTaskRevision: revisedPreview.json().expectedTaskRevision,
      causeResponseId: waiting.responses.at(-1).id,
      input: revisedPreview.json().input,
      expectedInputHash: revisedPreview.json().inputHash,
      shareConfirmed: true,
    });
    assert.equal(revised.statusCode, 201, revised.body);
    const fresh = await agent(base);
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(fresh.json().inputRevision, 2);
    assert.equal((await agent(`${base}/input-revisions/2`)).statusCode, 200);
    assert.equal((await agent(`${base}/responses`, acceptBody, acceptKey)).statusCode, 201);
    for (const stale of [
      acceptBody,
      { ...response(fresh.json(), 'accept'), expectedInputHash: '0'.repeat(64) },
      { ...response(fresh.json(), 'accept'), expectedAccessRevision: 1 },
      { ...response(fresh.json(), 'accept'), inputRevision: 1 },
    ]) {
      const rejected = await agent(`${base}/responses`, stale);
      assert.equal(rejected.statusCode, 409, rejected.body);
    }
    const acceptedAgain = await agent(`${base}/responses`, response(fresh.json(), 'accept'));
    assert.equal(acceptedAgain.statusCode, 201, acceptedAgain.body);
    afterAccept = await agent(base);
    const answerBody = response(afterAccept.json(), 'answer', '仅根据固定片段给出的建议');
    const answerKey = randomUUID();
    const answer = await agent(`${base}/responses`, answerBody, answerKey);
    assert.equal(answer.statusCode, 201, answer.body);
    assert.equal((await agent(base)).json().phase, 'answered');
    const oversized = await agent(`${base}/responses`, { data: 'x'.repeat(65536) });
    assert.equal(oversized.statusCode, 413, oversized.body);
    const finalView = await agent(base);
    for (const secret of [
      task.id,
      project.id,
      message.id,
      alice.user.id,
      bob.user.id,
      alice.spaceId,
    ])
      assert.equal(finalView.body.includes(secret), false, secret);
    const rotated = await f.call(`assistances/${assistanceId}/credentials`, bob, {
      expectedRevision: 1,
      scopes: ['material_read'],
      expiresAt,
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.equal((await agent(base)).statusCode, 401);
    const readHeaders = { authorization: `Bearer ${rotated.json().token}` };
    assert.equal((await agent(base, undefined, randomUUID(), readHeaders)).statusCode, 200);
    assert.equal(
      (await agent(`${base}/responses`, answerBody, randomUUID(), readHeaders)).statusCode,
      403,
    );
    const revoked = await f.call(`assistances/${assistanceId}/credentials/revoke`, bob, {
      action: 'revoke',
      expectedRevision: 2,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal((await agent(base)).statusCode, 401);
    assert.equal((await agent(`${base}/responses`, answerBody, answerKey)).statusCode, 401);
    assert.equal(
      (f.store.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (
        f.store.db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id) as { body: string }
      ).body.includes('仅根据固定片段给出的建议'),
      false,
    );
  } finally {
    await f.close();
  }
});
