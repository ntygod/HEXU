import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeConfiguration, HexuTransport } from '../apps/mcp/src/http.js';
import { toolsFor, matches, callTool } from '../apps/mcp/src/tools.js';
import { waitForAnswer } from '../apps/mcp/src/wait-answer.js';
const env = {
  HEXU_AGENT_ROLE: 'requester',
  HEXU_AGENT_TOKEN: `hexu_requester_${'x'.repeat(43)}`,
  HEXU_ORIGIN_PROVIDER: 'codex',
  HEXU_ORIGIN_THREAD: 'original-thread',
  HEXU_ORIGIN_SESSION: 'original-session',
};
test('MCP original host binding is complete and opaque, never a path', () => {
  assert.equal(bridgeConfiguration(env).origin?.threadRef, 'original-thread');
  for (const ref of ['', '../history', 'a..b', '_leading', 'https://host', 'a b'])
    assert.throws(() => bridgeConfiguration({ ...env, HEXU_ORIGIN_THREAD: ref }));
  assert.throws(() => bridgeConfiguration({ ...env, HEXU_ORIGIN_SESSION: undefined }));
});
test('consumer tools cannot inject host identity or tool authority and receiver has none', () => {
  const all = toolsFor('requester');
  for (const name of ['hexu_bind_original_work', 'hexu_ack_consumption', 'hexu_consume_answer']) {
    const tool = all.find((v) => v.name === name)!;
    assert.equal(
      matches(tool.inputSchema, { origin: { threadRef: 'new' }, tools: ['shell'] }),
      false,
    );
    assert.equal(
      toolsFor('receiver').some((v) => v.name === name),
      false,
    );
  }
});
test('bounded answer query is read-only, immediate observation and stops on answer', async () => {
  let reads = 0;
  const transport = new HexuTransport(bridgeConfiguration(env));
  transport.request = async (_path, body) => {
    assert.equal(body, undefined);
    reads++;
    return { phase: 'accepted' };
  };
  const pending = await waitForAnswer(transport, '/request', 0);
  assert.equal(pending.status, 'waiting');
  assert.equal(reads, 1);
  transport.request = async () => {
    reads++;
    return { phase: 'answered' };
  };
  const ready = await waitForAnswer(transport, '/request', 30000);
  assert.equal(ready.status, 'answered');
  assert.equal(reads, 2);
  await assert.rejects(waitForAnswer(transport, '/request', 30001));
});
test('wrong original thread refuses claim before POST and ACK gets host identity', async () => {
  const transport = new HexuTransport(bridgeConfiguration(env));
  let posts = 0;
  transport.request = async (_path, body) => {
    if (body) posts++;
    return {
      binding: {
        id: 'binding',
        origin: { provider: 'codex', threadRef: 'new-thread', sessionRef: 'original-session' },
      },
    };
  };
  await assert.rejects(
    callTool(transport, 'hexu_consume_answer', {
      requestId: 'r',
      bindingId: 'binding',
      operationKey: 'claim',
    }),
  );
  assert.equal(posts, 0);
  transport.request = async (_path, body) => {
    assert.equal((body as any).threadRef, 'original-thread');
    return {};
  };
  await callTool(transport, 'hexu_ack_consumption', { requestId: 'r', operationKey: 'ack' });
});
