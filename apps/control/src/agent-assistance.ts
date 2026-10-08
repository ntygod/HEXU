import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, record, revision, text } from '../../../packages/contracts/src/index.js';
import type { AssistanceDetail } from '../../../packages/contracts/src/assistance.js';
import type { Store } from '../../../packages/db/src/store.js';
import {
  authenticateAgentAssistanceConnection,
  isAgentAssistancePath,
  publicAgentAssistanceActor,
  type AgentAssistanceScope,
} from '../../../packages/identity/src/agent-assistance-connections.js';

/** Explicit allowlist prevents parent metadata and human authority leaking through bearer reads. */
export function requestView(detail: AssistanceDetail) {
  const item = detail.assistance,
    agent = item.agent;
  if (!agent) throw new DomainError('NOT_FOUND', '请求不存在', 404);
  return {
    requestId: agent.requestId,
    revision: item.revision,
    state: item.state,
    inputRevision: agent.currentInputRevision,
    inputHash: agent.inputHash,
    accessRevision: agent.accessRevision,
    phase: agent.phase,
    terminalReason: agent.terminalReason,
    question: item.question,
    clarification: agent.clarification,
    materials: agent.materials,
    responses: agent.responses.map((response) => ({
      id: response.id,
      type: response.type,
      body: response.body,
      scope: response.scope,
      inputRevision: response.inputRevision,
      inputHash: response.inputHash,
      accessRevision: response.accessRevision,
      createdAt: response.createdAt,
      actor:
        response.actor.kind === 'agent'
          ? {
              kind: 'agent',
              participantId: response.actor.participantId,
              connectionId: response.actor.connectionId,
              connectionRevision: response.actor.connectionRevision,
            }
          : response.actor.kind === 'policy'
            ? {
                kind: 'policy',
                grantRevision: response.actor.grantRevision,
              }
            : { kind: 'human' },
    })),
  };
}

/** Explicitly selected text only; this transport never acquires the owner's human permissions. */
export function attachAgentAssistance(app: FastifyInstance, store: Store) {
  const body = { bodyLimit: 64 * 1024 };
  const id = (r: FastifyRequest, name: string) => text(record(r.params)[name], name, 150);
  const key = (r: FastifyRequest) => text(r.headers['idempotency-key'], '操作标识', 128);
  app.post('/api/v1/tasks/:taskId/agent-assistance-preview', body, async (r) =>
    store.agentAssistance.preview(id(r, 'taskId'), r.body),
  );
  app.post('/api/v1/tasks/:taskId/agent-assistances', body, async (r, reply) =>
    reply.code(201).send(store.agentAssistance.create(id(r, 'taskId'), r.body, key(r))),
  );
  app.get('/api/v1/assistances/:assistanceId/input-revisions/:revision', async (r) =>
    store.agentAssistance.input(id(r, 'assistanceId'), revision(Number(id(r, 'revision')))),
  );
  app.post('/api/v1/assistances/:assistanceId/responses', body, async (r, reply) =>
    reply.code(201).send(store.agentAssistance.respond(id(r, 'assistanceId'), r.body, key(r))),
  );
  app.post('/api/v1/assistances/:assistanceId/input-revisions', body, async (r, reply) =>
    reply.code(201).send(store.agentAssistance.revise(id(r, 'assistanceId'), r.body, key(r))),
  );
  app.post('/api/v1/assistances/:assistanceId/credentials', body, async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store.agentAssistance.issueCredential(id(r, 'assistanceId'), r.body, key(r));
  });
  app.post('/api/v1/assistances/:assistanceId/credentials/revoke', body, async (r) =>
    store.agentAssistance.revokeCredential(id(r, 'assistanceId'), r.body, key(r)),
  );

  app.addHook('onRequest', async (r, reply) => {
    const url = new URL(r.url, 'http://localhost');
    if (!url.pathname.startsWith('/agent-assistance/')) return;
    reply.header('x-hexu-agent-api', '1');
    if (r.headers['x-hexu-agent-api'] !== undefined && r.headers['x-hexu-agent-api'] !== '1')
      throw new DomainError('AGENT_API_VERSION_UNSUPPORTED', '需要 Agent API 版本 1', 409);
    if (!store.teamMode)
      throw new DomainError('REAL_IDENTITY_REQUIRED', '有限 Agent 通道仅在真实账号模式启用', 422);
    if (
      !isAgentAssistancePath(url.pathname, r.method) ||
      url.search ||
      (r.method === 'GET' &&
        (r.headers['transfer-encoding'] ||
          (r.headers['content-length'] !== undefined && r.headers['content-length'] !== '0')))
    )
      throw new DomainError('NOT_FOUND', '此 Agent 通道未开放该动作', 404);
    authenticateAgentAssistanceConnection(store.db, r.headers);
    reply.header('Cache-Control', 'no-store');
  });
  const current = (r: FastifyRequest, scope?: AgentAssistanceScope) => {
    const actor = authenticateAgentAssistanceConnection(store.db, r.headers);
    if (scope && !actor.scopes.includes(scope))
      throw new DomainError('AGENT_SCOPE_REQUIRED', '凭据未获准执行此动作', 403);
    return actor;
  };
  const bound = (r: FastifyRequest, scope: AgentAssistanceScope) => {
    const actor = current(r, scope);
    try {
      if (store.agentAssistance.byRequestId(id(r, 'requestId')) !== actor.assistanceId)
        throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
    } catch (error) {
      // Unknown and existing foreign IDs are indistinguishable to a limited credential.
      if (error instanceof DomainError && error.status === 404)
        throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
      throw error;
    }
    return actor;
  };
  app.get('/agent-assistance/v1/identity', async (r) => publicAgentAssistanceActor(current(r)));
  app.get('/agent-assistance/v1/requests/:requestId', async (r) => {
    const actor = bound(r, 'material_read');
    return requestView(store.agentAssistance.get(actor.assistanceId, actor));
  });
  app.get('/agent-assistance/v1/requests/:requestId/input-revisions/:revision', async (r) => {
    const actor = bound(r, 'material_read');
    return store.agentAssistance.input(
      actor.assistanceId,
      revision(Number(id(r, 'revision'))),
      actor,
    );
  });
  app.post('/agent-assistance/v1/requests/:requestId/responses', body, async (r, reply) => {
    const actor = bound(r, 'respond');
    return reply
      .code(201)
      .send(requestView(store.agentAssistance.respond(actor.assistanceId, r.body, key(r), actor)));
  });
}
