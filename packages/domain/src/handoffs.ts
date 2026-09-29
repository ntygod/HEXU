import { DomainError } from '../../contracts/src/index.js';
import type { HandoffAction, HandoffState } from '../../contracts/src/handoffs.js';

export function closeHandoff(state: HandoffState, action: HandoffAction): HandoffState {
  if (state !== 'offered')
    throw new DomainError('HANDOFF_CLOSED', '邀请已经结束，请读取最新记录', 409);
  return action === 'reject' ? 'rejected' : 'withdrawn';
}
