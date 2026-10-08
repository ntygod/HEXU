import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { test } from 'node:test';
import { requesterFixture, REQUESTER_HIDDEN } from './helpers/agent-requester.js';
import { AgentEvents, EVENT_NAME } from '../apps/control/src/agent-events.js';
import { MCP_PATH, MCP_VERSION } from '../apps/control/src/agent-mcp-http.js';
import { createApp } from '../apps/control/src/app.js';
import type { WebhookSender } from '../apps/control/src/event-webhook.js';
import { Store } from '../packages/db/src/store.js';

const KEY = Buffer.alloc(32, 71);
const SECRET = `whsec_${Buffer.alloc(32, 19).toString('base64')}`;
const ROTATED = `whsec_${Buffer.alloc(32, 23).toString('base64')}`;
const CALLBACK = 'https://callback.example.invalid/finite?opaque=fixture-only';
const META = {
  'io.modelcontextprotocol/protocolVersion': MCP_VERSION,
  'io.modelcontextprotocol/clientCapabilities': { events: {} },
};
const ok = (r: { statusCode: number; body: string; json(): any }, code = 200) => {
  assert.equal(r.statusCode, code, r.body);
  return r.json();
};
const result = (r: Parameters<typeof ok>[0]) => {
  const body = ok(r);
  assert.equal(body.error, undefined, JSON.stringify(body));
  return body.result;
};
const subscription = (secret = SECRET) => ({
  name: EVENT_NAME,
  arguments: {},
  delivery: { mode: 'webhook', url: CALLBACK, secret },
  ttlMs: 600000,
});
const response = (view: any, type = 'accept') => ({
  type,
  ...(type === 'accept' ? {} : { body: 'Finite fixture answer.' }),
  expectedRevision: view.revision,
  inputRevision: view.inputRevision,
  expectedInputHash: view.inputHash,
  expectedAccessRevision: view.accessRevision,
});
function wire(token: string, method: string, params: Record<string, unknown> = {}) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      'x-hexu-agent-api': '1',
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_VERSION,
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
    },
    payload: { jsonrpc: '2.0', id: randomUUID(), method, params: { ...params, _meta: META } },
  };
}
async function fixture() {
  const sent: Array<{ body: any; raw: string; headers: IncomingHttpHeaders }> = [];
  const behavior: {
    challenge: boolean;
    loseResponse: boolean;
    status: number;
    challengeGate?: () => Promise<void>;
  } = { challenge: true, loseResponse: false, status: 204 };
  // Synthetic receiver only. Production HTTPS sender and its public-address policy are untouched.
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const body = JSON.parse(raw);
    sent.push({ body, raw, headers: req.headers });
    if (body.type === 'verification') {
      await behavior.challengeGate?.();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ challenge: behavior.challenge ? body.challenge : 'wrong' }));
    } else if (behavior.loseResponse) {
      // Bytes reached the independent receiver, but no receipt reached HEXU.
      res.destroy();
    } else {
      res.writeHead(behavior.status);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sender: WebhookSender = async (url, body, headers, authorize) => {
    assert.equal(url, CALLBACK);
    authorize();
    const received = await fetch(`http://127.0.0.1:${address.port}/fixture`, {
      method: 'POST',
      body,
      headers,
    });
    return { status: received.status, body: await received.text() };
  };
  const f = await requesterFixture({
    encryptionKey: KEY,
    sender,
    automaticDrain: false,
  });
  try {
    const base = `agent-participants/${f.receiver.id}/receiver-connections`;
    const issued = ok(
      await f.call(base, f.bob, {
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
    const mcp = (method: string, params: Record<string, unknown> = {}) =>
      f.app.inject({ method: 'POST', url: MCP_PATH, ...wire(issued.token, method, params) });
    const tool = async (name: string, args: Record<string, unknown> = {}) =>
      result(await mcp('tools/call', { name, arguments: args })).structuredContent;
    const events = new AgentEvents(f.store, KEY, sender);
    const deliveries = () =>
      f.store.db
        .prepare('SELECT * FROM agent_event_deliveries ORDER BY sequence,id')
        .all() as Array<{ id: string; state: string; attempts: number; request_id: string }>;
    return {
      ...f,
      base,
      issued,
      mcp,
      tool,
      events,
      sender,
      sent,
      behavior,
      deliveries,
      async close() {
        await f.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      },
    };
  } catch (error) {
    await f.close();
    server.closeAllConnections();
    server.close();
    throw error;
  }
}
function verifySignature(item: { raw: string; headers: IncomingHttpHeaders }, secret: string) {
  const id = item.headers['webhook-id'],
    timestamp = item.headers['webhook-timestamp'];
  assert.equal(typeof id, 'string');
  assert.equal(typeof timestamp, 'string');
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${item.raw}`)
    .digest('base64');
  assert.ok(String(item.headers['webhook-signature']).split(' ').includes(`v1,${signature}`));
}

test('MCP2 HTTP discovery, metadata, headers and narrow tools use real app authentication', async () => {
  const f = await fixture();
  try {
    const discovery = result(await f.mcp('server/discover'));
    assert.deepEqual(discovery.capabilities, { tools: {}, events: {} });
    assert.deepEqual(discovery.supportedVersions, [MCP_VERSION]);
    assert.equal(result(await f.mcp('events/list')).events[0].name, EVENT_NAME);
    assert.deepEqual(
      result(await f.mcp('tools/list')).tools.map((t: any) => t.name),
      ['hexu_get_request', 'hexu_list_requests', 'hexu_read_materials', 'hexu_respond'],
    );
    assert.deepEqual(await f.tool('hexu_list_requests'), { items: [] });
    const good = wire(f.issued.token, 'server/discover');
    for (const header of ['mcp-method', 'mcp-protocol-version']) {
      const headers: Record<string, string> = { ...good.headers };
      delete headers[header];
      assert.equal(
        ok(
          await f.app.inject({ method: 'POST', url: MCP_PATH, headers, payload: good.payload }),
          400,
        ).error.code,
        -32020,
      );
    }
    const old = {
      ...good.payload,
      params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
    };
    assert.equal(
      ok(
        await f.app.inject({ method: 'POST', url: MCP_PATH, headers: good.headers, payload: old }),
        400,
      ).error.code,
      -32022,
    );
    assert.equal(
      ok(
        await f.app.inject({
          method: 'POST',
          url: MCP_PATH,
          headers: good.headers,
          payload: { ...good.payload, params: {} },
        }),
        400,
      ).error.code,
      -32602,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: MCP_PATH,
          headers: { ...good.headers, cookie: f.bob.cookie },
          payload: good.payload,
        })
      ).statusCode,
      403,
    );
    assert.equal((await f.mcp('initialize')).statusCode, 404);
    assert.equal(
      (
        await f.mcp('tools/call', {
          name: 'hexu_get_request',
          arguments: { requestId: 'missing', extra: true },
        })
      ).statusCode,
      400,
    );
    // Independent HTTP client, not Fastify inject, speaks modern wire to the original app.
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const http = await fetch(address + MCP_PATH, {
      method: 'POST',
      headers: good.headers,
      body: JSON.stringify(good.payload),
    });
    assert.equal(http.status, 200);
    assert.equal(http.headers.get('cache-control'), 'no-store');
    assert.equal(((await http.json()) as any).result.resultType, 'complete');
  } finally {
    await f.close();
  }
});

test('subscription precedes request, callback receipt is not business acceptance, and payload is finite', async () => {
  const f = await fixture();
  try {
    const sub = result(await f.mcp('events/subscribe', subscription()));
    verifySignature(f.sent[0]!, SECRET);
    assert.equal(f.sent[0]!.body.type, 'verification');
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    assert.ok(f.deliveries().length > 0);
    await f.events.drain();
    const event = f.sent.find((s) => s.body.name === EVENT_NAME)!;
    assert.ok(event);
    verifySignature(event, SECRET);
    assert.equal(event.headers['x-mcp-subscription-id'], sub.id);
    assert.deepEqual(event.body.data, { requestId: created.requestId });
    assert.equal(event.body.eventId, event.headers['webhook-id']);
    assert.equal(JSON.stringify(event.body).includes(REQUESTER_HIDDEN), false);
    const view = await f.tool('hexu_get_request', { requestId: created.requestId });
    assert.notEqual(view.phase, 'accepted');
    assert.equal(view.responses.length, 0);
    assert.equal((await f.tool('hexu_list_requests')).items[0].requestId, created.requestId);
    assert.equal(
      (await f.tool('hexu_read_materials', { requestId: created.requestId, inputRevision: 1 }))
        .revision,
      1,
    );
    assert.ok(f.deliveries().every((d) => d.state === 'accepted'));
    assert.equal(
      (
        f.store.db.prepare('SELECT count(*) n FROM assistance_agent_credentials').get() as {
          n: number;
        }
      ).n,
      0,
    );
    const stored = JSON.stringify(
      f.store.db.prepare('SELECT * FROM agent_event_subscriptions').all(),
    );
    for (const secret of [CALLBACK, SECRET, f.issued.token])
      assert.equal(stored.includes(secret), false);
  } finally {
    await f.close();
  }
});

test('subscribe refresh is deterministic, rotates signing keys, and rejects bad challenge', async () => {
  const f = await fixture();
  try {
    f.behavior.challenge = false;
    assert.equal(ok(await f.mcp('events/subscribe', subscription()), 400).error.code, -32015);
    assert.equal(f.store.db.prepare('SELECT id FROM agent_event_subscriptions').get(), undefined);
    f.behavior.challenge = true;
    const first = result(await f.mcp('events/subscribe', subscription()));
    const challenges = f.sent.length;
    assert.equal(result(await f.mcp('events/subscribe', subscription())).id, first.id);
    assert.equal(f.sent.length, challenges);
    const rotated = result(await f.mcp('events/subscribe', subscription(ROTATED)));
    assert.equal(rotated.id, first.id);
    assert.equal(f.sent.length, challenges + 1);
    verifySignature(f.sent.at(-1)!, ROTATED);
    assert.equal(result(await f.mcp('events/subscribe', subscription(ROTATED))).id, first.id);
    assert.equal(f.sent.length, challenges + 1);
    assert.equal(
      (f.store.db.prepare('SELECT count(*) n FROM agent_event_subscriptions').get() as any).n,
      1,
    );
    ok(await f.requesterCall('requests', f.createBody), 201);
    await f.events.drain();
    const event = f.sent.find((s) => s.body.name === EVENT_NAME)!;
    verifySignature(event, SECRET);
    verifySignature(event, ROTATED);
    assert.equal(String(event.headers['webhook-signature']).split(' ').length, 2);
  } finally {
    await f.close();
  }
});

test('assistance, idempotent receipt and unique event outbox commit or roll back together', async () => {
  const f = await fixture();
  try {
    result(await f.mcp('events/subscribe', subscription()));
    const key = randomUUID();
    const count = () =>
      (f.store.db.prepare('SELECT count(*) n FROM assistance_agent_requests').get() as any).n;
    const before = count();
    f.store.db.exec(
      "CREATE TRIGGER fixture_reject_event BEFORE INSERT ON agent_event_deliveries BEGIN SELECT RAISE(ABORT,'fixture event storage failure'); END",
    );
    assert.equal((await f.requesterCall('requests', f.createBody, key)).statusCode, 500);
    assert.equal(count(), before);
    assert.equal(f.deliveries().length, 0);
    f.store.db.exec('DROP TRIGGER fixture_reject_event');
    const created = ok(await f.requesterCall('requests', f.createBody, key), 201);
    const ids = f.deliveries().map((d) => d.id);
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(
      ok(await f.requesterCall('requests', f.createBody, key), 201).requestId,
      created.requestId,
    );
    assert.deepEqual(
      f.deliveries().map((d) => d.id),
      ids,
    );
    const rows = f.store.db
      .prepare(
        'SELECT d.id,o.assistance_id FROM agent_event_deliveries d JOIN outbox o ON o.sequence=d.sequence',
      )
      .all();
    assert.equal(rows.length, ids.length);
  } finally {
    await f.close();
  }
});

test('lost callback receipt retries same event ID; duplicate and out-of-order tool writes retain business idempotency', async () => {
  const f = await fixture();
  try {
    result(await f.mcp('events/subscribe', subscription()));
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    f.behavior.loseResponse = true;
    await f.events.drain();
    const first = f.sent.filter((s) => s.body.name === EVENT_NAME).map((s) => s.body.eventId);
    assert.ok(first.length > 0);
    assert.ok(f.deliveries().every((d) => d.state === 'unknown'));
    f.behavior.loseResponse = false;
    f.store.db
      .prepare("UPDATE agent_event_deliveries SET next_at='1970-01-01T00:00:00.000Z'")
      .run();
    await f.events.drain();
    assert.deepEqual(
      f.sent
        .filter((s) => s.body.name === EVENT_NAME)
        .slice(first.length)
        .map((s) => s.body.eventId),
      first,
    );
    const view = await f.tool('hexu_get_request', { requestId: created.requestId });
    const args = {
      requestId: created.requestId,
      operationKey: randomUUID(),
      response: response(view),
    };
    const accepted = await f.tool('hexu_respond', args);
    const after = f.deliveries().length;
    assert.deepEqual(await f.tool('hexu_respond', args), accepted);
    assert.equal(f.deliveries().length, after);
    assert.equal(
      (
        await f.mcp('tools/call', {
          name: 'hexu_respond',
          arguments: { ...args, operationKey: randomUUID() },
        })
      ).statusCode,
      409,
    );
    const answered = await f.tool('hexu_respond', {
      requestId: created.requestId,
      operationKey: randomUUID(),
      response: response(accepted, 'answer'),
    });
    assert.equal(answered.phase, 'answered');
    assert.equal(answered.responses.length, 2);
  } finally {
    await f.close();
  }
});

test('durable subscriptions and inflight unknown receipts survive closing and reopening original store/app', async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const sub = result(await f.mcp('events/subscribe', subscription()));
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    const ids = f.deliveries().map((d) => d.id);
    f.store.db.prepare("UPDATE agent_event_deliveries SET state='inflight',attempts=1").run();
    await f.app.close();
    const store = new Store(f.dbPath, undefined, { team: true });
    reopened = await createApp({
      store,
      identity: f.options,
      events: { encryptionKey: KEY, sender: f.sender, automaticDrain: false },
    });
    const events = new AgentEvents(store, KEY, f.sender);
    assert.equal(
      (store.db.prepare('SELECT id FROM agent_event_subscriptions').get() as any).id,
      sub.id,
    );
    await events.drain();
    assert.deepEqual(
      f.sent.filter((s) => s.body.name === EVENT_NAME).map((s) => s.body.eventId),
      ids,
    );
    const read = result(
      await reopened.inject({
        method: 'POST',
        url: MCP_PATH,
        ...wire(f.issued.token, 'tools/call', {
          name: 'hexu_get_request',
          arguments: { requestId: created.requestId },
        }),
      }),
    );
    assert.equal(read.structuredContent.responses.length, 0);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('expiry, unsubscribe and connection revocation suppress delivery before any callback send', async () => {
  const f = await fixture();
  try {
    result(await f.mcp('events/subscribe', subscription()));
    ok(await f.requesterCall('requests', f.createBody), 201);
    f.store.db
      .prepare("UPDATE agent_event_subscriptions SET expires_at='1970-01-01T00:00:00.000Z'")
      .run();
    const sent = f.sent.length;
    await f.events.drain();
    assert.equal(f.sent.length, sent);
    assert.ok(f.deliveries().every((d) => d.state === 'suppressed'));
    result(await f.mcp('events/subscribe', subscription()));
    // Re-enqueue the saved event observation to test each independent suppression boundary.
    f.store.db.prepare("UPDATE agent_event_deliveries SET state='pending'").run();
    result(
      await f.mcp('events/unsubscribe', {
        name: EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: CALLBACK },
      }),
    );
    await f.events.drain();
    assert.equal(f.sent.length, sent);
    result(await f.mcp('events/subscribe', subscription()));
    const beforeRevoke = f.sent.length;
    f.store.db.prepare("UPDATE agent_event_deliveries SET state='pending'").run();
    ok(await f.call(`${f.base}/${f.issued.credential.id}/revoke`, f.bob, { expectedRevision: 1 }));
    await f.events.drain();
    assert.equal(f.sent.length, beforeRevoke);
    assert.ok(f.deliveries().every((d) => d.state === 'suppressed'));
    assert.equal((await f.mcp('tools/list')).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('held refresh preserves the live subscription and failed challenge cannot create an event gap', async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    const first = result(await f.mcp('events/subscribe', subscription()));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.behavior.challenge = false;
    f.behavior.challengeGate = () => {
      started();
      return gate;
    };
    const pending = f.mcp('events/subscribe', subscription(ROTATED)).then((value) => value);
    await entered;
    const created = ok(await f.requesterCall('requests', f.createBody), 201);
    assert.ok(f.deliveries().some((d) => d.request_id === created.requestId));
    await f.events.drain();
    const event = f.sent.find((s) => s.body.name === EVENT_NAME)!;
    assert.ok(event);
    verifySignature(event, SECRET);
    release!();
    assert.equal(ok(await pending, 400).error.code, -32015);
    const row = f.store.db
      .prepare('SELECT id,revoked_at FROM agent_event_subscriptions')
      .get() as any;
    assert.equal(row.id, first.id);
    assert.equal(row.revoked_at, null);
    assert.equal((await f.tool('hexu_list_requests')).items.length, 1);
  } finally {
    release?.();
    await f.close();
  }
});
