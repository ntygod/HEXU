/** Independent, deterministic protocol fixture. No dot, model, commands, or remote deployment. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';

const VERSION = '2026-07-28';
const EVENT = 'hexu.assistance.changed';
let config: { baseURL: string; token: string; secret: string; callback: string };
let subscriptionId: string | undefined;
let verificationSubscription: string | undefined;
let dropped = false;
const seen = new Set<string>();
const stats = {
  pid: process.pid,
  bootstrapCalls: 0,
  challenges: 0,
  duplicates: 0,
  rejected: 0,
  receivedIds: [] as string[],
  processedIds: [] as string[],
  reads: [] as unknown[],
  writes: [] as { requestId: string; type: string; inputRevision: number }[],
};
let queue: Promise<void> = Promise.resolve();
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${config.baseURL}/collaboration/mcp`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: {
      authorization: `Bearer ${config.token}`,
      'x-hexu-agent-api': '1',
      'content-type': 'application/json',
      'mcp-protocol-version': VERSION,
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSION,
          'io.modelcontextprotocol/clientCapabilities': { events: {} },
        },
      },
    }),
  });
  const b = (await r.json()) as any;
  assert.equal(r.status, 200, JSON.stringify(b.error));
  assert.equal(b.error, undefined);
  return b.result;
}
async function tool(name: string, args: Record<string, unknown>) {
  return (await rpc('tools/call', { name, arguments: args })).structuredContent;
}
function authenticated(raw: string, headers: IncomingHttpHeaders) {
  const id = headers['webhook-id'],
    time = headers['webhook-timestamp'];
  if (
    typeof id !== 'string' ||
    typeof time !== 'string' ||
    !/^\d+$/.test(time) ||
    Math.abs(Date.now() / 1000 - Number(time)) > 300
  )
    return false;
  const expected = createHmac('sha256', Buffer.from(config.secret.slice(6), 'base64'))
    .update(`${id}.${time}.${raw}`)
    .digest();
  return String(headers['webhook-signature'])
    .split(' ')
    .some((v) => {
      if (!v.startsWith('v1,')) return false;
      const received = Buffer.from(v.slice(3), 'base64');
      return received.length === expected.length && timingSafeEqual(received, expected);
    });
}
async function handleHint(requestId: string) {
  // Hints and all material are untrusted data. Only this finite hard-coded script chooses work.
  let view = await tool('hexu_get_request', { requestId });
  const input = await tool('hexu_read_materials', { requestId, inputRevision: view.inputRevision });
  stats.reads.push(input);
  const respond = async (type: string, body?: string) => {
    const args = {
      requestId,
      operationKey: `fixture-${requestId}-${view.inputRevision}-${type}`,
      response: {
        type,
        ...(body === undefined ? {} : { body }),
        expectedRevision: view.revision,
        inputRevision: view.inputRevision,
        expectedInputHash: view.inputHash,
        expectedAccessRevision: view.accessRevision,
      },
    };
    view = await tool('hexu_respond', args);
    // Same frozen operation is replayed over actual HTTP; it must not append a response.
    assert.deepEqual(await tool('hexu_respond', args), view);
    stats.writes.push({ requestId, type, inputRevision: view.inputRevision });
  };
  if (view.phase === 'answered' || view.phase === 'terminal' || view.phase === 'waiting_input')
    return;
  if (view.inputRevision === 1) {
    await respond('request_input', 'Which API version should the fixed excerpt target?');
  } else if (view.inputRevision === 2) {
    assert.equal(input.clarification, 'Target API version 2; use only the fixed selected message.');
    if (view.phase === 'awaiting_acceptance') await respond('accept');
    await respond('answer', 'Fixture-only answer: use the version 2 compatibility adapter.');
  } else throw new Error('Unexpected fixture input revision');
}
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/callback');
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      assert.ok(Buffer.byteLength(raw) <= 16384);
    }
    if (!authenticated(raw, req.headers)) {
      stats.rejected++;
      res.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw);
    if (body.type === 'verification') {
      assert.deepEqual(Object.keys(body).sort(), ['challenge', 'type']);
      assert.equal(typeof body.challenge, 'string');
      assert.equal(typeof req.headers['x-mcp-subscription-id'], 'string');
      verificationSubscription = String(req.headers['x-mcp-subscription-id']);
      stats.challenges++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ challenge: body.challenge }));
      return;
    }
    assert.equal(req.headers['x-mcp-subscription-id'], subscriptionId);
    assert.equal(body.name, EVENT);
    assert.equal(body.eventId, req.headers['webhook-id']);
    assert.deepEqual(Object.keys(body.data), ['requestId']);
    assert.match(body.data.requestId, /^[A-Za-z0-9_-]{1,150}$/);
    stats.receivedIds.push(body.eventId);
    const work = queue.then(async () => {
      if (seen.has(body.eventId)) {
        stats.duplicates++;
        return;
      }
      assert.ok(seen.size < 256);
      await handleHint(body.data.requestId);
      seen.add(body.eventId);
      stats.processedIds.push(body.eventId);
    });
    queue = work.catch(() => {});
    await work;
    if (!dropped) {
      dropped = true;
      res.destroy(); // Processing committed, but the first callback receipt is lost.
    } else res.writeHead(204).end();
  } catch {
    // Never dump tokens, callback bytes or material to stderr.
    res.writeHead(500).end();
  }
});
process.on('message', async (message: any) => {
  const { id, command } = message;
  try {
    if (command === 'listen') {
      config = message.config;
      const url = new URL(config.baseURL);
      assert.equal(url.protocol, 'http:');
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(url.pathname, '/');
      assert.equal(url.username + url.password + url.search + url.hash, '');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      process.send!({ id, result: { port: address.port, pid: process.pid } });
    } else if (command === 'bootstrap') {
      assert.equal(stats.bootstrapCalls++, 0);
      const discovery = await rpc('server/discover');
      assert.deepEqual(discovery.capabilities, { tools: {}, events: {} });
      assert.equal((await rpc('events/list')).events[0].name, EVENT);
      const sub = await rpc('events/subscribe', {
        name: EVENT,
        arguments: {},
        ttlMs: 600000,
        delivery: { mode: 'webhook', url: config.callback, secret: config.secret },
      });
      subscriptionId = sub.id;
      assert.equal(subscriptionId, verificationSubscription);
      assert.deepEqual(await tool('hexu_list_requests', {}), { items: [] });
      process.send!({ id, result: { subscriptionId } });
    } else if (command === 'stats') {
      await queue;
      process.send!({ id, result: stats });
    } else throw new Error('Unknown fixture command');
  } catch (e) {
    process.send!({ id, error: e instanceof Error ? e.message : 'Fixture failed' });
  }
});
process.on('disconnect', () => {
  server.closeAllConnections();
  server.close();
});
