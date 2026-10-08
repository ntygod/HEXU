import { DomainError } from '../../contracts/src/index.js';
import type { AssistancePerson } from '../../contracts/src/assistance.js';
import type { AgentAssistanceActor } from '../../contracts/src/agent-assistance.js';
import type {
  TaskAgentCollaboration,
  TaskAgentCollaborationActor,
  TaskAgentCollaborationConsumption,
  TaskAgentCollaborationDelivery,
  TaskAgentCollaborationList,
  TaskAgentCollaborationParty,
  TaskAgentCollaborationWaitingFor,
} from '../../contracts/src/task-agent-collaborations.js';
import { AgentConsumptionStore } from './agent-consumption.js';
import type { Store } from './store.js';

/** Bounded, read-only parent-Task projection; never authenticates a receiver as its human owner. */
export class TaskAgentCollaborationsStore {
  private readonly consumptions: AgentConsumptionStore;
  constructor(private readonly store: Store) {
    this.consumptions = new AgentConsumptionStore(store);
  }
  list(
    taskId: string,
    query: { limit: number; cursor: string | null },
  ): TaskAgentCollaborationList {
    this.store.getTask(taskId);
    let cursor: number | null = null;
    if (query.cursor) {
      const row = this.store.db
        .prepare(
          `SELECT a.rowid AS position FROM assistances a
           JOIN assistance_agent_requests r ON r.assistance_id=a.id WHERE a.task_id=? AND a.id=?`,
        )
        .get(taskId, query.cursor) as { position: number } | undefined;
      if (!row) throw new DomainError('INVALID_CURSOR', '协作列表已变化，请返回首页', 409);
      cursor = row.position;
    }
    const rows = this.store.db
      .prepare(
        `SELECT a.id FROM assistances a JOIN assistance_agent_requests r ON r.assistance_id=a.id
         WHERE a.task_id=? AND (? IS NULL OR a.rowid<?) ORDER BY a.rowid DESC LIMIT ?`,
      )
      .all(taskId, cursor, cursor, query.limit + 1) as { id: string }[];
    const items = rows.slice(0, query.limit).map(({ id }) => this.get(taskId, id));
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.assistanceId : null };
  }
  private party(
    participantId: string | null,
    owner: AssistancePerson,
  ): TaskAgentCollaborationParty {
    const row = participantId
      ? (this.store.db
          .prepare("SELECT json_extract(body,'$.name') AS name FROM agent_participants WHERE id=?")
          .get(participantId) as { name: string } | undefined)
      : undefined;
    return { participantId, name: row?.name ?? (participantId ? 'Agent' : owner.name), owner };
  }
  private actor(
    actor: AgentAssistanceActor,
    fallback: AssistancePerson,
  ): TaskAgentCollaborationActor {
    const ownerId = actor.kind === 'human' ? actor.userId : actor.ownerUserId;
    const owner = this.store.db
      .prepare('SELECT id,name FROM collab_people WHERE id=?')
      .get(ownerId) as AssistancePerson | undefined;
    return {
      kind: actor.kind,
      ...this.party(actor.kind === 'agent' ? actor.participantId : null, owner ?? fallback),
    };
  }
  private delivery(assistanceId: string, inputRevision: number): TaskAgentCollaborationDelivery {
    const event = this.store.db
      .prepare(
        'SELECT sequence,created_at FROM outbox WHERE assistance_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(assistanceId) as { sequence: number; created_at: string } | undefined;
    const action = this.store.db
      .prepare(
        'SELECT action FROM assistance_events WHERE assistance_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(assistanceId) as { action: string } | undefined;
    // Every new input saves an Assistance event atomically. Observing only the latest event
    // prevents a delivered older input from being presented as delivery of the current input.
    const rows = event
      ? (this.store.db
          .prepare('SELECT DISTINCT state FROM agent_event_deliveries WHERE sequence=?')
          .all(event.sequence) as {
          state:
            | Exclude<
                TaskAgentCollaborationDelivery['state'],
                'delivered' | 'not_observed' | 'mixed'
              >
            | 'accepted';
        }[])
      : [];
    const state = rows.length === 0 ? 'not_observed' : rows.length > 1 ? 'mixed' : rows[0]!.state;
    return {
      source: 'agent_events',
      state: state === 'accepted' ? 'delivered' : state,
      inputRevision,
      recipient: 'receiver',
      eventType: action?.action ?? null,
      eventOccurredAt: event?.created_at ?? null,
      confirmedAt: null,
    };
  }
  get(taskId: string, assistanceId: string): TaskAgentCollaboration {
    // This path checks current Task permission and assistance ownership before reading any metadata.
    const item = this.store.agentAssistance.getForTask(taskId, assistanceId).assistance;
    const agent = item.agent!;
    const original = this.store.db
      .prepare('SELECT body FROM assistance_input_revisions WHERE assistance_id=? AND revision=1')
      .get(assistanceId) as { body: string };
    const originalActor = (JSON.parse(original.body) as { actor: AgentAssistanceActor }).actor;
    const view = this.consumptions.getForTask(taskId, agent.requestId);
    const consumed = view?.consumption;
    const ack = consumed?.acknowledgement;
    const consumption: TaskAgentCollaborationConsumption = {
      status: ack
        ? 'reported'
        : consumed
          ? 'claimed'
          : !view
            ? 'unbound'
            : agent.phase === 'answered'
              ? 'answer_available'
              : 'waiting_answer',
      bindingId: view?.binding.id ?? null,
      responseId: consumed?.responseId ?? null,
      inputRevision: consumed?.inputRevision ?? null,
      claimedAt: consumed?.claimedAt ?? null,
      acknowledgement: ack
        ? {
            evidence: ack.evidence,
            observedAt: ack.observedAt,
            late: ack.late,
            cancelled: ack.cancelled,
          }
        : null,
      futureContinuationCancelledAt: view?.binding.cancelledAt ?? null,
    };
    let waitingFor: TaskAgentCollaborationWaitingFor = null;
    if (!item.accessEnded && item.state !== 'closed' && item.state !== 'cancelled') {
      if (agent.phase === 'awaiting_acceptance')
        waitingFor = agent.capacityBlocked ? 'capacity' : 'acceptance';
      if (agent.phase === 'accepted') waitingFor = 'answer';
      if (agent.phase === 'waiting_input') {
        waitingFor =
          agent.responses.find((r) => r.id === agent.pendingResponseId)?.type === 'propose_scope'
            ? 'scope_decision'
            : 'clarification';
      }
      if (agent.phase === 'answered' && view && !view.binding.cancelledAt) {
        if (!consumed) waitingFor = 'continuation';
        else if (!ack) waitingFor = 'continuation_confirmation';
      }
    }
    const latestResponse = agent.responses.at(-1);
    const latestConfirmation: TaskAgentCollaboration['latestConfirmation'] = {
      source: 'assistance',
      at: item.updatedAt,
    };
    const observations = [
      ['consumption_claim', consumed?.claimedAt],
      ['external_self_report', ack?.observedAt],
      ['future_continuation_cancelled', view?.binding.cancelledAt],
    ] as const;
    for (const [source, at] of observations)
      if (at && at >= latestConfirmation.at) Object.assign(latestConfirmation, { source, at });
    return {
      assistanceId: item.id,
      requestId: agent.requestId,
      revision: item.revision,
      currentInputRevision: agent.currentInputRevision,
      accessRevision: agent.accessRevision,
      purpose: item.question,
      requester: this.party(agent.requesterParticipantId, item.requester),
      recipient: this.party(agent.recipientParticipantId, item.recipient),
      initiatedBy: this.actor(originalActor, item.requester),
      state: item.state,
      phase: agent.phase,
      terminalReason: agent.terminalReason ?? (item.accessEnded ? 'access_revoked' : null),
      accessEnded: item.accessEnded,
      canManage: item.canManage,
      waitingFor,
      latestResponse: latestResponse
        ? {
            id: latestResponse.id,
            type: latestResponse.type,
            inputRevision: latestResponse.inputRevision,
            createdAt: latestResponse.createdAt,
            actor: this.actor(latestResponse.actor, item.recipient),
          }
        : null,
      latestConfirmation,
      delivery: this.delivery(assistanceId, agent.currentInputRevision),
      consumption,
    };
  }
}
