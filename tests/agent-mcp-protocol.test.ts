import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { bridgeConfiguration, BridgeError, HexuTransport } from '../apps/mcp/src/http.js';
import { McpSession, MCP_VERSION } from '../apps/mcp/src/protocol.js';
import { matches, toolsFor } from '../apps/mcp/src/tools.js';
const token = `hexu_requester_${'x'.repeat(43)}`;
const config = () => bridgeConfiguration({ HEXU_AGENT_ROLE: 'requester', HEXU_AGENT_TOKEN: token });

test('MCP configuration is numeric loopback only and credentials remain role-specific', () => {
  assert.equal(config().baseURL, 'http://127.0.0.1:4310');
  for (const url of [
    'https://127.0.0.1',
    'http://localhost:4310',
    'http://127.0.0.1.evil.invalid',
    'http://0.0.0.0',
    'http://user:pw@127.0.0.1',
    'http://127.0.0.1/path',
    'http://127.0.0.1?key=x',
    'http://127.0.0.1#x',
  ])
    assert.throws(() =>
      bridgeConfiguration({
        HEXU_AGENT_ROLE: 'requester',
        HEXU_AGENT_TOKEN: token,
        HEXU_CONTROL_URL: url,
      }),
    );
  for (const invalid of [
    `hexu_agent_${'x'.repeat(43)}`,
    `hexu_request_${'x'.repeat(43)}`,
    'Bearer x',
  ])
    assert.throws(() =>
      bridgeConfiguration({ HEXU_AGENT_ROLE: 'requester', HEXU_AGENT_TOKEN: invalid }),
    );
  assert.throws(() =>
    bridgeConfiguration({
      HEXU_AGENT_ROLE: 'receiver',
      HEXU_AGENT_TOKEN: `hexu_request_${'x'.repeat(43)}`,
    }),
  );
});

test('MCP schemas exactly match finite modes, nested response shapes and revision budgets', () => {
  const requester = toolsFor('requester'),
    receiver = toolsFor('receiver');
  assert.equal(requester.length, 15);
  assert.equal(receiver.length, 4);
  assert.ok(!receiver.some((t) => t.name === 'hexu_create_request'));
  const empty = requester.find((t) => t.name === 'hexu_read_materials')!.inputSchema;
  assert.equal(matches(empty, {}), true);
  assert.equal(matches(empty, { taskId: 'foreign' }), false);
  const schema = receiver.find((t) => t.name === 'hexu_respond')!.inputSchema;
  const valid = {
    requestId: 'r',
    operationKey: 'key',
    response: {
      type: 'accept',
      expectedRevision: 1,
      inputRevision: 1,
      expectedInputHash: 'a'.repeat(64),
      expectedAccessRevision: 1,
    },
  };
  assert.equal(matches(schema, valid), true);
  assert.equal(matches(schema, { ...valid, actor: { userId: 'fake' } }), false);
  assert.equal(
    matches(schema, { ...valid, response: { ...valid.response, body: 'not allowed' } }),
    false,
  );
  assert.equal(
    matches(schema, { ...valid, response: { ...valid.response, expectedRevision: 1.1 } }),
    false,
  );
  assert.equal(
    matches(schema, {
      ...valid,
      response: { ...valid.response, type: 'answer', body: 'x'.repeat(6001) },
    }),
    false,
  );
});

test('MCP lifecycle, role tool allowlist and notifications cannot execute work', async () => {
  let calls = 0;
  const transport = {
    config: config(),
    verify: async () => ({}),
    request: async () => {
      calls++;
      return { items: [] };
    },
  } as unknown as HexuTransport;
  const session = new McpSession(transport);
  const rpc = (id: unknown, method: string, params: unknown = {}) =>
    session.handle({ jsonrpc: '2.0', id, method, params }) as Promise<any>;
  assert.equal((await rpc(1, 'tools/list')).error.code, -32002);
  assert.equal(
    (
      await rpc(2, 'initialize', {
        protocolVersion: 'unknown',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      })
    ).result.protocolVersion,
    MCP_VERSION,
  );
  assert.equal((await rpc(3, 'tools/list')).error.code, -32002);
  assert.equal(
    await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    undefined,
  );
  assert.equal((await rpc(4, 'tools/list')).result.tools.length, 15);
  assert.equal((await rpc(5, 'resources/list')).error.code, -32601);
  assert.equal((await rpc(6, 'events/subscribe')).error.code, -32601);
  assert.equal(
    (await rpc(7, 'tools/call', { name: 'hexu_respond', arguments: {} })).error.code,
    -32602,
  );
  assert.equal(
    (await rpc(8, 'tools/call', { name: 'hexu_list_requests', arguments: { owner: 'fake' } }))
      .result.structuredContent.error.code,
    'INVALID_TOOL_INPUT',
  );
  assert.equal(
    await session.handle({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'hexu_list_requests', arguments: {} },
    }),
    undefined,
  );
  assert.equal(calls, 0);
  const actual = await rpc(9, 'tools/call', { name: 'hexu_list_requests', arguments: {} });
  assert.equal(actual.result.isError, false);
  assert.deepEqual(actual.result.structuredContent, { items: [] });
  assert.equal(calls, 1);
  const optional = await rpc(11, 'tools/call', { name: 'hexu_list_requests' });
  assert.equal(optional.result.isError, false);
  assert.equal(
    (await rpc(12, 'tools/call', { name: 'hexu_get_request' })).result.structuredContent.error.code,
    'INVALID_TOOL_INPUT',
  );
  assert.equal(calls, 2);
  assert.equal((await rpc(10, 'initialize', {})).error.code, -32600);
  assert.equal(((await session.handle([])) as any).error.code, -32600);
  assert.equal((await rpc(null, 'ping')).error.code, -32600);
});

test('MCP transport never follows redirects or retries ambiguous writes', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.writeHead(302, { location: 'http://127.0.0.1:1', 'x-hexu-agent-api': '1' });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const transport = new HexuTransport({
      ...config(),
      baseURL: `http://127.0.0.1:${address.port}`,
    });
    await assert.rejects(
      transport.request('/agent-requester/v1/requests', {}, 'same-key'),
      (e) => e instanceof BridgeError && e.outcome === 'unknown',
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('MCP transport detects API mismatch before interpreting data and does not echo error text', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/version') {
      res.end('{}');
      return;
    }
    res.writeHead(403, { 'x-hexu-agent-api': '1' });
    res.end(JSON.stringify({ error: { code: 'SCOPE_DENIED', message: token } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const transport = new HexuTransport({
      ...config(),
      baseURL: `http://127.0.0.1:${address.port}`,
    });
    await assert.rejects(
      transport.request('/version'),
      (e) => e instanceof BridgeError && e.code === 'API_VERSION_MISMATCH',
    );
    await assert.rejects(
      transport.request('/error', {}, 'k'),
      (e) => e instanceof BridgeError && e.code === 'SCOPE_DENIED' && !e.message.includes(token),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('MCP bounds tool-call rate without forwarding excess work', async () => {
  let calls = 0;
  const transport = {
    config: config(),
    verify: async () => ({}),
    request: async () => {
      calls++;
      return { items: [] };
    },
  } as unknown as HexuTransport;
  const session = new McpSession(transport);
  await session.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    },
  });
  await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  let last: any;
  for (let i = 0; i < 121; i++)
    last = await session.handle({
      jsonrpc: '2.0',
      id: i + 2,
      method: 'tools/call',
      params: { name: 'hexu_list_requests' },
    });
  assert.equal(calls, 120);
  assert.equal(last.result.isError, true);
  assert.equal(last.result.structuredContent.error.code, 'RATE_LIMITED');
  assert.equal(last.result.structuredContent.error.outcome, 'not_sent');
});
