import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAgentAssistanceCreate,
  parseAgentAssistanceResponse,
  parseAgentAssistanceReviseInput,
  parseAgentAssistanceCredentialIssue,
  parseAgentAssistanceCredentialManagement,
  type AgentAssistanceResponseRecord,
} from '../packages/contracts/src/agent-assistance.js';
import {
  agentAssistancePhase,
  assertAgentAssistanceResponseAllowed,
  assertAgentAssistanceRevisionCause,
  assertAgentAssistanceCredentialExpiry,
  assertAgentAssistanceInputBudget,
} from '../packages/domain/src/agent-assistance.js';
const hash = 'a'.repeat(64);
const target = {
  participantId: 'recipient',
  capabilityId: 'capability',
  capabilityVersion: 1,
  endpointRevision: 1,
  grantId: 'grant',
  grantRevision: 1,
};
function input() {
  return {
    question: '问题',
    clarification: null,
    message: { sourceMessageId: 'message', expectedSourceHash: hash, range: { start: 0, end: 2 } },
    projectTexts: {
      items: [] as Array<{ id: string; revision: number; contentHash: string; maxChars: number }>,
      expectedHash: hash,
    },
  };
}
function create() {
  return {
    target: { ...target },
    requesterParticipantId: null,
    expectedTaskRevision: 1,
    input: input(),
    expectedInputHash: hash,
    shareConfirmed: true,
  };
}
const base = {
  expectedRevision: 1,
  inputRevision: 1,
  expectedInputHash: hash,
  expectedAccessRevision: 1,
};
const invalid = (fn: () => unknown) => assert.throws(fn, { code: 'INVALID_INPUT' });
function response(
  type: AgentAssistanceResponseRecord['type'],
  inputRevision = 1,
): AgentAssistanceResponseRecord {
  return {
    id: `r-${type}`,
    type,
    body: '',
    scope: null,
    actor: { kind: 'human', userId: 'owner' },
    inputRevision,
    inputHash: hash,
    accessRevision: 1,
    createdAt: '2026-10-08T00:00:00.000Z',
  };
}

test('agent assistance create preserves explicit null and exact frozen text', () => {
  const value = create();
  value.input.question = '  问题  ';
  assert.deepEqual(parseAgentAssistanceCreate(value), value);
  const missing: Record<string, unknown> = create();
  delete missing.requesterParticipantId;
  invalid(() => parseAgentAssistanceCreate(missing));
  invalid(() => parseAgentAssistanceCreate({ ...create(), expectedTaskRevision: '1' }));
  invalid(() => parseAgentAssistanceCreate({ ...create(), actor: 'recipient' }));
  invalid(() =>
    parseAgentAssistanceCreate({
      ...create(),
      input: { ...input(), clarification: 'not first input' },
    }),
  );
  assert.throws(() => parseAgentAssistanceCreate({ ...create(), shareConfirmed: false }), {
    code: 'SHARING_CONFIRMATION_REQUIRED',
  });
});
test('agent assistance rejects unknown and malformed nested fields', () => {
  for (const patch of [
    { participantId: ' recipient' },
    { endpointRevision: '1' },
    { owner: 'spoof' },
    { capabilityVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])
    invalid(() => parseAgentAssistanceCreate({ ...create(), target: { ...target, ...patch } }));
  const value = input();
  invalid(() => parseAgentAssistanceCreate({ ...create(), input: { ...value, source: 'spoof' } }));
  invalid(() =>
    parseAgentAssistanceCreate({
      ...create(),
      input: { ...value, message: { ...value.message, actor: 'spoof' } },
    }),
  );
  invalid(() =>
    parseAgentAssistanceCreate({
      ...create(),
      input: { ...value, message: { ...value.message, range: { start: '0', end: 2 } } },
    }),
  );
  invalid(() =>
    parseAgentAssistanceCreate({
      ...create(),
      input: {
        ...value,
        projectTexts: {
          items: [{ id: 's', revision: 1, contentHash: hash, maxChars: 8001 }],
          expectedHash: hash,
        },
      },
    }),
  );
  const item = { id: 's', revision: 1, contentHash: hash, maxChars: 100 };
  invalid(() =>
    parseAgentAssistanceCreate({
      ...create(),
      input: { ...value, projectTexts: { items: [item, item], expectedHash: hash } },
    }),
  );
  invalid(() =>
    parseAgentAssistanceCreate({
      ...create(),
      input: {
        ...value,
        projectTexts: { items: [{ ...item, url: 'https://example.invalid' }], expectedHash: hash },
      },
    }),
  );
});
test('typed responses enforce their exact discriminated body and scope', () => {
  assert.deepEqual(parseAgentAssistanceResponse({ ...base, type: 'accept' }), {
    ...base,
    type: 'accept',
  });
  invalid(() => parseAgentAssistanceResponse({ ...base, type: 'accept', body: '' }));
  for (const type of ['answer', 'decline', 'request_input']) {
    assert.equal(parseAgentAssistanceResponse({ ...base, type, body: 'text' }).type, type);
    invalid(() => parseAgentAssistanceResponse({ ...base, type, body: '' }));
    invalid(() => parseAgentAssistanceResponse({ ...base, type, body: 'text', actor: 'spoof' }));
  }
  invalid(() =>
    parseAgentAssistanceResponse({
      ...base,
      type: 'propose_scope',
      body: 'text',
      scope: { question: 'q', materialIds: ['a', 'a'] },
    }),
  );
  invalid(() =>
    parseAgentAssistanceResponse({
      ...base,
      type: 'propose_scope',
      body: 'text',
      scope: { question: 'q', materialIds: [], tools: ['browser'] },
    }),
  );
});
test('revise requires all revision and cause fields and explicit share confirmation', () => {
  const value = {
    expectedRevision: 1,
    expectedInputRevision: 1,
    expectedAccessRevision: 1,
    expectedTaskRevision: 1,
    causeResponseId: null,
    input: input(),
    expectedInputHash: hash,
    shareConfirmed: true,
  };
  assert.deepEqual(parseAgentAssistanceReviseInput(value), value);
  invalid(() => parseAgentAssistanceReviseInput({ ...value, expectedAccessRevision: '1' }));
  invalid(() => parseAgentAssistanceReviseInput({ ...value, causeResponseId: undefined }));
});
test('request credentials have separate scopes and explicit management actions', () => {
  const value = {
    expectedRevision: 0,
    scopes: ['material_read', 'respond'],
    expiresAt: '2026-10-08T01:00:00.000Z',
  };
  assert.deepEqual(parseAgentAssistanceCredentialIssue(value), value);
  invalid(() => parseAgentAssistanceCredentialIssue({ ...value, scopes: ['capability_read'] }));
  invalid(() => parseAgentAssistanceCredentialIssue({ ...value, scopes: ['respond', 'respond'] }));
  invalid(() => parseAgentAssistanceCredentialIssue({ ...value, expectedRevision: '0' }));
  invalid(() =>
    parseAgentAssistanceCredentialIssue({ ...value, expiresAt: '2026-02-30T00:00:00Z' }),
  );
  invalid(() => parseAgentAssistanceCredentialManagement({ ...value, action: 'rotate' }));
  assert.equal(
    parseAgentAssistanceCredentialManagement({ ...value, expectedRevision: 1, action: 'rotate' })
      .action,
    'rotate',
  );
  assert.deepEqual(
    parseAgentAssistanceCredentialManagement({ expectedRevision: 1, action: 'revoke' }),
    { expectedRevision: 1, action: 'revoke' },
  );
  invalid(() => parseAgentAssistanceCredentialManagement({ ...value, action: 'revoke' }));
  const now = Date.parse('2026-10-08T00:00:00Z');
  assertAgentAssistanceCredentialExpiry('2026-10-09T00:00:00Z', now);
  for (const date of ['invalid', '2026-10-08T00:00:00Z', '2026-10-09T00:00:01Z'])
    invalid(() => assertAgentAssistanceCredentialExpiry(date, now));
});
test('negotiation phase derives only from current input and existing business state', () => {
  assert.equal(agentAssistancePhase('open', 1, []), 'awaiting_acceptance');
  assert.equal(agentAssistancePhase('open', 1, [response('accept')]), 'accepted');
  assert.equal(
    agentAssistancePhase('open', 1, [response('accept'), response('request_input')]),
    'waiting_input',
  );
  assert.equal(
    agentAssistancePhase('open', 2, [response('accept'), response('request_input')]),
    'awaiting_acceptance',
  );
  assert.equal(agentAssistancePhase('responded', 1, []), 'answered');
  assert.equal(agentAssistancePhase('closed', 1, []), 'terminal');
});
test('response rules enforce accept, pending-input, subset and terminal barriers', () => {
  const metadata = {
    currentInputRevision: 1,
    responses: [] as AgentAssistanceResponseRecord[],
    materials: [{ id: 'opaque', label: '摘录', text: '材料' }],
  };
  const answer = parseAgentAssistanceResponse({ ...base, type: 'answer', body: 'text' });
  assert.throws(() => assertAgentAssistanceResponseAllowed('open', metadata, answer), {
    code: 'ASSISTANCE_ACCEPT_REQUIRED',
  });
  metadata.responses.push(response('accept'));
  assertAgentAssistanceResponseAllowed('open', metadata, answer);
  assert.throws(
    () =>
      assertAgentAssistanceResponseAllowed(
        'open',
        metadata,
        parseAgentAssistanceResponse({ ...base, type: 'accept' }),
      ),
    { code: 'ASSISTANCE_ALREADY_ACCEPTED' },
  );
  assert.throws(
    () =>
      assertAgentAssistanceResponseAllowed(
        'open',
        metadata,
        parseAgentAssistanceResponse({
          ...base,
          type: 'propose_scope',
          body: 'text',
          scope: { question: 'q', materialIds: ['unshared'] },
        }),
      ),
    { code: 'SCOPE_EXPANSION_DENIED' },
  );
  metadata.responses.push(response('request_input'));
  assert.throws(() => assertAgentAssistanceResponseAllowed('open', metadata, answer), {
    code: 'ASSISTANCE_INPUT_PENDING',
  });
  assertAgentAssistanceResponseAllowed(
    'open',
    metadata,
    parseAgentAssistanceResponse({ ...base, type: 'decline', body: 'text' }),
  );
  assert.throws(() => assertAgentAssistanceResponseAllowed('responded', metadata, answer), {
    code: 'ASSISTANCE_NOT_OPEN',
  });
  assertAgentAssistanceRevisionCause('open', 'pending', 'pending');
  assert.throws(() => assertAgentAssistanceRevisionCause('open', 'pending', null), {
    code: 'ASSISTANCE_CAUSE_CHANGED',
  });
  assert.throws(() => assertAgentAssistanceRevisionCause('responded', null, null), {
    code: 'ASSISTANCE_NOT_OPEN',
  });
});
test('input budgets reject overflow instead of silently trimming selected items', () => {
  assertAgentAssistanceInputBudget(['a'.repeat(10000)], 'a'.repeat(20000));
  assert.throws(() => assertAgentAssistanceInputBudget(['a'.repeat(10001)], ''), {
    code: 'INPUT_BUDGET_EXCEEDED',
  });
  assert.throws(() => assertAgentAssistanceInputBudget([], 'a'.repeat(20001)), {
    code: 'INPUT_BUDGET_EXCEEDED',
  });
});
