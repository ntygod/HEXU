import { createHash } from 'node:crypto';
import { DomainError, type Message, type Task } from '../../contracts/src/index.js';
import {
  parseResultFeedbackFollowUp,
  type ResultFeedbackFollowUpList,
  type ResultFeedbackFollowUpOrigin,
  type ResultFeedbackFollowUpPreview,
  type ResultFeedbackFollowUpTarget,
} from '../../contracts/src/result-feedback-followups.js';
import { ResultRevisions } from './result-revisions.js';
import type { Store } from './store.js';

/** A relation between ordinary Tasks and fixed human feedback; never an execution command. */
export class ResultFeedbackFollowUps {
  constructor(readonly store: Store) {}

  private source(resultId: string, revisionId: string, messageId: string, write: boolean) {
    const result = this.store.result(resultId);
    const task = this.store.getTask(result.taskId, write);
    const version = new ResultRevisions(this.store).get(resultId, revisionId);
    const row = this.store.db
      .prepare('SELECT body FROM messages WHERE id=? AND task_id=?')
      .get(messageId, task.id) as { body: string } | undefined;
    const message = row ? (JSON.parse(row.body) as Message) : undefined;
    if (
      version.id !== revisionId ||
      version.resultId !== resultId ||
      version.taskId !== task.id ||
      !message ||
      message.id !== messageId ||
      message.taskId !== task.id ||
      message.resultId !== resultId ||
      message.resultRevisionId !== revisionId ||
      message.actorType !== 'human'
    )
      throw new DomainError('NOT_FOUND', '反馈不存在或不属于此固定版本', 404);
    return { task, version, message };
  }

  preview(resultId: string, revisionId: string, messageId: string): ResultFeedbackFollowUpPreview {
    const { task, version, message } = this.source(resultId, revisionId, messageId, true);
    // Scope comes only from the original Task. Private feedback never becomes project-visible.
    const projectId = task.visibility === 'private' ? null : task.projectId;
    if (task.visibility === 'project' && !projectId)
      throw new DomainError('CAPABILITY_UNAVAILABLE', '原任务缺少可核对的项目范围', 422);
    if (this.store.teamMode) {
      this.store.permissions.space(task.spaceId);
      if (projectId) this.store.permissions.project(projectId, 'edit');
    }
    const target: ResultFeedbackFollowUpTarget = {
      spaceId: task.spaceId,
      projectId,
      projectName: projectId ? this.store.project(projectId).name : null,
      visibility: projectId ? 'project' : 'private',
      ownerUserId: this.store.actorId,
      ownerName: this.store.actorName(),
    };
    if (typeof message.body !== 'string' || message.body.length > 12000)
      return { available: false, reason: '原反馈超出可保存来源预算，请保留原反馈并另行建立任务' };
    const origin: ResultFeedbackFollowUpOrigin = {
      version: 1,
      kind: 'result_feedback',
      sourceTaskId: task.id,
      sourceTaskShortId: task.shortId,
      sourceTaskTitle: task.title,
      resultId,
      resultRevisionId: revisionId,
      resultRevision: version.revision,
      resultTitle: version.title,
      messageId,
      authorName: message.actorName,
      ...(typeof message.createdByUserId === 'string' && message.createdByUserId
        ? { authorId: message.createdByUserId }
        : {}),
      body: message.body,
      bodyHash: createHash('sha256').update(message.body).digest('hex'),
      ...(message.codeAnchor ? { codeAnchor: message.codeAnchor } : {}),
    };
    return { available: true, origin, target };
  }

  create(
    resultId: string,
    revisionId: string,
    messageId: string,
    value: unknown,
    key: string,
  ): Task {
    const input = parseResultFeedbackFollowUp(value);
    const resolve = () => {
      const preview = this.preview(resultId, revisionId, messageId);
      if (!preview.available) throw new DomainError('CAPABILITY_UNAVAILABLE', preview.reason, 422);
      return preview;
    };
    // Recheck current source edit and target scope before receipt lookup and inside its transaction.
    let source = resolve();
    return this.store.mutate(
      `result.feedback-follow-up:${revisionId}:${messageId}`,
      key,
      input,
      () => this.store.insertTask({ ...input, projectId: source.target.projectId }, source.origin),
      () => {
        source = resolve();
      },
      // A receipt locates the existing Task, never recreates it or leaks its former projection.
      (task) => this.store.getTask(task.id),
    );
  }

  list(resultId: string, revisionId: string, messageId: string): ResultFeedbackFollowUpList {
    const source = this.source(resultId, revisionId, messageId, false);
    const items: ResultFeedbackFollowUpList['items'] = [];
    // Read the persisted relation, not a stored count/backlink. Filter access before the bound.
    const rows = this.store.db
      .prepare(
        `SELECT id FROM tasks WHERE space_id=?
        AND json_extract(body,'$.feedbackOrigin.kind')='result_feedback'
        AND json_extract(body,'$.feedbackOrigin.sourceTaskId')=?
        AND json_extract(body,'$.feedbackOrigin.resultId')=?
        AND json_extract(body,'$.feedbackOrigin.resultRevisionId')=?
        AND json_extract(body,'$.feedbackOrigin.messageId')=? ORDER BY rowid DESC`,
      )
      .iterate(this.store.spaceId, source.task.id, resultId, revisionId, messageId);
    for (const row of rows) {
      let task: Task;
      try {
        task = this.store.getTask(row.id as string);
      } catch (error) {
        if (error instanceof DomainError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code))
          continue;
        throw error;
      }
      if (items.length === 50) return { items, truncated: true };
      const { id, shortId, title, status, ownerUserId, createdAt } = task;
      items.push({ id, shortId, title, status, ownerUserId, createdAt });
    }
    return { items, truncated: false };
  }
}
