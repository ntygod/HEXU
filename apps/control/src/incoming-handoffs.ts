import type { FastifyInstance } from 'fastify';
import {
  parseIncomingHandoffListQuery,
  parseIncomingHandoffTarget,
} from '../../../packages/contracts/src/incoming-handoffs.js';
import { IncomingHandoffQueries } from '../../../packages/db/src/incoming-handoffs.js';
import type { Store } from '../../../packages/db/src/store.js';

export function attachIncomingHandoffs(app: FastifyInstance, store: Store) {
  if (!store.teamMode) return;
  const summaries = new IncomingHandoffQueries(store);
  const path = '/api/v1/incoming-handoffs';
  app.get(path, async (request) => summaries.list(parseIncomingHandoffListQuery(request.query)));
  // The dedicated query checks the parent inside its read snapshot. Avoid the
  // generic :taskId preHandler, which loads full Task content before that snapshot.
  app.get(path + '/:targetTaskId/:handoffId', async (request) => {
    const target = parseIncomingHandoffTarget(request.params, request.query);
    return summaries.get(target.taskId, target.handoffId);
  });
}
