import { DomainError, type Message } from '../../contracts/src/index.js';
import type { ResultFeedbackReplyTarget } from '../../contracts/src/result-feedback-replies.js';
import { ResultRevisions } from './result-revisions.js';
import type { Store } from './store.js';

/** Resolve only stored feedback in the same Task and immutable result version. */
export function resolveFeedbackReplySource(
  store: Store,
  resultId: string,
  revisionId: string,
  messageId: string,
) {
  const result = store.result(resultId);
  store.getTask(result.taskId, true);
  const version = new ResultRevisions(store).get(resultId, revisionId);
  const row = store.db
    .prepare('SELECT body FROM messages WHERE id=? AND task_id=?')
    .get(messageId, result.taskId) as { body: string } | undefined;
  const source = row ? (JSON.parse(row.body) as Message) : undefined;
  if (
    version.id !== revisionId ||
    version.resultId !== resultId ||
    version.taskId !== result.taskId ||
    !source ||
    source.id !== messageId ||
    source.taskId !== result.taskId ||
    source.resultId !== resultId ||
    source.resultRevisionId !== revisionId ||
    source.actorType !== 'human'
  )
    throw new DomainError('NOT_FOUND', '反馈不存在或不属于此固定版本', 404);

  // Keep the snapshot bounded in UTF-16 units without cutting a surrogate pair.
  let bodyPreview = source.body.slice(0, 240);
  if (/[\uD800-\uDBFF]$/.test(bodyPreview)) bodyPreview = bodyPreview.slice(0, -1);
  const replyTo: ResultFeedbackReplyTarget = {
    messageId: source.id,
    actorName: source.actorName,
    ...(typeof source.createdByUserId === 'string' && source.createdByUserId
      ? { createdByUserId: source.createdByUserId }
      : {}),
    bodyPreview,
    bodyTruncated: bodyPreview.length < source.body.length,
  };
  return { taskId: result.taskId, replyTo, codeAnchor: source.codeAnchor };
}
