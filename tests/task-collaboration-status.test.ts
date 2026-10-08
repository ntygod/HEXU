import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskAgentCollaboration } from '../packages/contracts/src/task-agent-collaborations.js';
import {
  collaborationStatus,
  collaborationDelivery,
} from '../apps/web/src/task-collaboration-status.js';

function item(overrides: Partial<TaskAgentCollaboration> = {}): TaskAgentCollaboration {
  return {
    assistanceId: 'assistance',
    requestId: 'request',
    revision: 1,
    currentInputRevision: 2,
    accessRevision: 1,
    purpose: 'Explain a finite API',
    requester: {
      participantId: 'requester',
      name: 'Requester',
      owner: { id: 'a', name: 'Member A' },
    },
    recipient: {
      participantId: 'receiver',
      name: 'Receiver',
      owner: { id: 'b', name: 'Member B' },
    },
    initiatedBy: {
      participantId: 'requester',
      name: 'Requester',
      owner: { id: 'a', name: 'Member A' },
      kind: 'agent',
    },
    state: 'open',
    phase: 'awaiting_acceptance',
    terminalReason: null,
    accessEnded: false,
    canManage: true,
    waitingFor: 'acceptance',
    latestResponse: null,
    latestConfirmation: { source: 'assistance', at: '2026-10-08T00:00:00Z' },
    delivery: {
      source: 'agent_events',
      recipient: 'receiver',
      eventType: null,
      state: 'not_observed',
      inputRevision: 2,
      eventOccurredAt: null,
      confirmedAt: null,
    },
    consumption: {
      status: 'unbound',
      bindingId: null,
      responseId: null,
      inputRevision: null,
      claimedAt: null,
      acknowledgement: null,
      futureContinuationCancelledAt: null,
    },
    ...overrides,
  };
}
test('callback 2xx does not become Agent acceptance, answer, or verified continuation', () => {
  const value = item();
  value.delivery.state = 'delivered';
  assert.equal(collaborationStatus(value).label, '等待接受');
  assert.match(collaborationDelivery(value), /仅确认收件/);
  assert.doesNotMatch(collaborationDelivery(value), /已在线|已回答|已完成/);
});
test('old-input delivery never presents current input as delivered', () => {
  const value = item();
  value.delivery.state = 'delivered';
  value.delivery.inputRevision = 1;
  assert.match(collaborationDelivery(value), /当前输入送达尚未确认/);
});
test('clarification and scope decision request action only from current managers', () => {
  for (const waitingFor of ['clarification', 'scope_decision'] as const) {
    assert.equal(collaborationStatus(item({ waitingFor })).attention, true);
    const result = collaborationStatus(item({ waitingFor, canManage: false }));
    assert.equal(result.attention, false);
    assert.match(result.detail, /有权发起者/);
  }
});
test('answer, claim and external self-report remain separate facts', () => {
  const value = item({ phase: 'answered', state: 'responded' });
  assert.match(collaborationStatus(value).label, /未绑定/);
  value.consumption.status = 'answer_available';
  assert.match(collaborationStatus(value).label, /待原工作取用/);
  value.consumption.status = 'claimed';
  assert.match(collaborationStatus(value).label, /使用待确认/);
  value.consumption.status = 'reported';
  value.consumption.acknowledgement = {
    evidence: 'external_self_report',
    observedAt: '2026-10-08T00:00:02Z',
    late: false,
    cancelled: false,
  };
  assert.match(collaborationStatus(value).detail, /尚非提供方验证/);
});
test('revocation and future cancellation outrank late report and never confirm external termination', () => {
  const value = item();
  value.consumption.acknowledgement = {
    evidence: 'external_self_report',
    observedAt: '2026-10-08T00:00:02Z',
    late: true,
    cancelled: true,
  };
  assert.match(collaborationStatus(value).label, /迟到/);
  value.consumption.futureContinuationCancelledAt = '2026-10-08T00:00:01Z';
  assert.match(collaborationStatus(value).label, /已取消/);
  assert.match(collaborationStatus(value).detail, /仍需确认/);
  value.accessEnded = true;
  assert.equal(collaborationStatus(value).label, '分享已撤销');
  assert.match(collaborationStatus(value).detail, /尚未确认/);
});
test('decline, capacity and notification failure retain their actual meanings', () => {
  assert.match(
    collaborationStatus(item({ terminalReason: 'declined', state: 'closed' })).detail,
    /不是提供方故障/,
  );
  assert.equal(collaborationStatus(item({ waitingFor: 'capacity' })).label, '等待接收容量');
  const value = item();
  value.delivery.state = 'failed';
  assert.match(collaborationDelivery(value), /投递失败/);
  assert.equal(collaborationStatus(value).label, '等待接受');
});
