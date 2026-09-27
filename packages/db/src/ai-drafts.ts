import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Message } from '../../contracts/src/index.js';
import {
  composeDraftAdoption,
  parseDraftAdoption,
  parseDraftCreate,
  parseDraftEdit,
  selectedDraftText,
  type AiDraft,
  type DraftAdoption,
  type DraftAdoptionPage,
  type DraftHistory,
  type DraftPage,
  type DraftPreview,
  type DraftTarget,
} from '../../contracts/src/ai-drafts.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import {
  applyTaskDescriptionAdoption,
  taskDescriptionTarget,
} from './task-description-adoption.js';
import type { Store } from './store.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const decode = (row: { body: string }) => JSON.parse(row.body) as AiDraft;
function excerpt(value: string, limit: number) {
  const end =
    /[\uD800-\uDBFF]/.test(value[limit - 1] ?? '') && /[\uDC00-\uDFFF]/.test(value[limit] ?? '')
      ? limit - 1
      : limit;
  return value.slice(0, end);
}
/** Human-edited suggestions remain separate from published content and model execution. */
export class AiDraftsStore {
  constructor(private readonly store: Store) {}
  preview(taskId: string, messageId: string): DraftPreview {
    this.store.getTask(taskId);
    const row = this.store.db
      .prepare('SELECT body FROM messages WHERE id=? AND task_id=?')
      .get(messageId, taskId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', 'AI 回复不存在或不可访问', 404);
    const message = JSON.parse(row.body) as Message;
    if (message.actorType !== 'agent' || !message.body.trim())
      throw new DomainError('DRAFT_SOURCE_UNSUPPORTED', '请选择当前任务中已有的 AI 回复', 422);
    return {
      origin: {
        messageId,
        actorName: message.actorName,
        createdAt: message.createdAt,
        hash: hash(message),
        excerpt: excerpt(message.body, 1000),
        truncated: message.body.length > 1000,
      },
      initialContent: excerpt(message.body, 12000),
      contentTruncated: message.body.length > 12000,
    };
  }
  get(taskId: string, id: string, write = false) {
    this.store.getTask(taskId, write);
    const row = this.store.db
      .prepare('SELECT body FROM ai_drafts WHERE id=? AND task_id=?')
      .get(id, taskId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '草稿不存在或不可访问', 404);
    return decode(row);
  }
  list(taskId: string, query: { limit: number; cursor: string | null }): DraftPage {
    this.store.getTask(taskId);
    let rows = (
      this.store.db
        .prepare('SELECT body FROM ai_drafts WHERE task_id=? ORDER BY rowid DESC')
        .all(taskId) as { body: string }[]
    ).map(decode);
    if (query.cursor) {
      const index = rows.findIndex((row) => row.id === query.cursor);
      if (index < 0) throw new DomainError('INVALID_CURSOR', '草稿列表已变化，请重新加载', 409);
      rows = rows.slice(index + 1);
    }
    const items = rows.slice(0, query.limit).map(({ content: _content, ...item }) => item);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }
  private event(taskId: string, kind: string) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(taskId, kind, new Date().toISOString(), this.store.spaceId);
  }
  private record(draft: AiDraft) {
    this.store.db
      .prepare('INSERT INTO ai_draft_revisions(draft_id,revision,body) VALUES(?,?,?)')
      .run(draft.id, draft.revision, JSON.stringify(draft));
    this.event(draft.taskId, 'draft.updated');
  }
  create(taskId: string, input: unknown, key: string): AiDraft {
    this.store.getTask(taskId, true);
    const data = parseDraftCreate(input);
    this.preview(taskId, data.sourceMessageId);
    return this.store.mutate(`draft.create:${taskId}`, key, data, () => {
      this.store.getTask(taskId, true);
      const source = this.preview(taskId, data.sourceMessageId);
      if (source.origin.hash !== data.expectedSourceHash)
        throw new DomainError('DRAFT_SOURCE_CHANGED', 'AI 回复已变化，请核对来源后再保存草稿', 409);
      const at = new Date().toISOString();
      const draft: AiDraft = {
        id: randomUUID(),
        taskId,
        title: data.title,
        content: data.content,
        contentHash: hash({ title: data.title, content: data.content }),
        origin: source.origin,
        revision: 1,
        createdAt: at,
        createdByUserId: this.store.actorId,
        createdByName: this.store.actorName(),
        updatedAt: at,
        updatedByUserId: this.store.actorId,
        updatedByName: this.store.actorName(),
      };
      this.store.db
        .prepare('INSERT INTO ai_drafts(id,task_id,body) VALUES(?,?,?)')
        .run(draft.id, taskId, JSON.stringify(draft));
      this.record(draft);
      return draft;
    });
  }
  edit(taskId: string, id: string, input: unknown, key: string): AiDraft {
    this.get(taskId, id, true);
    const data = parseDraftEdit(input);
    return this.store.mutate(`draft.edit:${id}`, key, { taskId, ...data }, () => {
      const current = this.get(taskId, id, true);
      assertRevision(current.revision, data.expectedRevision);
      const contentHash = hash({ title: data.title, content: data.content });
      if (contentHash === current.contentHash) return current;
      const next = {
        ...current,
        title: data.title,
        content: data.content,
        contentHash,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedByUserId: this.store.actorId,
        updatedByName: this.store.actorName(),
      };
      this.store.db.prepare('UPDATE ai_drafts SET body=? WHERE id=?').run(JSON.stringify(next), id);
      this.record(next);
      return next;
    });
  }
  target(
    taskId: string,
    ref: Pick<DraftTarget, 'kind' | 'id'>,
    write = false,
    requireActive = false,
  ): DraftTarget {
    const task = this.store.getTask(taskId, write);
    if (ref.kind === 'task') {
      if (ref.id !== taskId)
        throw new DomainError('DRAFT_TARGET_SCOPE', '只能采用到当前任务说明', 409);
      return taskDescriptionTarget(this.store, taskId, write);
    }
    if (!task.projectId || task.visibility !== 'project')
      throw new DomainError('DRAFT_TARGET_PRIVATE', '私有草稿不能直接公开到项目资料', 409);
    const source = this.store.projectSources.get(task.projectId, ref.id, write);
    if (requireActive && source.deletedAt)
      throw new DomainError('SOURCE_DELETED', '资料已删除，请选择有效目标', 409);
    return {
      ...ref,
      title: source.title,
      content: source.content,
      revision: source.revision,
      limit: 8000,
    };
  }
  adopt(taskId: string, id: string, input: unknown, key: string): DraftAdoption {
    this.get(taskId, id, true);
    const data = parseDraftAdoption(input);
    this.target(taskId, data.target, true); // Current source/target access also precedes old receipts.
    return this.store.mutate(`draft.adopt:${id}`, key, { taskId, ...data }, () => {
      const draft = this.get(taskId, id, true);
      assertRevision(draft.revision, data.expectedRevision);
      const target = this.target(taskId, data.target, true, true);
      assertRevision(target.revision, data.target.expectedRevision);
      const selectedText = selectedDraftText(draft.content, data.ranges);
      const nextContent = composeDraftAdoption(target, selectedText, data.mode);
      const at = new Date().toISOString();
      let afterRevision = target.revision;
      if (nextContent !== target.content) {
        if (target.kind === 'task') {
          afterRevision = applyTaskDescriptionAdoption(
            this.store,
            taskId,
            target.revision,
            nextContent,
            at,
          );
        } else {
          const task = this.store.getTask(taskId, true);
          // The outer adoption transaction owns revision + source event + receipt atomicity.
          const next = this.store.projectSources.adoptContent(
            task.projectId!,
            target.id,
            target.revision,
            nextContent,
          );
          afterRevision = next.revision;
        }
      }
      const adoption: DraftAdoption = {
        id: randomUUID(),
        taskId,
        draftId: id,
        draftRevision: draft.revision,
        draftHash: draft.contentHash,
        ranges: data.ranges,
        selectedText,
        mode: data.mode,
        target: {
          kind: target.kind,
          id: target.id,
          title: target.title,
          beforeRevision: target.revision,
          afterRevision,
          beforeContent: target.content,
          afterContent: nextContent,
        },
        createdAt: at,
        createdByUserId: this.store.actorId,
        createdByName: this.store.actorName(),
      };
      this.store.db
        .prepare('INSERT INTO ai_draft_adoptions(id,draft_id,task_id,body) VALUES(?,?,?,?)')
        .run(adoption.id, id, taskId, JSON.stringify(adoption));
      this.event(taskId, 'draft.adopted');
      return adoption;
    });
  }
  history(
    taskId: string,
    id: string,
    query: { before: number | null; limit: number },
  ): DraftHistory {
    this.get(taskId, id);
    const rows = (
      this.store.db
        .prepare(
          'SELECT body FROM ai_draft_revisions WHERE draft_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?',
        )
        .all(id, query.before, query.before, query.limit + 1) as { body: string }[]
    ).map(decode);
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.revision : null };
  }
  adoptions(
    taskId: string,
    id: string,
    query: { cursor: string | null; limit: number },
  ): DraftAdoptionPage {
    this.get(taskId, id);
    let rows = (
      this.store.db
        .prepare(
          'SELECT body FROM ai_draft_adoptions WHERE draft_id=? AND task_id=? ORDER BY rowid DESC',
        )
        .all(id, taskId) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as DraftAdoption);
    if (query.cursor) {
      const index = rows.findIndex((row) => row.id === query.cursor);
      if (index < 0) throw new DomainError('INVALID_CURSOR', '采用记录游标无效', 409);
      rows = rows.slice(index + 1);
    }
    const items = rows.slice(0, query.limit);
    for (const row of items) this.target(taskId, row.target);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }
}
