import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { teamFixture } from './team.js';

/** Disposable real BetterAuth members + full createApp/SQLite. No provider or host runtime. */
export const REQUESTER_VISIBLE = 'Explicitly selected API excerpt.';
export const REQUESTER_HIDDEN = ' Private unselected transcript.';
export async function requesterFixture() {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const member = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'edit',
    });
    assert.equal(member.statusCode, 200, member.body);
    const task = await f.task(alice, project.id, 'Private parent task title');
    const posted = await f.call(`tasks/${task.id}/messages`, alice, {
      body: REQUESTER_VISIBLE + REQUESTER_HIDDEN,
    });
    assert.equal(posted.statusCode, 201, posted.body);
    const message = posted.json();
    const sourcePreview = await f.call(
      `tasks/${task.id}/messages/${message.id}/assistance-preview`,
      alice,
    );
    assert.equal(sourcePreview.statusCode, 200, sourcePreview.body);
    const sourceResponse = await f.call(`projects/${project.id}/sources`, alice, {
      kind: 'text',
      title: 'Approved API note',
      content: 'API version 2 supports finite text.',
      url: null,
    });
    assert.equal(sourceResponse.statusCode, 201, sourceResponse.body);
    const source = sourceResponse.json();
    const unshared = await f.call(`projects/${project.id}/sources`, alice, {
      kind: 'text',
      title: 'Unapproved project text',
      content: 'Do not share this other source.',
      url: null,
    });
    assert.equal(unshared.statusCode, 201, unshared.body);
    const register = async (account: typeof alice, name: string) => {
      const response = await f.call('agent-participants', account, {
        name,
        nativeInstanceRef: null,
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    };
    const requester = await register(alice, 'Disposable requester protocol fixture');
    const receiver = await register(bob, 'Disposable receiver protocol fixture');
    const requesterEndpoint = await f.call(`agent-participants/${requester.id}/endpoint`, alice, {
      expectedRevision: 0,
      protocol: 'mcp',
      address: 'https://fixture.example.invalid/requester-metadata',
      implementation: 'Requester stdio protocol fixture',
      implementationVersion: '1',
      receiveMode: 'poll',
    });
    assert.equal(requesterEndpoint.statusCode, 200, requesterEndpoint.body);
    const endpoint = await f.call(`agent-participants/${receiver.id}/endpoint`, bob, {
      expectedRevision: 0,
      protocol: 'custom',
      address: 'https://fixture.example.invalid/never-fetched',
      implementation: 'Independent stdio protocol fixture',
      implementationVersion: '1',
      receiveMode: 'poll',
    });
    assert.equal(endpoint.statusCode, 200, endpoint.body);
    const capability = await f.call(`agent-participants/${receiver.id}/capability`, bob, {
      expectedRevision: 0,
      title: 'Read-only API expertise',
      description: 'Only approved fixed text.',
    });
    assert.equal(capability.statusCode, 200, capability.body);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const granted = await f.call(`agent-participants/${receiver.id}/grants`, bob, {
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
      participantId: receiver.id,
      capabilityId: resource.capability.id,
      capabilityVersion: 1,
      endpointRevision: 1,
      grantId: resource.grants[0].id,
      grantRevision: 1,
    };
    const selection = {
      target,
      requesterParticipantId: requester.id,
      input: {
        question: 'Explain compatibility for the selected API.',
        clarification: null,
        message: {
          sourceMessageId: message.id,
          expectedSourceHash: sourcePreview.json().sourceHash,
          range: { start: 0, end: REQUESTER_VISIBLE.length },
        },
        projectTexts: {
          items: [
            {
              id: source.id,
              revision: source.revision,
              contentHash: source.contentHash,
              maxChars: 1000,
            },
          ],
          expectedHash: '0'.repeat(64),
        },
      },
    };
    const previewResponse = await f.call(
      `tasks/${task.id}/agent-assistance-preview`,
      alice,
      selection,
    );
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json();
    const issueBody = {
      participantId: requester.id,
      preview: { ...selection, input: preview.input },
      expectedTaskRevision: preview.expectedTaskRevision,
      expectedInputHash: preview.inputHash,
      shareConfirmed: true,
      expiresAt,
    };
    const issueKey = randomUUID();
    const issue = await f.call(
      `tasks/${task.id}/agent-requester-credentials`,
      alice,
      issueBody,
      issueKey,
    );
    assert.equal(issue.statusCode, 201, issue.body);
    const issued = issue.json();
    const requesterCall = (
      path: string,
      payload?: unknown,
      key = randomUUID(),
      headers: Record<string, string | undefined> = {},
    ) =>
      f.app.inject({
        url: path.startsWith('/') ? path : `/agent-requester/v1/${path}`,
        method: payload === undefined ? 'GET' : 'POST',
        headers: Object.fromEntries(
          Object.entries({
            authorization: `Bearer ${issued.token}`,
            'x-hexu-agent-api': '1',
            'idempotency-key': key,
            ...headers,
          }).filter(([, value]) => value !== undefined),
        ),
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    const input = {
      question: selection.input.question,
      clarification: null,
      materialIds: preview.materials.map((m: { id: string }) => m.id) as string[],
    };
    const previewRequest = await requesterCall('preview', input);
    assert.equal(previewRequest.statusCode, 200, previewRequest.body);
    const createBody = {
      ...input,
      expectedTaskRevision: previewRequest.json().expectedTaskRevision,
      expectedInputHash: previewRequest.json().inputHash,
    };
    return {
      ...f,
      alice,
      bob,
      project,
      task,
      message,
      source,
      unshared: unshared.json(),
      requester,
      receiver,
      target,
      expiresAt,
      selection,
      preview,
      issueBody,
      issueKey,
      issued,
      requesterCall,
      input,
      createBody,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

export async function receiverCredential(
  f: Awaited<ReturnType<typeof requesterFixture>>,
  requestId: string,
) {
  // Explicit owner fixture bootstrap for this ONE existing request, not automatic new-request receiving.
  const row = f.store.db
    .prepare('SELECT assistance_id FROM assistance_agent_requests WHERE request_id=?')
    .get(requestId) as { assistance_id: string };
  assert.ok(row);
  const issue = await f.call(`assistances/${row.assistance_id}/credentials`, f.bob, {
    expectedRevision: 0,
    scopes: ['material_read', 'respond'],
    expiresAt: f.expiresAt,
  });
  assert.equal(issue.statusCode, 200, issue.body);
  return { ...issue.json(), assistanceId: row.assistance_id };
}

/** Owner fixture approval used to compare equivalent material scopes across independent grants. */
export async function approveRequesterSources(
  f: Awaited<ReturnType<typeof requesterFixture>>,
  sources: Array<{ id: string; revision: number; contentHash: string }>,
) {
  const selection = {
    ...f.selection,
    input: {
      ...f.selection.input,
      projectTexts: {
        items: sources.map((source) => ({
          id: source.id,
          revision: source.revision,
          contentHash: source.contentHash,
          maxChars: 1000,
        })),
        expectedHash: '0'.repeat(64),
      },
    },
  };
  const previewResponse = await f.call(
    `tasks/${f.task.id}/agent-assistance-preview`,
    f.alice,
    selection,
  );
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json();
  const selected = { ...selection, input: preview.input };
  const response = await f.call(`tasks/${f.task.id}/agent-requester-credentials`, f.alice, {
    ...f.issueBody,
    preview: selected,
    expectedTaskRevision: preview.expectedTaskRevision,
    expectedInputHash: preview.inputHash,
  });
  assert.equal(response.statusCode, 201, response.body);
  return { preview, issued: response.json(), selection: selected };
}
