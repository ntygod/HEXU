import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Message, type Task } from '../../contracts/src/index.js';
import {
  ASSISTANCE_SOURCE_LIMIT,
  parseAssistanceCreate,
  parseAssistanceReply,
  parseAssistanceStateChange,
  selectedAssistanceText,
  type Assistance,
  type AssistanceDetail,
  type AssistanceList,
  type AssistancePerson,
  type AssistancePreview,
  type AssistanceReply,
  type AssistanceSnapshot,
  type AssistanceState,
  type AssistanceRange,
  type AssistanceRecipients,
  type parseAssistanceList,
  type parseAssistanceHistory,
  type parseAssistanceRecipients,
} from '../../contracts/src/assistance.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import type { Store } from './store.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const now = () => new Date().toISOString();
interface AssistanceRecord {
  id: string;
  taskId: string;
  spaceId: string;
  question: string;
  requester: AssistancePerson;
  recipient: AssistancePerson;
  state: AssistanceState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceMessageId: string;
  sourceRange: AssistanceRange;
  taskRevision: number;
  snapshot: AssistanceSnapshot;
  snapshotHash: string;
}
interface Grant {
  snapshot_hash: string;
  revoked_at: string | null;
}
/** A grant authorizes only this immutable excerpt/thread, never the parent task or execution. */
export class AssistanceStore {
  constructor(private readonly store: Store) {}
  private team() {
    if (!this.store.teamMode)
      throw new DomainError(
        'TEAM_MODE_REQUIRED',
        '真人协助需要真实账号与同空间成员；示例身份不能代替同事',
        422,
      );
    this.store.permissions.space();
  }
  private task(id: string): Task {
    const row = this.store.db
      .prepare('SELECT body FROM tasks WHERE id=? AND space_id=?')
      .get(id, this.store.spaceId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
    return JSON.parse(row.body) as Task;
  }
  private member(id: string): AssistancePerson {
    const row = this.store.db
      .prepare(
        `SELECT p.id,p.name FROM collab_people p
      JOIN collab_memberships m ON p.id=m.user_id WHERE m.space_id=? AND p.id=?`,
      )
      .get(this.store.spaceId, id) as AssistancePerson | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '接收者不在当前空间或访问已撤销', 404);
    return row;
  }
  private sourceReadable(item: AssistanceRecord, task: Task) {
    if (
      !this.store.db
        .prepare('SELECT 1 FROM collab_memberships WHERE space_id=? AND user_id=?')
        .get(item.spaceId, item.requester.id)
    )
      return false;
    if (task.visibility === 'private') return task.ownerUserId === item.requester.id;
    return (
      !!task.projectId &&
      !!this.store.db
        .prepare(
          `SELECT 1 FROM collab_project_members
      WHERE project_id=? AND user_id=?`,
        )
        .get(task.projectId, item.requester.id)
    );
  }
  private raw(id: string): AssistanceRecord {
    const row = this.store.db
      .prepare('SELECT body FROM assistances WHERE id=? AND space_id=?')
      .get(id, this.store.spaceId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
    return JSON.parse(row.body) as AssistanceRecord;
  }
  private grant(item: AssistanceRecord): Grant {
    const grant = this.store.db
      .prepare(
        `SELECT snapshot_hash,revoked_at FROM assistance_grants
      WHERE assistance_id=? AND recipient_id=? AND scope='snapshot_reply'`,
      )
      .get(item.id, item.recipient.id) as Grant | undefined;
    if (
      !grant ||
      grant.snapshot_hash !== item.snapshotHash ||
      hash(item.snapshot) !== item.snapshotHash
    )
      throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
    return grant;
  }
  private read(id: string) {
    this.team();
    const item = this.raw(id),
      task = this.task(item.taskId),
      grant = this.grant(item);
    const actor = this.store.actorId;
    // A named recipient's revoked grant cannot be revived by a later project invitation.
    if (actor === item.recipient.id) {
      this.member(actor);
      if (grant.revoked_at || !this.sourceReadable(item, task))
        throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
    } else this.store.permissions.task(task);
    return { item, task, grant };
  }
  canRead(id: string) {
    try {
      this.read(id);
      return true;
    } catch (cause) {
      if (cause instanceof DomainError) return false;
      throw cause;
    }
  }
  belongsToTask(id: string, taskId: string) {
    return this.read(id).item.taskId === taskId;
  }
  private source(taskId: string, messageId: string) {
    this.store.getTask(taskId, true);
    const row = this.store.db
      .prepare('SELECT body FROM messages WHERE id=? AND task_id=?')
      .get(messageId, taskId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '来源消息不存在或不可访问', 404);
    const message = JSON.parse(row.body) as Message;
    if (!['human', 'agent'].includes(message.actorType) || !message.body.trim())
      throw new DomainError(
        'ASSISTANCE_SOURCE_UNSUPPORTED',
        '请选择一条人工讨论或可共享的 AI 回复',
        422,
      );
    return message;
  }
  preview(taskId: string, messageId: string): AssistancePreview {
    this.team();
    const task = this.store.getTask(taskId, true),
      message = this.source(taskId, messageId);
    let end = Math.min(message.body.length, ASSISTANCE_SOURCE_LIMIT);
    if (
      (/[\uD800-\uDBFF]/.test(message.body[end - 1] ?? '') &&
        /[\uDC00-\uDFFF]/.test(message.body[end] ?? '')) ||
      (message.body[end - 1] === '\r' && message.body[end] === '\n')
    )
      end--;
    return {
      messageId,
      taskRevision: task.revision,
      sourceHash: hash(message),
      content: message.body.slice(0, end),
      truncated: end < message.body.length,
      actorName: message.actorName,
      actorType: message.actorType as 'human' | 'agent',
      createdAt: message.createdAt,
    };
  }
  recipients(
    taskId: string,
    query: ReturnType<typeof parseAssistanceRecipients>,
  ): AssistanceRecipients {
    this.team();
    this.store.getTask(taskId, true);
    const people = (
      this.store.db
        .prepare(
          `SELECT p.id,p.name FROM collab_people p
      JOIN collab_memberships m ON m.user_id=p.id WHERE m.space_id=? AND p.id!=? ORDER BY p.id`,
        )
        .all(this.store.spaceId, this.store.actorId) as unknown as AssistancePerson[]
    ).filter(
      (p) =>
        (!query.q || p.name.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) &&
        (!query.cursor || p.id > query.cursor),
    );
    const items = people.slice(0, query.limit);
    return { items, nextCursor: people.length > query.limit ? items.at(-1)!.id : null };
  }
  private event(item: AssistanceRecord, action: string) {
    this.store.db
      .prepare(
        `INSERT INTO assistance_events(assistance_id,revision,actor_id,action,created_at)
      VALUES(?,?,?,?,?)`,
      )
      .run(item.id, item.revision, this.store.actorId, action, item.updatedAt);
    // No task, project, question or excerpt is sent on the recipient's event channel.
    this.store.db
      .prepare(
        `INSERT INTO outbox(task_id,kind,created_at,space_id,assistance_id)
      VALUES(NULL,'assistance.updated',?,?,?)`,
      )
      .run(item.updatedAt, item.spaceId, item.id);
  }
  private write(item: AssistanceRecord, action: string) {
    this.store.db
      .prepare('UPDATE assistances SET state=?,body=? WHERE id=?')
      .run(item.state, JSON.stringify(item), item.id);
    this.event(item, action);
  }
  create(taskId: string, input: unknown, key: string): AssistanceDetail {
    this.team();
    this.store.getTask(taskId, true);
    const data = parseAssistanceCreate(input);
    this.source(taskId, data.sourceMessageId);
    this.member(data.recipientId);
    if (data.recipientId === this.store.actorId)
      throw new DomainError('INVALID_INPUT', '请选择另一位同空间成员');
    const receipt = this.store.mutate(`assistance.create:${taskId}`, key, data, () => {
      const task = this.store.getTask(taskId, true),
        source = this.source(taskId, data.sourceMessageId);
      assertRevision(task.revision, data.expectedTaskRevision);
      if (hash(source) !== data.expectedSourceHash)
        throw new DomainError(
          'ASSISTANCE_SOURCE_CHANGED',
          '来源消息已变化，请核对后重新选择分享片段',
          409,
        );
      const count = this.store.db
        .prepare(
          `SELECT count(*) AS n FROM assistances
        WHERE space_id=? AND requester_id=? AND state IN ('open','responded')`,
        )
        .get(this.store.spaceId, this.store.actorId) as { n: number };
      if (count.n >= 50)
        throw new DomainError(
          'ASSISTANCE_LIMIT',
          '最多保留 50 项未结束协助，请先处理已有协助',
          422,
        );
      const snapshot: AssistanceSnapshot = {
        text: selectedAssistanceText(source.body, data.range),
        actorName: source.actorName,
        actorType: source.actorType as 'human' | 'agent',
        createdAt: source.createdAt,
        sourceHash: data.expectedSourceHash,
      };
      const at = now();
      const item: AssistanceRecord = {
        id: randomUUID(),
        taskId,
        spaceId: this.store.spaceId,
        question: data.question,
        requester: this.member(this.store.actorId),
        recipient: this.member(data.recipientId),
        state: 'open',
        revision: 1,
        createdAt: at,
        updatedAt: at,
        snapshot,
        snapshotHash: hash(snapshot),
        sourceMessageId: source.id,
        sourceRange: data.range,
        taskRevision: task.revision,
      };
      this.store.db
        .prepare(
          `INSERT INTO assistances(id,space_id,task_id,requester_id,recipient_id,state,body)
        VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          item.id,
          item.spaceId,
          taskId,
          item.requester.id,
          item.recipient.id,
          item.state,
          JSON.stringify(item),
        );
      this.store.db
        .prepare(
          `INSERT INTO assistance_grants(assistance_id,recipient_id,snapshot_hash,scope,revoked_at)
        VALUES(?,?,?,'snapshot_reply',NULL)`,
        )
        .run(item.id, item.recipient.id, item.snapshotHash);
      this.event(item, 'created');
      // Receipts contain only an ID; every replay returns a newly authorized current projection.
      return { id: item.id };
    });
    return this.get(receipt.id);
  }
  get(
    id: string,
    query: ReturnType<typeof parseAssistanceHistory> = { before: null, limit: 20 },
  ): AssistanceDetail {
    const { item, task, grant } = this.read(id);
    const visibleTask = this.store.permissions.canTask(task),
      writer = this.store.permissions.canTask(task, true);
    const accessEnded = !!grant.revoked_at || !this.sourceReadable(item, task);
    const canManage = item.requester.id === this.store.actorId && writer;
    const canReply =
      !accessEnded &&
      ['open', 'responded'].includes(item.state) &&
      (canManage || item.recipient.id === this.store.actorId);
    let sourceChanged: boolean | null = null;
    if (visibleTask) {
      const source = this.store.db
        .prepare('SELECT body FROM messages WHERE id=? AND task_id=?')
        .get(item.sourceMessageId, item.taskId) as { body: string } | undefined;
      sourceChanged = !source || hash(JSON.parse(source.body)) !== item.snapshot.sourceHash;
    }
    const replies = (
      this.store.db
        .prepare(
          `SELECT body FROM assistance_replies WHERE assistance_id=?
      AND revision<? ORDER BY revision DESC LIMIT ?`,
        )
        .all(id, query.before ?? Number.MAX_SAFE_INTEGER, query.limit + 1) as { body: string }[]
    ).map((r) => JSON.parse(r.body) as AssistanceReply);
    const page = replies.slice(0, query.limit);
    return {
      assistance: {
        id: item.id,
        question: item.question,
        requester: item.requester,
        recipient: item.recipient,
        state: item.state,
        revision: item.revision,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        snapshot: item.snapshot,
        snapshotHash: item.snapshotHash,
        sourceChanged,
        accessEnded,
        canReply,
        canManage,
        taskLink: visibleTask ? { id: task.id, title: task.title, shortId: task.shortId } : null,
      },
      replies: page.reverse(),
      nextBefore: replies.length > query.limit ? page[0]!.revision : null,
    };
  }
  list(query: ReturnType<typeof parseAssistanceList>, taskId?: string): AssistanceList {
    this.team();
    if (taskId) this.store.getTask(taskId);
    const filter = taskId
      ? 'task_id=?'
      : `${query.box === 'received' ? 'recipient_id' : 'requester_id'}=?`;
    const rows = this.store.db
      .prepare(
        `SELECT id FROM assistances WHERE space_id=? AND ${filter}
      ${query.state === 'active' ? "AND state IN ('open','responded')" : ''} ORDER BY rowid DESC`,
      )
      .all(this.store.spaceId, taskId ?? this.store.actorId) as { id: string }[];
    let visible = rows.filter((r) => this.canRead(r.id));
    if (query.cursor) {
      const at = visible.findIndex((r) => r.id === query.cursor);
      if (at < 0) throw new DomainError('INVALID_CURSOR', '协助列表已变化，请返回首页', 409);
      visible = visible.slice(at + 1);
    }
    const items = visible.slice(0, query.limit).map(({ id }) => {
      const { snapshot: _snapshot, ...item } = this.get(id, { before: null, limit: 1 }).assistance;
      return item;
    });
    return { items, nextCursor: visible.length > query.limit ? items.at(-1)!.id : null };
  }
  private replyActor(id: string) {
    const { item, task, grant } = this.read(id);
    if (grant.revoked_at || !this.sourceReadable(item, task))
      throw new DomainError('FORBIDDEN', '协助分享已撤销', 403);
    if (item.requester.id === this.store.actorId) this.store.permissions.task(task, true);
    else if (item.recipient.id !== this.store.actorId)
      throw new DomainError('FORBIDDEN', '只有发起者和指定接收者可以回复此协助', 403);
    return item;
  }
  reply(id: string, input: unknown, key: string): AssistanceDetail {
    this.replyActor(id);
    const data = parseAssistanceReply(input);
    this.store.mutate(`assistance.reply:${id}`, key, data, () => {
      const item = this.replyActor(id);
      assertRevision(item.revision, data.expectedRevision);
      if (!['open', 'responded'].includes(item.state))
        throw new DomainError('ASSISTANCE_CLOSED', '协助已结束，不能再回复', 409);
      const count = this.store.db
        .prepare('SELECT count(*) AS n FROM assistance_replies WHERE assistance_id=?')
        .get(id) as { n: number };
      if (count.n >= 200)
        throw new DomainError(
          'ASSISTANCE_LIMIT',
          '此协助已达 200 条回复，请结束后针对新问题发起协助',
          422,
        );
      const next = {
        ...item,
        revision: item.revision + 1,
        updatedAt: now(),
        state:
          this.store.actorId === item.recipient.id ? ('responded' as const) : ('open' as const),
      };
      const reply: AssistanceReply = {
        id: randomUUID(),
        revision: next.revision,
        body: data.body,
        author: this.member(this.store.actorId),
        createdAt: next.updatedAt,
      };
      this.store.db
        .prepare('INSERT INTO assistance_replies(assistance_id,revision,body) VALUES(?,?,?)')
        .run(id, next.revision, JSON.stringify(reply));
      this.write(next, 'replied');
      return { id };
    });
    return this.get(id);
  }
  private manager(id: string) {
    const data = this.read(id);
    if (data.item.requester.id !== this.store.actorId)
      throw new DomainError('FORBIDDEN', '只有发起者可结束或撤销这次协助', 403);
    this.store.permissions.task(data.task, true);
    return data;
  }
  change(id: string, input: unknown, key: string): AssistanceDetail {
    this.manager(id);
    const data = parseAssistanceStateChange(input);
    this.store.mutate(`assistance.state:${id}`, key, data, () => {
      const { item } = this.manager(id);
      assertRevision(item.revision, data.expectedRevision);
      if (item.state === 'cancelled' || (data.action === 'close' && item.state === 'closed'))
        return { id };
      const next = {
        ...item,
        state: data.action === 'cancel' ? ('cancelled' as const) : ('closed' as const),
        revision: item.revision + 1,
        updatedAt: now(),
      };
      if (data.action === 'cancel')
        this.store.db
          .prepare('UPDATE assistance_grants SET revoked_at=? WHERE assistance_id=?')
          .run(next.updatedAt, id);
      this.write(next, data.action === 'cancel' ? 'cancelled' : 'closed');
      return { id };
    });
    return this.get(id);
  }
  /** Called inside the membership transaction; rejoining cannot revive this grant. */
  revokeMember(spaceId: string, userId: string, projectId?: string) {
    const rows = this.store.db
      .prepare(
        `SELECT a.body FROM assistances a JOIN tasks t ON t.id=a.task_id
      JOIN assistance_grants g ON g.assistance_id=a.id WHERE a.space_id=?
      AND (a.requester_id=? OR a.recipient_id=?) AND g.revoked_at IS NULL
      ${projectId ? "AND json_extract(t.body,'$.projectId')=?" : ''}`,
      )
      .all(...(projectId ? [spaceId, userId, userId, projectId] : [spaceId, userId, userId])) as {
      body: string;
    }[];
    for (const row of rows) {
      const item = JSON.parse(row.body) as AssistanceRecord;
      const next = {
        ...item,
        state: 'cancelled' as const,
        revision: item.revision + 1,
        updatedAt: now(),
      };
      this.store.db
        .prepare('UPDATE assistance_grants SET revoked_at=? WHERE assistance_id=?')
        .run(next.updatedAt, item.id);
      this.write(next, 'access_revoked');
    }
  }
}
