import type { FastifyInstance } from 'fastify';
import { record, text } from '../../../packages/contracts/src/index.js';
import {
  parseAssistanceList,
  parseAssistanceRecipients,
  parseAssistanceHistory,
} from '../../../packages/contracts/src/assistance.js';
import type { Store } from '../../../packages/db/src/store.js';
export function attachAssistance(app: FastifyInstance, store: Store) {
  const param = (value: unknown, name: string) => text(record(value)[name], name, 150);
  const key = (headers: Record<string, unknown>) =>
    text(headers['idempotency-key'], '操作标识', 128);
  app.get('/api/v1/tasks/:taskId/messages/:messageId/assistance-preview', async (r) =>
    store.assistance.preview(param(r.params, 'taskId'), param(r.params, 'messageId')),
  );
  app.get('/api/v1/tasks/:taskId/assistance-recipients', async (r) =>
    store.assistance.recipients(param(r.params, 'taskId'), parseAssistanceRecipients(r.query)),
  );
  app.get('/api/v1/tasks/:taskId/assistances', async (r) =>
    store.assistance.list(parseAssistanceList(r.query), param(r.params, 'taskId')),
  );
  app.post('/api/v1/tasks/:taskId/assistances', async (r, reply) =>
    reply
      .code(201)
      .send(store.assistance.create(param(r.params, 'taskId'), r.body, key(r.headers))),
  );
  // Recipient routes deliberately have no taskId pre-handler exception or Task permission grant.
  app.get('/api/v1/assistances', async (r) => store.assistance.list(parseAssistanceList(r.query)));
  app.get('/api/v1/assistances/:assistanceId', async (r) =>
    store.assistance.get(param(r.params, 'assistanceId'), parseAssistanceHistory(r.query)),
  );
  app.post('/api/v1/assistances/:assistanceId/replies', async (r, reply) =>
    reply
      .code(201)
      .send(store.assistance.reply(param(r.params, 'assistanceId'), r.body, key(r.headers))),
  );
  app.post('/api/v1/assistances/:assistanceId/state', async (r) =>
    store.assistance.change(param(r.params, 'assistanceId'), r.body, key(r.headers)),
  );
}
