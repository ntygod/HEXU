import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nodeRequest } from '../apps/runner/src/agent/connection.js';

test('恢复inspect有界容纳原应用和独立恢复历史，其他节点响应上限不扩大', async () => {
  let size = 300000;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fixture: 'x'.repeat(size) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const read = await nodeRequest<{ fixture: string }>(
      origin,
      'integration-restoration-inspect',
      {},
    );
    assert.equal(read.fixture.length, size);
    await assert.rejects(nodeRequest(origin, 'integration-inspect', {}), /响应超出上限/);
    size = 33000;
    await assert.rejects(
      nodeRequest(origin, 'integration-restoration-publish', {}),
      /响应超出上限/,
    );
    size = 524288;
    await assert.rejects(
      nodeRequest(origin, 'integration-restoration-inspect', {}),
      /响应超出上限/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
