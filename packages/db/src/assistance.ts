import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Message, type Task } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import {
  assistanceExcerpt,
  parseAssistanceCreate,
  parseAssistanceLifecycle,
  parseAssistanceReply,
  type AssistanceCandidates,
  type AssistancePage,
  type AssistancePreview,
  type AssistanceReply,
  type AssistanceReplyPage,
  type AssistanceSnapshot,
  type AssistanceState,
  type AssistanceView,
  type AssistanceRange,
} from '../../contracts/src/assistance.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import type { Store } from './store.js';
const stamp = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
type Query = { cursor: string | null; limit: number; q?: string };
interface RecordBody {
  id: string;
  taskId: string;
  projectId: string | null;
  spaceId: string;
  requesterId: string;
  requesterName: string;
  recipientId: string;
  recipientName: string;
  question: string;
  sourceMessageId: string;
  sourceHash: string;
  ranges: AssistanceRange[];
  snapshot: AssistanceSnapshot;
  state: AssistanceState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
interface Row {
  body: string;
  expires_at: string;
  revoked_at: string | null;
  reason: string | null;
}
/** This grant permits only a frozen excerpt and its replies, never a Task or node capability. */
export class AssistanceStore {
  constructor(private readonly store: Store) {}
  private team() {
    if (!this.store.teamMode)
      throw new DomainError(
        'REAL_IDENTITY_REQUIRED',
        '真人协助需要当前空间的真实账号；示例预览不会发送邀请',
        422,
      );
    return this.store.permissions.space();
  }
  private person(id: string) {
    const row = this.store.db
      .prepare(
        `SELECT p.id,p.name,p.email FROM collab_people p JOIN collab_memberships m ON m.user_id=p.id WHERE m.space_id=? AND p.id=?`,
      )
      .get(this.store.spaceId, id) as unknown as IdentityUser | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '接收者不在当前空间或已退出', 404);
    return row;
  }
  candidates(taskId: string, query: Query): AssistanceCandidates {
    this.team();
    this.store.getTask(taskId, true);
    const q = (query.q ?? '').toLocaleLowerCase();
    let rows = (
      this.store.db
        .prepare(
          `SELECT p.id,p.name FROM collab_people p JOIN collab_memberships m ON m.user_id=p.id WHERE m.space_id=? AND p.id!=? ORDER BY p.id`,
        )
        .all(this.store.spaceId, this.store.actorId) as { id: string; name: string }[]
    ).filter((person) => !q || person.name.toLocaleLowerCase().includes(q));
    rows = this.page(rows, query.cursor);
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }
  private message(taskId: string, id: string) {
    const row = this.store.db
      .prepare('SELECT body FROM messages WHERE task_id=? AND id=?')
      .get(taskId, id) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '协助来源不存在或不可访问', 404);
    const message = JSON.parse(row.body) as Message;
    if (message.actorType === 'system' || !message.body.trim())
      throw new DomainError(
        'ASSISTANCE_SOURCE_UNSUPPORTED',
        '请选择成员讨论或可共享的 AI 回复',
        422,
      );
    return message;
  }
  preview(taskId: string, messageId: string): AssistancePreview {
    this.team();
    this.store.getTask(taskId, true);
    const message = this.message(taskId, messageId);
    const end =
      /[\uD800-\uDBFF]/.test(message.body[11999] ?? '') &&
      /[\uDC00-\uDFFF]/.test(message.body[12000] ?? '')
        ? 11999
        : 12000;
    return {
      sourceMessageId: message.id,
      sourceHash: digest(message),
      actorType: message.actorType as 'human' | 'agent',
      actorName: message.actorName,
      createdAt: message.createdAt,
      text: message.body.slice(0, end),
      originalChars: message.body.length,
      truncated: message.body.length > end,
    };
  }
  private raw(id: string): { row: Row; record: RecordBody; task: Task } {
    this.team();
    const row = this.store.db
      .prepare(
        `SELECT a.body,g.expires_at,g.revoked_at,g.reason FROM assistances a JOIN assistance_grants g ON g.assistance_id=a.id WHERE a.id=? AND a.space_id=?`,
      )
      .get(id, this.store.spaceId) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '协助不存在或不可访问', 404);
    const record = JSON.parse(row.body) as RecordBody;
    const taskRow = this.store.db
      .prepare('SELECT body FROM tasks WHERE id=? AND space_id=?')
      .get(record.taskId, this.store.spaceId) as { body: string } | undefined;
    if (!taskRow) throw new DomainError('NOT_FOUND', '协助来源已不可访问', 404);
    return { row, record, task: JSON.parse(taskRow.body) as Task };
  }
  private scope(id: string) {
    const value = this.raw(id),
      { record, task, row } = value;
    const taskRead = this.store.permissions.canTask(task),
      taskEdit = this.store.permissions.canTask(task, true);
    let authorValid = false;
    try {
      const author = this.person(record.requesterId);
      authorValid =
        task.projectId === record.projectId &&
        this.store.as({ user: author, spaceId: record.spaceId }, () =>
          this.store.permissions.canTask(task, true),
        );
    } catch {
      /* Access is current, not a property of an old receipt. */
    }
    const liveGrant = !row.revoked_at && Date.parse(row.expires_at) > Date.now() && authorValid;
    const recipient = record.recipientId === this.store.actorId;
    const requester = record.requesterId === this.store.actorId;
    if (!taskRead && !(recipient && liveGrant))
      throw new DomainError('NOT_FOUND', '协助访问已撤销或已到期', 404);
    return { ...value, taskRead, taskEdit, liveGrant, recipient, requester };
  }
  get(id: string): AssistanceView {
    const s = this.scope(id),
      { record: a, row, task } = s;
    const original = this.store.db
      .prepare('SELECT body FROM messages WHERE task_id=? AND id=?')
      .get(a.taskId, a.sourceMessageId) as { body: string } | undefined;
    // The flag gives no newer message text to the limited recipient.
    const sourceChanged = !original || digest(JSON.parse(original.body)) !== a.sourceHash;
    return {
      id: a.id,
      question: a.question,
      requesterId: a.requesterId,
      requesterName: a.requesterName,
      recipientId: a.recipientId,
      recipientName: a.recipientName,
      state: a.state,
      revision: a.revision,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      expiresAt: row.expires_at,
      grantRevokedAt: row.revoked_at,
      grantReason: row.reason,
      canReply:
        ['open', 'responded'].includes(a.state) &&
        s.liveGrant &&
        (s.recipient || (s.requester && s.taskEdit)),
      canManage: s.taskEdit,
      task: s.taskRead ? { id: task.id, shortId: task.shortId, title: task.title } : null,
      snapshot: a.snapshot,
      sourceChanged,
    };
  }
  private page<T extends { id: string }>(rows: T[], cursor: string | null) {
    if (!cursor) return rows;
    const index = rows.findIndex((row) => row.id === cursor);
    if (index < 0) throw new DomainError('INVALID_CURSOR', '协助列表已变化，请重新加载', 409);
    return rows.slice(index + 1);
  }
  list(query: Query, taskId?: string): AssistancePage {
    this.team();
    if (taskId) this.store.getTask(taskId);
    const rows = this.store.db
      .prepare(
        `SELECT id,body FROM assistances WHERE space_id=?${taskId ? ' AND task_id=?' : ''} ORDER BY rowid DESC`,
      )
      .all(...(taskId ? [this.store.spaceId, taskId] : [this.store.spaceId])) as {
      id: string;
      body: string;
    }[];
    const visible: AssistanceView[] = [];
    for (const row of rows) {
      const record = JSON.parse(row.body) as RecordBody;
      if (
        !taskId &&
        record.requesterId !== this.store.actorId &&
        record.recipientId !== this.store.actorId
      )
        continue;
      try {
        visible.push(this.get(row.id));
      } catch {
        /* Do not return unrelated or revoked snapshot metadata. */
      }
    }
    const page = this.page(visible, query.cursor),
      items = page
        .slice(0, query.limit)
        .map(({ snapshot: _snapshot, sourceChanged: _changed, ...item }) => item);
    return { items, nextCursor: page.length > query.limit ? items.at(-1)!.id : null };
  }
  private event(id: string, action: string, actor = this.store.actorId) {
    this.store.db
      .prepare(
        'INSERT INTO outbox(task_id,kind,created_at,space_id,assistance_id) VALUES(NULL,?,?,?,?)',
      )
      .run(
        action === 'access_revoked' ? 'assistance.access_changed' : 'assistance.updated',
        stamp(),
        this.store.spaceId,
        id,
      );
    this.store.db
      .prepare(
        'INSERT INTO assistance_events(id,assistance_id,action,actor_id,created_at) VALUES(?,?,?,?,?)',
      )
      .run(randomUUID(), id, action, actor, stamp());
  }
  create(taskId: string, input: unknown, key: string): AssistanceView {
    this.team();
    this.store.getTask(taskId, true);
    const data = parseAssistanceCreate(input);
    this.preview(taskId, data.sourceMessageId);
    const result = this.store.mutate(`assistance.create:${taskId}`, key, data, () => {
      const task = this.store.getTask(taskId, true),
        recipient = this.person(data.recipientUserId);
      if (recipient.id === this.store.actorId)
        throw new DomainError('INVALID_INPUT', '请选择另一位当前空间成员', 409);
      const message = this.message(taskId, data.sourceMessageId);
      if (digest(message) !== data.expectedSourceHash)
        throw new DomainError('ASSISTANCE_SOURCE_CHANGED', '来源已变化，请重新核对分享内容', 409);
      const text = assistanceExcerpt(message.body, data.ranges),
        at = stamp(),
        id = randomUUID();
      const selectedChars = data.ranges.reduce((sum, range) => sum + range.end - range.start, 0);
      const record: RecordBody = {
        id,
        taskId,
        projectId: task.projectId,
        spaceId: task.spaceId,
        requesterId: this.store.actorId,
        requesterName: this.store.actorName(),
        recipientId: recipient.id,
        recipientName: recipient.name,
        question: data.question,
        sourceMessageId: message.id,
        sourceHash: data.expectedSourceHash,
        ranges: data.ranges,
        snapshot: {
          text,
          actorType: message.actorType as 'human' | 'agent',
          actorName: message.actorName,
          createdAt: message.createdAt,
          selectedChars,
          omittedChars: message.body.length - selectedChars,
        },
        state: 'open',
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      this.store.db
        .prepare('INSERT INTO assistances(id,task_id,space_id,body) VALUES(?,?,?,?)')
        .run(id, taskId, task.spaceId, JSON.stringify(record));
      this.store.db
        .prepare(
          'INSERT INTO assistance_grants(assistance_id,recipient_id,space_id,expires_at) VALUES(?,?,?,?)',
        )
        .run(
          id,
          recipient.id,
          task.spaceId,
          new Date(Date.now() + data.expiresInDays * 86400_000).toISOString(),
        );
      this.event(id, 'created');
      return { id };
    });
    return this.get(result.id);
  }
  private save(record: RecordBody) {
    const next = { ...record, revision: record.revision + 1, updatedAt: stamp() };
    this.store.db
      .prepare('UPDATE assistances SET body=? WHERE id=?')
      .run(JSON.stringify(next), next.id);
    return next;
  }
  reply(id: string, input: unknown, key: string): AssistanceReply {
    const initial = this.scope(id),
      data = parseAssistanceReply(input);
    const allowed = (scope: typeof initial) =>
      scope.liveGrant && (scope.recipient || (scope.requester && scope.taskEdit));
    if (!allowed(initial)) throw new DomainError('FORBIDDEN', '当前协助授权不允许回复', 403);
    return this.store.mutate(`assistance.reply:${id}`, key, data, () => {
      const scope = this.scope(id);
      if (!allowed(scope)) throw new DomainError('FORBIDDEN', '协助回复权限已变化', 403);
      if (!['open', 'responded'].includes(scope.record.state))
        throw new DomainError('ASSISTANCE_CLOSED', '协助已关闭，不能追加回复', 409);
      const reply: AssistanceReply = {
        id: randomUUID(),
        assistanceId: id,
        body: data.body,
        authorId: this.store.actorId,
        authorName: this.store.actorName(),
        createdAt: stamp(),
      };
      this.store.db
        .prepare('INSERT INTO assistance_replies(id,assistance_id,body) VALUES(?,?,?)')
        .run(reply.id, id, JSON.stringify(reply));
      this.save({ ...scope.record, state: scope.recipient ? 'responded' : 'open' });
      this.event(id, 'replied');
      return reply;
    });
  }
  replies(id: string, query: Query): AssistanceReplyPage {
    this.scope(id);
    const rows = (
      this.store.db
        .prepare('SELECT body FROM assistance_replies WHERE assistance_id=? ORDER BY rowid DESC')
        .all(id) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as AssistanceReply);
    const page = this.page(rows, query.cursor),
      items = page.slice(0, query.limit);
    return { items, nextCursor: page.length > query.limit ? items.at(-1)!.id : null };
  }
  lifecycle(id: string, input: unknown, key: string): AssistanceView {
    if (!this.scope(id).taskEdit)
      throw new DomainError('FORBIDDEN', '关闭或撤回协助需要任务编辑权限', 403);
    const data = parseAssistanceLifecycle(input);
    this.store.mutate(`assistance.lifecycle:${id}`, key, data, () => {
      const scope = this.scope(id);
      if (!scope.taskEdit) throw new DomainError('FORBIDDEN', '任务编辑权限已变化', 403);
      assertRevision(scope.record.revision, data.expectedRevision);
      const state = data.action === 'cancel' ? 'cancelled' : 'closed';
      if (scope.record.state === state) return { id };
      if (scope.record.state === 'cancelled')
        throw new DomainError('ASSISTANCE_CLOSED', '已撤回的协助不能重新开放', 409);
      this.save({ ...scope.record, state });
      if (state === 'cancelled') this.revoke(id, '请求已撤回');
      this.event(id, data.action);
      return { id };
    });
    return this.get(id);
  }
  private revoke(id: string, reason: string) {
    const result = this.store.db
      .prepare(
        'UPDATE assistance_grants SET revoked_at=?,reason=? WHERE assistance_id=? AND revoked_at IS NULL',
      )
      .run(stamp(), reason, id);
    if (result.changes) this.event(id, 'access_revoked');
  }
  /** Called within the existing membership transaction; rejoining never revives these grants. */
  revokeSpaceMember(spaceId: string, userId: string) {
    const rows = this.store.db
      .prepare('SELECT id,body FROM assistances WHERE space_id=?')
      .all(spaceId) as { id: string; body: string }[];
    for (const row of rows) {
      const a = JSON.parse(row.body) as RecordBody;
      if (a.requesterId === userId || a.recipientId === userId)
        this.revoke(row.id, '相关成员已退出空间');
    }
  }
  revokeProjectMember(projectId: string, userId: string, removed: boolean) {
    const rows = this.store.db
      .prepare('SELECT id,body FROM assistances WHERE space_id=?')
      .all(this.store.spaceId) as { id: string; body: string }[];
    for (const row of rows) {
      const a = JSON.parse(row.body) as RecordBody;
      if (
        a.projectId === projectId &&
        (a.requesterId === userId || (removed && a.recipientId === userId))
      )
        this.revoke(row.id, '相关项目访问或分享权限已撤销');
    }
  }
  eventVisible(id: string, kind: string, taskId?: string) {
    try {
      const { record, task } = this.raw(id);
      if (taskId && record.taskId !== taskId) return false;
      if (
        kind === 'assistance.access_changed' &&
        (record.requesterId === this.store.actorId || record.recipientId === this.store.actorId)
      )
        return true;
      if (this.store.permissions.canTask(task)) return true;
      this.scope(id);
      return true;
    } catch {
      return false;
    }
  }
}
