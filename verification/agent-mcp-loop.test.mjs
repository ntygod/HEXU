// Independent JSON-line stdio clients -> production MCP bridge -> full createApp -> BetterAuth/SQLite.
// All accounts/credentials are disposable fixtures. No model, provider, browser, native runtime,
// parent-file writes, remote deployment, or original-thread result consumption is exercised.
// Receiver bootstrap explicitly issues ONE request credential as its owner before the dialogue;
// this does not demonstrate automatic receipt of newly created requests or a receiver inbox.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = resolve(process.env.HEXU_SERVER_DIST ?? 'dist');
const { requesterFixture, receiverCredential, approveRequesterSources, REQUESTER_HIDDEN } =
  await import(pathToFileURL(resolve(dist, 'tests/helpers/agent-requester.js')));
const main = resolve(dist, 'apps/mcp/src/main.js');
const rpcVersion = '2025-11-25';

class WireClient {
  pending = new Map();
  sequence = 0;
  stderr = '';
  output = [];
  constructor(origin, role, token, requestId) {
    // Deliberately does not import MCP server functions, validators, transports, or an MCP SDK.
    this.child = spawn(process.execPath, [main], {
      env: {
        HEXU_CONTROL_URL: origin,
        HEXU_AGENT_ROLE: role,
        HEXU_AGENT_TOKEN: token,
        ...(requestId ? { HEXU_REQUEST_ID: requestId } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        this.rejectAll(new Error('Non-JSON MCP stdout'));
        return;
      }
      this.output.push(response);
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(response);
      }
    });
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('exit', (code, signal) =>
      this.rejectAll(new Error(`MCP exited (${code}, ${signal}): ${this.stderr}`)),
    );
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  rpc(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}; ${this.stderr}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async initialize() {
    const initialized = await this.rpc('initialize', {
      protocolVersion: rpcVersion,
      capabilities: {},
      clientInfo: { name: 'independent-fixture-wire-client', version: '1' },
    });
    assert.equal(initialized.result?.protocolVersion, rpcVersion, JSON.stringify(initialized));
    this.notify('notifications/initialized');
    return initialized.result;
  }
  async call(name, args = {}) {
    const response = await this.rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  }
  async value(name, args = {}) {
    const result = await this.call(name, args);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent;
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const timeout = setTimeout(() => this.child.kill('SIGTERM'), 1000);
    await once(this.child, 'exit');
    clearTimeout(timeout);
    this.lines.close();
  }
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function response(view, type, body) {
  return {
    expectedRevision: view.revision,
    inputRevision: view.inputRevision,
    expectedInputHash: view.inputHash,
    expectedAccessRevision: view.accessRevision,
    type,
    ...(body === undefined ? {} : { body }),
  };
}
function count(f, table) {
  return f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
}

// The relay does not synthesize any application response. It forwards bytes to the real listening
// createApp and drops one response only AFTER that application's SQLite transaction has committed.
function lostCreateRelay(origin) {
  let dropped = false,
    createCalls = 0;
  const server = createServer((incoming, outgoing) => {
    const isCreate = incoming.method === 'POST' && incoming.url === '/agent-requester/v1/requests';
    if (isCreate) createCalls++;
    const upstream = httpRequest(
      new URL(incoming.url, origin),
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: new URL(origin).host },
      },
      (reply) => {
        if (isCreate && !dropped && reply.statusCode === 201) {
          dropped = true;
          reply.resume();
          reply.on('end', () => outgoing.destroy());
        } else {
          outgoing.writeHead(reply.statusCode, reply.headers);
          reply.pipe(outgoing);
        }
      },
    );
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  return {
    server,
    get createCalls() {
      return createCalls;
    },
    get dropped() {
      return dropped;
    },
  };
}

test('real stdio MCP: unknown-create recovery, two-party clarification, answer, exact sources and revocation', async () => {
  const f = await requesterFixture();
  const clients = [];
  let relay;
  try {
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    assert.equal(f.app.server.listening, true);
    relay = lostCreateRelay(origin);
    const relayOrigin = await listen(relay.server);
    const first = new WireClient(relayOrigin, 'requester', f.issued.token);
    clients.push(first);
    const premature = await first.rpc('tools/list');
    assert.equal(premature.error?.code, -32002);
    await first.initialize();
    const catalog = await first.rpc('tools/list');
    const names = catalog.result.tools.map((tool) => tool.name);
    for (const name of [
      'hexu_discover_capabilities',
      'hexu_read_materials',
      'hexu_preview_request',
      'hexu_create_request',
      'hexu_list_requests',
      'hexu_get_request',
      'hexu_find_creation',
      'hexu_revise_input',
      'hexu_cancel',
    ])
      assert.ok(names.includes(name), name);
    assert.equal(names.includes('hexu_respond'), false);
    for (const tool of catalog.result.tools)
      assert.equal(tool.inputSchema.additionalProperties, false);
    const forbidden = await first.rpc('tools/call', {
      name: 'hexu_create_request',
      arguments: { ...f.createBody, operationKey: 'schema-check', ownerUserId: f.bob.user.id },
    });
    assert.equal(forbidden.result?.isError, true);
    assert.equal(forbidden.result?.structuredContent.error.code, 'INVALID_TOOL_INPUT');
    assert.equal(count(f, 'assistances'), 0);
    const discovered = await first.value('hexu_discover_capabilities');
    assert.ok(JSON.stringify(discovered).includes(f.target.capabilityId));
    const materials = await first.value('hexu_read_materials');
    assert.equal(materials.materials.length, 2);
    assert.equal(JSON.stringify(materials).includes(REQUESTER_HIDDEN), false);
    const input = {
      question: 'Does the selected API preserve compatibility?',
      clarification: null,
      materialIds: materials.materials.map((material) => material.id),
    };
    const preview = await first.value('hexu_preview_request', input);
    const createKey = randomUUID();
    const body = {
      ...input,
      expectedTaskRevision: preview.expectedTaskRevision,
      expectedInputHash: preview.inputHash,
      operationKey: createKey,
    };
    const unknown = await first.call('hexu_create_request', body);
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.error.outcome, 'unknown');
    assert.equal(relay.dropped, true);
    assert.equal(relay.createCalls, 1, 'bridge must not retry an unknown write');
    assert.equal(count(f, 'assistances'), 1);
    const originalEnvelope = f.store.db
      .prepare('SELECT assistance_id,request_id FROM assistance_agent_requests')
      .get();
    const originalInput = JSON.parse(
      f.store.db.prepare('SELECT body FROM assistance_input_revisions WHERE revision=1').get().body,
    );
    assert.equal(originalInput.inputHash, preview.inputHash);
    assert.deepEqual(originalInput.materials, preview.materials);
    const originalReceipt = f.store.db
      .prepare('SELECT key,result FROM idempotency_records WHERE key=?')
      .get(createKey);
    assert.equal(originalReceipt.key, createKey);
    assert.equal(JSON.parse(originalReceipt.result).id, originalEnvelope.assistance_id);
    const originalOutbox = count(f, 'outbox');
    await first.close();

    // Restart the bridge; reconciliation is a read of the original key, not another create.
    const requester = new WireClient(origin, 'requester', f.issued.token);
    clients.push(requester);
    await requester.initialize();
    const receipt = await requester.value('hexu_find_creation', { operationKey: createKey });
    assert.equal(receipt.status, 'recorded');
    const created = receipt.request;
    assert.equal(created.requestId, originalEnvelope.request_id);
    assert.equal(created.inputHash, preview.inputHash);
    assert.deepEqual(created.materials, preview.materials);
    assert.equal(
      count(f, 'outbox'),
      originalOutbox,
      'receipt reconciliation must not emit new events',
    );
    assert.equal(
      (await requester.value('hexu_list_requests')).items[0].requestId,
      created.requestId,
    );
    assert.deepEqual(await requester.value('hexu_find_creation', { operationKey: randomUUID() }), {
      status: 'not_recorded',
    });
    assert.equal(count(f, 'assistance_agent_requests'), 1);
    assert.equal(count(f, 'runs'), 0);

    // Authorized fixture owner provisions the already-created request once. No owner actions occur
    // during the following Agent question -> request_input -> new input -> answer exchange.
    const issuedReceiver = await receiverCredential(f, created.requestId);
    const receiver = new WireClient(origin, 'receiver', issuedReceiver.token, created.requestId);
    clients.push(receiver);
    await receiver.initialize();
    const receiverCatalog = await receiver.rpc('tools/list');
    assert.deepEqual(
      receiverCatalog.result.tools.map((tool) => tool.name).sort(),
      ['hexu_get_request', 'hexu_list_requests', 'hexu_read_materials', 'hexu_respond'].sort(),
    );
    assert.equal((await receiver.value('hexu_list_requests')).items.length, 1);
    let received = await receiver.value('hexu_get_request', { requestId: created.requestId });
    for (const hidden of [
      f.task.id,
      f.task.title,
      f.project.id,
      f.message.id,
      f.alice.user.id,
      f.bob.user.id,
      REQUESTER_HIDDEN,
    ])
      assert.equal(JSON.stringify(received).includes(hidden), false, hidden);
    const initialInput = await receiver.value('hexu_read_materials', {
      requestId: created.requestId,
      inputRevision: 1,
    });
    const acceptKey = randomUUID();
    const accept = {
      requestId: created.requestId,
      operationKey: acceptKey,
      response: response(received, 'accept'),
    };
    received = await receiver.value('hexu_respond', accept);
    const acceptedCount = count(f, 'assistance_replies');
    const acceptedOutbox = count(f, 'outbox');
    await receiver.value('hexu_respond', accept);
    assert.equal(
      count(f, 'outbox'),
      acceptedOutbox,
      'duplicate response must not emit a new outbox event',
    );
    assert.equal(
      count(f, 'assistance_replies'),
      acceptedCount,
      'duplicate response must not append twice',
    );
    const waiting = await receiver.value('hexu_respond', {
      requestId: created.requestId,
      operationKey: randomUUID(),
      response: response(received, 'request_input', 'Which API version is intended?'),
    });
    assert.equal(waiting.phase, 'waiting_input');
    const observed = await requester.value('hexu_get_request', { requestId: created.requestId });
    assert.equal(observed.responses.at(-1).body, 'Which API version is intended?');
    const revisedSelection = {
      ...input,
      clarification: 'Version 2. Keep the approved source boundary.',
    };
    const revisedPreview = await requester.value('hexu_preview_request', revisedSelection);
    const revised = await requester.value('hexu_revise_input', {
      ...revisedSelection,
      requestId: created.requestId,
      operationKey: randomUUID(),
      expectedRevision: observed.revision,
      expectedInputRevision: observed.inputRevision,
      expectedAccessRevision: observed.accessRevision,
      expectedTaskRevision: revisedPreview.expectedTaskRevision,
      causeResponseId: observed.responses.at(-1).id,
      expectedInputHash: revisedPreview.inputHash,
    });
    assert.equal(revised.inputRevision, 2);
    assert.equal(revised.phase, 'awaiting_acceptance');
    assert.deepEqual(
      await receiver.value('hexu_read_materials', {
        requestId: created.requestId,
        inputRevision: 1,
      }),
      initialInput,
    );
    received = await receiver.value('hexu_get_request', { requestId: created.requestId });
    assert.equal(received.clarification, revisedSelection.clarification);
    const stale = await receiver.call('hexu_respond', { ...accept, operationKey: randomUUID() });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.outcome, 'rejected');
    received = await receiver.value('hexu_respond', {
      requestId: created.requestId,
      operationKey: randomUUID(),
      response: response(received, 'accept'),
    });
    const answerArgs = {
      requestId: created.requestId,
      operationKey: randomUUID(),
      response: response(
        received,
        'answer',
        'For version 2, preserve the explicitly selected finite text contract.',
      ),
    };
    const answered = await receiver.value('hexu_respond', answerArgs);
    const answeredOutbox = count(f, 'outbox');
    const answeredReplies = count(f, 'assistance_replies');
    await receiver.value('hexu_respond', answerArgs);
    assert.equal(count(f, 'outbox'), answeredOutbox);
    assert.equal(count(f, 'assistance_replies'), answeredReplies);
    assert.equal(answered.phase, 'answered');
    const final = await requester.value('hexu_get_request', { requestId: created.requestId });
    assert.equal(final.responses.at(-1).type, 'answer');
    assert.equal(final.responses.at(-1).inputRevision, 2);
    assert.equal(final.responses.at(-1).actor.kind, 'agent');
    assert.equal(final.responses.at(-1).actor.participantId, f.receiver.id);
    const storedInputs = f.store.db
      .prepare('SELECT body FROM assistance_input_revisions ORDER BY revision')
      .all()
      .map((row) => JSON.parse(row.body));
    assert.equal(storedInputs.length, 2);
    for (const item of storedInputs) {
      assert.equal(item.actor.kind, 'agent');
      assert.equal(item.actor.participantId, f.requester.id);
      assert.equal(item.actor.connectionId, f.issued.credential.id);
    }
    assert.equal(count(f, 'assistances'), 1);
    assert.equal(count(f, 'assistance_agent_requests'), 1);
    assert.equal(count(f, 'runs'), 0);
    const ownerDetail = await f.call(`assistances/${issuedReceiver.assistanceId}`, f.alice);
    assert.equal(ownerDetail.statusCode, 200, ownerDetail.body);
    assert.equal(ownerDetail.json().assistance.agent.requestId, created.requestId);
    assert.equal(ownerDetail.json().assistance.state, 'responded');
    assert.equal(
      JSON.stringify(
        f.store.db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id),
      ).includes(answerArgs.response.body),
      false,
    );
    const foreign = await receiver.call('hexu_get_request', { requestId: 'foreign-request' });
    assert.equal(foreign.isError, true);
    assert.equal(foreign.structuredContent.error.code, 'NOT_FOUND');
    const receiverRevoke = await f.call(
      `assistances/${issuedReceiver.assistanceId}/credentials/revoke`,
      f.bob,
      { action: 'revoke', expectedRevision: issuedReceiver.credential.revision },
    );
    assert.equal(receiverRevoke.statusCode, 200, receiverRevoke.body);
    for (const [name, args] of [
      ['hexu_get_request', { requestId: created.requestId }],
      ['hexu_respond', answerArgs],
    ]) {
      const denied = await receiver.call(name, args);
      assert.equal(denied.isError, true);
      assert.equal(denied.structuredContent.error.outcome, 'rejected');
    }
    const requesterRevoke = await f.call(
      `tasks/${f.task.id}/agent-requester-credentials/${f.issued.credential.id}/revoke`,
      f.alice,
      { expectedRevision: f.issued.credential.revision },
    );
    assert.equal(requesterRevoke.statusCode, 200, requesterRevoke.body);
    assert.equal(
      (await requester.call('hexu_find_creation', { operationKey: createKey })).isError,
      true,
    );
    assert.equal((await requester.call('hexu_create_request', body)).isError, true);
    assert.equal(count(f, 'assistances'), 1);
    for (const client of clients) {
      assert.equal(client.stderr.includes(f.issued.token), false);
      assert.equal(client.stderr.includes(issuedReceiver.token), false);
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    if (relay?.server.listening) await closeServer(relay.server);
    await f.close();
  }
});

test('stdio MCP negotiates its supported version and rejects unavailable methods/role tools', async () => {
  const f = await requesterFixture();
  const clients = [];
  try {
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    assert.equal(f.app.server.listening, true);
    const client = new WireClient(origin, 'requester', f.issued.token);
    clients.push(client);
    const negotiation = await client.rpc('initialize', {
      protocolVersion: '1999-01-01',
      capabilities: {},
      clientInfo: { name: 'unsupported-version-fixture', version: '1' },
    });
    // MCP permits a server to reply with the supported version; the incompatible client stops.
    if (negotiation.result) assert.equal(negotiation.result.protocolVersion, rpcVersion);
    else assert.equal(typeof negotiation.error.code, 'number');
    await client.close();
    const valid = new WireClient(origin, 'requester', f.issued.token);
    clients.push(valid);
    await valid.initialize();
    assert.equal((await valid.rpc('resources/list')).error?.code, -32601);
    assert.equal(
      (await valid.rpc('tools/call', { name: 'hexu_respond', arguments: {} })).error?.code,
      -32602,
    );
    assert.equal(
      (
        await valid.rpc('tools/call', {
          name: 'hexu_get_request',
          arguments: { requestId: '../escape' },
        })
      ).result?.structuredContent.error.code,
      'INVALID_TOOL_INPUT',
    );
    assert.equal(count(f, 'assistances'), 0);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await f.close();
  }
});

test('stable material IDs preserve MCP subset -> human clarification -> independent-grant MCP -> receiver answer', async () => {
  const f = await requesterFixture();
  const clients = [];
  const ownerValue = async (promise, expected = 200) => {
    const result = await promise;
    assert.equal(result.statusCode, expected, result.body);
    return result.json();
  };
  try {
    const sourceB = await ownerValue(
      f.call(`projects/${f.project.id}/sources`, f.alice, {
        kind: 'text',
        title: 'Mixed-route source B',
        content: 'Only the second approved project source.',
        url: null,
      }),
      201,
    );
    const all = await approveRequesterSources(f, [f.source, sourceB]);
    const onlyB = await approveRequesterSources(f, [sourceB]);
    const bId = all.preview.materials.find((material) => material.label === sourceB.title).id;
    assert.equal(onlyB.preview.materials[1].id, bId);
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    assert.equal(f.app.server.listening, true);
    const initialRequester = new WireClient(origin, 'requester', all.issued.token);
    clients.push(initialRequester);
    await initialRequester.initialize();
    const selection = {
      question: 'Review only source B.',
      clarification: null,
      materialIds: ['message', bId],
    };
    const preview = await initialRequester.value('hexu_preview_request', selection);
    assert.deepEqual(
      preview.materials.map((material) => material.id),
      ['message', bId],
    );
    let current = await initialRequester.value('hexu_create_request', {
      ...selection,
      operationKey: randomUUID(),
      expectedTaskRevision: preview.expectedTaskRevision,
      expectedInputHash: preview.inputHash,
    });
    const requestId = current.requestId;
    const receiverGrant = await receiverCredential(f, requestId);
    const receiver = new WireClient(origin, 'receiver', receiverGrant.token, requestId);
    clients.push(receiver);
    await receiver.initialize();
    current = await receiver.value('hexu_get_request', { requestId });
    current = await receiver.value('hexu_respond', {
      requestId,
      operationKey: randomUUID(),
      response: response(current, 'accept'),
    });
    current = await receiver.value('hexu_respond', {
      requestId,
      operationKey: randomUUID(),
      response: response(
        current,
        'request_input',
        'Please confirm version and keep source B only.',
      ),
    });

    // Intentionally use the existing human preview/revision routes at this cross-surface seam.
    // This is an interoperability regression, not the no-human-relay milestone demonstration.
    const humanPreview = await ownerValue(
      f.call(`tasks/${f.task.id}/agent-assistance-preview`, f.alice, {
        ...onlyB.selection,
        input: {
          ...onlyB.selection.input,
          question: selection.question,
          clarification: 'A human confirms version 2.',
        },
      }),
    );
    assert.deepEqual(
      humanPreview.materials.map((material) => material.id),
      ['message', bId],
    );
    const humanRevised = await ownerValue(
      f.call(`assistances/${receiverGrant.assistanceId}/input-revisions`, f.alice, {
        expectedRevision: current.revision,
        expectedInputRevision: current.inputRevision,
        expectedAccessRevision: current.accessRevision,
        expectedTaskRevision: humanPreview.expectedTaskRevision,
        causeResponseId: current.responses.at(-1).id,
        input: humanPreview.input,
        expectedInputHash: humanPreview.inputHash,
        shareConfirmed: true,
      }),
      201,
    );
    assert.equal(humanRevised.assistance.agent.currentInputRevision, 2);
    await initialRequester.close();

    // A separately approved B-only grant must refer to the same source with the same opaque ID.
    const nextRequester = new WireClient(origin, 'requester', onlyB.issued.token);
    clients.push(nextRequester);
    await nextRequester.initialize();
    const catalog = await nextRequester.value('hexu_read_materials');
    assert.equal(catalog.materials[1].id, bId);
    current = await nextRequester.value('hexu_get_request', { requestId });
    assert.equal(current.inputRevision, 2);
    assert.equal(current.clarification, humanPreview.clarification);
    const nextSelection = {
      ...selection,
      clarification: 'Version 2 confirmed; return a finite text answer.',
    };
    const nextPreview = await nextRequester.value('hexu_preview_request', nextSelection);
    current = await nextRequester.value('hexu_revise_input', {
      ...nextSelection,
      requestId,
      operationKey: randomUUID(),
      expectedRevision: current.revision,
      expectedInputRevision: current.inputRevision,
      expectedAccessRevision: current.accessRevision,
      expectedTaskRevision: nextPreview.expectedTaskRevision,
      causeResponseId: null,
      expectedInputHash: nextPreview.inputHash,
    });
    assert.equal(current.inputRevision, 3);
    current = await receiver.value('hexu_get_request', { requestId });
    assert.deepEqual(
      current.materials.map((material) => material.id),
      ['message', bId],
    );
    assert.equal(current.materials[1].text, sourceB.content);
    assert.equal(JSON.stringify(current.materials).includes(f.source.content), false);
    current = await receiver.value('hexu_respond', {
      requestId,
      operationKey: randomUUID(),
      response: response(current, 'accept'),
    });
    const answered = await receiver.value('hexu_respond', {
      requestId,
      operationKey: randomUUID(),
      response: response(
        current,
        'answer',
        'Answer based only on unchanged source B and the approved message.',
      ),
    });
    assert.equal(answered.phase, 'answered');
    const final = await nextRequester.value('hexu_get_request', { requestId });
    assert.equal(final.responses.at(-1).inputRevision, 3);
    const inputs = f.store.db
      .prepare('SELECT body FROM assistance_input_revisions ORDER BY revision')
      .all()
      .map((row) => JSON.parse(row.body));
    assert.deepEqual(
      inputs.map((input) => input.actor.kind),
      ['agent', 'human', 'agent'],
    );
    for (const input of inputs) {
      assert.deepEqual(
        input.materials.map((material) => material.id),
        ['message', bId],
      );
      assert.equal(input.selection.projectTexts.items[0].id, sourceB.id);
      assert.equal(input.selection.projectTexts.items[0].revision, sourceB.revision);
    }
    assert.equal(count(f, 'assistances'), 1);
    assert.equal(count(f, 'runs'), 0);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await f.close();
  }
});
