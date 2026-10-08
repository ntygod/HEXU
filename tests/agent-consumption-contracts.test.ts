import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAgentOriginalWorkBinding,
  parseAgentConsume,
  parseAgentConsumptionAck,
  parseAgentConsumptionCancel,
} from '../packages/contracts/src/agent-consumption.js';

const origin = { provider: 'codex', threadRef: 'original-thread', sessionRef: 'original-session' };
const consume = {
  responseId: 'response',
  inputRevision: 1,
  inputHash: 'a'.repeat(64),
  accessRevision: 1,
  bindingId: 'binding',
};
const ack = {
  consumptionId: 'consumption',
  bindingId: 'binding',
  threadRef: 'original-thread',
  sessionRef: 'original-session',
  turnRef: 'observed-turn',
  output: 'Observed fixture output.',
};

test('original work binding permits only finite opaque references and known providers', () => {
  assert.deepEqual(parseAgentOriginalWorkBinding({ origin }), { origin });
  assert.deepEqual(
    parseAgentOriginalWorkBinding({ origin: { ...origin, provider: 'external' } }).origin.provider,
    'external',
  );
  for (const value of [
    '/private/workspace',
    '../session',
    'https://example.invalid/thread',
    'run command',
    'x'.repeat(151),
    '',
  ])
    for (const field of ['threadRef', 'sessionRef'])
      assert.throws(() => parseAgentOriginalWorkBinding({ origin: { ...origin, [field]: value } }));
  for (const bad of [
    { origin: { ...origin, provider: 'arbitrary-runtime' } },
    { origin, verified: true },
    { origin: { ...origin, cwd: '/tmp' } },
    {},
  ])
    assert.throws(() => parseAgentOriginalWorkBinding(bad));
});

test('consumption and observation DTOs reject forged evidence, versions and executable instructions', () => {
  assert.deepEqual(parseAgentConsume(consume), consume);
  assert.deepEqual(parseAgentConsumptionAck(ack), ack);
  assert.deepEqual(parseAgentConsumptionCancel({ bindingId: 'binding' }), { bindingId: 'binding' });
  for (const patch of [
    { inputHash: 'invalid' },
    { inputRevision: -1 },
    { accessRevision: '1' },
    { answer: 'caller supplied' },
    { runId: 'invented' },
  ])
    assert.throws(() => parseAgentConsume({ ...consume, ...patch }));
  for (const patch of [
    { output: '' },
    { output: ' ' },
    { output: 'x'.repeat(6001) },
    { verified: true },
    { providerReceipt: 'fake' },
    { threadRef: '/some/path' },
  ])
    assert.throws(() => parseAgentConsumptionAck({ ...ack, ...patch }));
  assert.throws(() => parseAgentConsumptionCancel({ bindingId: 'binding', stop: true }));
});
