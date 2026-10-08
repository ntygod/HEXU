import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentEvents, EVENT_NAME } from '../apps/control/src/agent-events.js';
import type { WebhookSender } from '../apps/control/src/event-webhook.js';
import { requesterFixture, REQUESTER_HIDDEN } from './helpers/agent-requester.js';

const KEY = Buffer.alloc(32, 91);
const SECRET = `whsec_${Buffer.alloc(32, 31).toString('base64')}`;
const CALLBACK = 'https://fixture.example.invalid/independent-callback';
const origin = {
  provider: 'codex',
  threadRef: 'fixture-original-thread',
  sessionRef: 'fixture-original-session',
};
const success = (r: { statusCode: number; body: string; json(): any }, expected = 200) => {
  assert.equal(r.statusCode, expected, r.body);
  return r.json();
};
function pendingCalls(child: ChildProcess) {
  const pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  const receive = (message: any) => {
    const waiter = pending.get(String(message.id));
    if (!waiter) return;
    pending.delete(String(message.id));
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  };
  child.on('exit', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Fixture process exited before response'));
    }
    pending.clear();
  });
  const call = (send: (id: string) => void) =>
    new Promise<any>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Fixture response timed out'));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      send(id);
    });
  return { receive, call };
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
function requester(baseURL: string, token: string) {
  // Actual classic MCP executable in another OS process; no provider or model is launched.
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../apps/mcp/src/main.js', import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        HEXU_CONTROL_URL: baseURL,
        HEXU_AGENT_ROLE: 'requester',
        HEXU_AGENT_TOKEN: token,
        HEXU_ORIGIN_PROVIDER: origin.provider,
        HEXU_ORIGIN_THREAD: origin.threadRef,
        HEXU_ORIGIN_SESSION: origin.sessionRef,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const calls = pendingCalls(child);
  createInterface({ input: child.stdout }).on('line', (line) => calls.receive(JSON.parse(line)));
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    calls.call((id) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    child,
    async initialize() {
      const result = await rpc('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'synthetic-original-requester', version: '1' },
      });
      assert.equal(result.protocolVersion, '2025-11-25');
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
    },
    async tool(name: string, args: Record<string, unknown> = {}) {
      const result = await rpc('tools/call', { name, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    },
  };
}

test(
  'independent signed-event receiver clarifies and answers a bound original requester without per-request provisioning',
  { timeout: 45000 },
  async () => {
    let callbackPort = 0;
    const sent: { raw: string; headers: Record<string, string>; eventId: string }[] = [];
    // Test injection maps a synthetic public URL to a local child. Production HTTPS policy is unchanged.
    const sender: WebhookSender = async (url, raw, headers, authorize) => {
      assert.equal(url, CALLBACK);
      authorize();
      const body = JSON.parse(raw);
      if (body.name === EVENT_NAME) sent.push({ raw, headers, eventId: body.eventId });
      const response = await fetch(`http://127.0.0.1:${callbackPort}/callback`, {
        method: 'POST',
        body: raw,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.text() };
    };
    const f = await requesterFixture({ encryptionKey: KEY, sender, automaticDrain: false });
    let receiver: ChildProcess | undefined;
    let original: ReturnType<typeof requester> | undefined;
    try {
      const issued = success(
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
      const baseURL = await f.app.listen({ host: '127.0.0.1', port: 0 });
      receiver = fork(
        fileURLToPath(new URL('./fixtures/agent-event-receiver.js', import.meta.url)),
        [],
        {
          env: { PATH: process.env.PATH },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      const calls = pendingCalls(receiver);
      receiver.on('message', calls.receive);
      const control = (command: string, fields: Record<string, unknown> = {}) =>
        calls.call((id) => receiver!.send({ id, command, ...fields }));
      const ready = await control('listen', {
        config: { baseURL, token: issued.token, secret: SECRET, callback: CALLBACK },
      });
      callbackPort = ready.port;
      assert.notEqual(ready.pid, process.pid);
      const { subscriptionId } = await control('bootstrap');
      const count = (table: string) =>
        (f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
      assert.equal(count('assistances'), 0, 'subscription is set before new requests exist');
      original = requester(baseURL, f.issued.token);
      await original.initialize();
      const initial = await original.tool('hexu_create_request', {
        ...f.createBody,
        operationKey: 'original-create',
      });
      const requestId = initial.requestId;
      const read = () => original!.tool('hexu_get_request', { requestId });
      const binding = (await original.tool('hexu_get_consumption', { requestId })).binding;
      assert.deepEqual(binding.origin, origin);
      assert.equal(binding.requesterConnectionId, f.issued.credential.id);
      assert.equal(binding.requestId, requestId);
      const events = new AgentEvents(f.store, KEY, sender);
      await events.drain(1);
      const lost = f.store.db
        .prepare('SELECT id,state,attempts FROM agent_event_deliveries WHERE id=?')
        .get(sent[0]!.eventId) as any;
      assert.equal(lost.state, 'unknown');
      assert.equal(lost.attempts, 1);
      const clarification = await read();
      assert.equal(clarification.phase, 'waiting_input');
      assert.equal(clarification.responses.length, 1);
      assert.equal(clarification.responses[0].type, 'request_input');
      assert.equal(clarification.responses[0].actor.kind, 'agent');
      // Explicit duplicate delivery and then outbox retry both preserve the original event ID.
      const first = sent[0]!;
      const duplicate = await sender(CALLBACK, first.raw, first.headers, () => {});
      assert.equal(duplicate.status, 204);
      f.store.db
        .prepare("UPDATE agent_event_deliveries SET next_at='1970-01-01T00:00:00.000Z' WHERE id=?")
        .run(lost.id);
      await events.drain(1);
      assert.deepEqual(
        sent.slice(0, 3).map((x) => x.eventId),
        [lost.id, lost.id, lost.id],
      );
      assert.equal((await read()).responses.length, 1);
      assert.equal(
        (
          f.store.db
            .prepare('SELECT state FROM agent_event_deliveries WHERE id=?')
            .get(lost.id) as any
        ).state,
        'accepted',
      );
      const selection = {
        ...f.input,
        materialIds: ['message'],
        clarification: 'Target API version 2; use only the fixed selected message.',
      };
      const preview = await original.tool('hexu_preview_request', selection);
      const revised = await original.tool('hexu_revise_input', {
        ...selection,
        operationKey: 'original-revision',
        requestId,
        expectedRevision: clarification.revision,
        expectedInputRevision: clarification.inputRevision,
        expectedAccessRevision: clarification.accessRevision,
        expectedTaskRevision: preview.expectedTaskRevision,
        expectedInputHash: preview.inputHash,
        causeResponseId: clarification.responses[0].id,
      });
      assert.equal(revised.inputRevision, 2);
      await events.drain();
      const answer = await read();
      assert.equal(answer.phase, 'answered');
      assert.deepEqual(
        answer.responses.map((r: any) => r.type),
        ['request_input', 'accept', 'answer'],
      );
      const response = answer.responses.find((r: any) => r.type === 'answer');
      const claim = {
        requestId,
        bindingId: binding.id,
        responseId: response.id,
        inputRevision: answer.inputRevision,
        inputHash: answer.inputHash,
        accessRevision: answer.accessRevision,
        operationKey: 'original-consume',
      };
      const consumed = await original.tool('hexu_consume_answer', claim);
      assert.equal(consumed.delivery, 'first');
      assert.equal(consumed.consumption.answer, response.body);
      assert.deepEqual(consumed.consumption.materialIds, ['message']);
      let fixtureContinuations = 0;
      if (consumed.delivery === 'first') fixtureContinuations++;
      const replay = await original.tool('hexu_consume_answer', claim);
      if (replay.delivery === 'first') fixtureContinuations++;
      assert.equal(replay.delivery, 'replay');
      assert.equal(fixtureContinuations, 1);
      const ack = {
        requestId,
        operationKey: 'original-ack',
        consumptionId: consumed.consumption.id,
        bindingId: binding.id,
        turnRef: 'fixture-original-turn-2',
        output: 'Fixture-only original work used the version 2 compatibility adapter.',
      };
      const acknowledged = await original.tool('hexu_ack_consumption', ack);
      assert.deepEqual(
        (await original.tool('hexu_ack_consumption', ack)).consumption,
        acknowledged.consumption,
      );
      assert.deepEqual(acknowledged.binding.origin, origin);
      assert.equal(acknowledged.binding.id, binding.id);
      assert.equal(acknowledged.consumption.acknowledgement.evidence, 'external_self_report');
      assert.equal(acknowledged.consumption.acknowledgement.turnRef, ack.turnRef);
      await events.drain();
      // Authentic but stale timestamps and invalid signatures cannot trigger reads or writes.
      const beforeReject = await control('stats');
      for (const stale of [false, true]) {
        const id = `rejected-${randomUUID()}`;
        const timestamp = String(Math.floor(Date.now() / 1000) - (stale ? 600 : 0));
        const body = JSON.stringify({ eventId: id, name: EVENT_NAME, data: { requestId } });
        const signature = createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64'))
          .update(`${id}.${timestamp}.${body}`)
          .digest('base64');
        const rejected = await fetch(`http://127.0.0.1:${callbackPort}/callback`, {
          method: 'POST',
          body,
          headers: {
            'webhook-id': id,
            'webhook-timestamp': timestamp,
            'webhook-signature': stale ? `v1,${signature}` : 'v1,invalid',
            'x-mcp-subscription-id': subscriptionId,
          },
        });
        assert.equal(rejected.status, 401);
      }
      const stats = await control('stats');
      assert.equal(stats.bootstrapCalls, 1);
      assert.equal(stats.challenges, 1);
      assert.equal(stats.duplicates, 2);
      assert.equal(stats.rejected, 2);
      assert.deepEqual(stats.writes, beforeReject.writes);
      assert.deepEqual(stats.reads, beforeReject.reads);
      assert.equal(stats.processedIds.filter((id: string) => id === lost.id).length, 1);
      assert.deepEqual(
        stats.writes.map((w: any) => [w.type, w.inputRevision]),
        [
          ['request_input', 1],
          ['accept', 2],
          ['answer', 2],
        ],
      );
      assert.equal(JSON.stringify(stats).includes(REQUESTER_HIDDEN), false);
      for (const item of sent) {
        assert.deepEqual(JSON.parse(item.raw).data, { requestId });
        for (const hidden of [
          f.task.id,
          f.project.id,
          f.issued.token,
          issued.token,
          REQUESTER_HIDDEN,
        ])
          assert.equal(item.raw.includes(hidden), false);
      }
      assert.equal(count('tasks'), 1);
      assert.equal(count('assistances'), 1);
      assert.equal(count('runs'), 0);
      assert.equal(count('agent_original_work_bindings'), 1);
      assert.equal(count('agent_result_consumptions'), 1);
      assert.equal(count('agent_receiver_connections'), 1);
      assert.equal(count('agent_event_subscriptions'), 1);
      assert.equal(
        count('assistance_agent_credentials'),
        0,
        'no per-request receiver credential provisioning',
      );
      const final = await original.tool('hexu_get_consumption', { requestId });
      assert.deepEqual(final.binding, binding);
      assert.equal(final.consumption.id, consumed.consumption.id);
      assert.equal(final.consumption.acknowledgement.output, ack.output);
    } finally {
      await stop(original?.child);
      await stop(receiver);
      await f.close();
    }
  },
);
