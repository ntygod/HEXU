import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAgentRequesterInput,
  parseAgentRequesterCreate,
  parseAgentRequesterReviseInput,
  parseAgentRequesterCancel,
  parseAgentRequesterCredentialIssue,
} from '../packages/contracts/src/agent-requester.js';

const hash = 'a'.repeat(64);
const input = {
  question: 'Finite text question',
  clarification: null,
  materialIds: ['message', 'text-1'],
};
const create = { ...input, expectedTaskRevision: 1, expectedInputHash: hash };
const revise = {
  ...create,
  clarification: 'Version 2',
  expectedRevision: 2,
  expectedInputRevision: 1,
  expectedAccessRevision: 1,
  causeResponseId: 'response-1',
};
const invalid = (fn: () => unknown) => assert.throws(fn, { code: 'INVALID_INPUT' });

test('requester commands require exact bounded material IDs and no caller authority', () => {
  assert.deepEqual(parseAgentRequesterInput(input), input);
  assert.deepEqual(parseAgentRequesterCreate(create), create);
  assert.deepEqual(parseAgentRequesterReviseInput(revise), revise);
  assert.deepEqual(parseAgentRequesterCancel({ expectedRevision: 1 }), { expectedRevision: 1 });
  for (const extra of [
    { ownerUserId: 'spoof' },
    { participantId: 'spoof' },
    { taskId: 'other' },
    { target: {} },
    { input: {} },
    { shareConfirmed: true },
  ]) {
    invalid(() => parseAgentRequesterInput({ ...input, ...extra }));
    invalid(() => parseAgentRequesterCreate({ ...create, ...extra }));
    invalid(() => parseAgentRequesterReviseInput({ ...revise, ...extra }));
  }
  for (const materialIds of [
    [],
    ['text-1'],
    ['message', 'message'],
    Array.from({ length: 18 }, (_, i) => (i ? `text-${i}` : 'message')),
  ])
    invalid(() => parseAgentRequesterInput({ ...input, materialIds }));
  for (const patch of [
    { question: '' },
    { question: 'x'.repeat(2001) },
    { clarification: 'x'.repeat(6001) },
    { materialIds: 'message' },
  ])
    invalid(() => parseAgentRequesterInput({ ...input, ...patch }));
});

test('requester create and revision enforce hash/version/cause types', () => {
  for (const patch of [
    { clarification: 'not initial input' },
    { expectedTaskRevision: '1' },
    { expectedInputHash: 'short' },
    { expectedInputHash: 'A'.repeat(64) },
  ])
    invalid(() => parseAgentRequesterCreate({ ...create, ...patch }));
  for (const patch of [
    { expectedRevision: 0 },
    { expectedInputRevision: '1' },
    { expectedAccessRevision: -1 },
    { causeResponseId: undefined },
  ])
    invalid(() => parseAgentRequesterReviseInput({ ...revise, ...patch }));
  invalid(() => parseAgentRequesterCancel({ expectedRevision: 1, action: 'delete' }));
});

test('requester credential issuance binds explicit owner-selected participant, materials and target', () => {
  const issue = {
    participantId: 'requester',
    preview: {
      target: {
        participantId: 'recipient',
        capabilityId: 'capability',
        capabilityVersion: 1,
        endpointRevision: 1,
        grantId: 'grant',
        grantRevision: 1,
      },
      requesterParticipantId: 'requester',
      input: {
        question: input.question,
        clarification: null,
        message: {
          sourceMessageId: 'source-message',
          expectedSourceHash: hash,
          range: { start: 0, end: 4 },
        },
        projectTexts: { items: [], expectedHash: hash },
      },
    },
    expectedTaskRevision: 1,
    expectedInputHash: hash,
    shareConfirmed: true,
    expiresAt: '2026-10-09T00:00:00.000Z',
  };
  assert.deepEqual(parseAgentRequesterCredentialIssue(issue), issue);
  invalid(() => parseAgentRequesterCredentialIssue({ ...issue, participantId: 'foreign' }));
  invalid(() => parseAgentRequesterCredentialIssue({ ...issue, scopes: ['all'] }));
  invalid(() =>
    parseAgentRequesterCredentialIssue({ ...issue, expiresAt: '2026-02-30T00:00:00Z' }),
  );
  assert.throws(() => parseAgentRequesterCredentialIssue({ ...issue, shareConfirmed: false }), {
    code: 'SHARING_CONFIRMATION_REQUIRED',
  });
});
