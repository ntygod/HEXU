import {
  parseAiAssistanceCreate,
  renderAiAssistance,
  type AiAssistanceCreate,
} from '../../contracts/src/ai-assistance.js';
import { isActiveRun } from '../../domain/src/index.js';
import type { Run } from '../../contracts/src/index.js';
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
export interface AssistanceRecord {
  recipientKind?: 'ai' | 'agent';
  ai?: { runId: string; inputText: string; inputHash: string };
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
      WHERE assistance_id=? AND recipient_id=? AND scope=?`,
      )
      .get(
        item.id,
        item.recipient.id,
        item.recipientKind === 'ai' ? 'model_text' : 'snapshot_reply',
      ) as Grant | undefined;
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
    if (item.recipientKind !== 'ai' && actor === item.recipient.id) {
      this.member(actor);
      if (grant.revoked_at || !this.sourceReadable(item, task))
        throw new DomainError('NOT_FOUND', '协助不存在或访问已撤销', 404);
    } else this.store.permissions.task(task);
    return { item, task, grant };
  }
  canRead(id: string) {
    try {
      if (this.store.agentAssistance.isAgent(id)) {
        this.store.agentAssistance.get(id);
        return true;
      }
      this.read(id);
      return true;
    } catch (cause) {
      if (cause instanceof DomainError) return false;
      throw cause;
    }
  }
  belongsToTask(id: string, taskId: string) {
    if (this.store.agentAssistance.isAgent(id))
      return this.store.agentAssistance.get(id).assistance.taskLink?.id === taskId;
    return this.read(id).item.taskId === taskId;
  }
  /** Internal task-scoped adoption boundary; snapshot_reply never satisfies task access. */
  adoptionContext(taskId: string, id: string, write = false) {
    this.store.getTask(taskId, write);
    if (this.store.agentAssistance.isAgent(id))
      throw new DomainError('AGENT_ADOPTION_UNSUPPORTED', '外部答案本片不支持采用或自动接续', 422);
    const data = this.read(id);
    if (data.item.taskId !== taskId)
      throw new DomainError('NOT_FOUND', '协助不属于当前任务或不可访问', 404);
    return {
      ...data,
      accessEnded: !!data.grant.revoked_at || !this.sourceReadable(data.item, data.task),
    };
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
  private event(item: AssistanceRecord, action: string, actorId?: string) {
    this.store.db
      .prepare(
        `INSERT INTO assistance_events(assistance_id,revision,actor_id,action,created_at)
      VALUES(?,?,?,?,?)`,
      )
      .run(item.id, item.revision, actorId ?? this.store.actorId, action, item.updatedAt);
    // No task, project, question or excerpt is sent on the recipient's event channel.
    this.store.db
      .prepare(
        `INSERT INTO outbox(task_id,kind,created_at,space_id,assistance_id)
      VALUES(NULL,'assistance.updated',?,?,?)`,
      )
      .run(item.updatedAt, item.spaceId, item.id);
  }
  private write(item: AssistanceRecord, action: string, actorId?: string) {
    this.store.db
      .prepare('UPDATE assistances SET state=?,body=? WHERE id=?')
      .run(item.state, JSON.stringify(item), item.id);
    this.event(item, action, actorId);
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
    if (this.store.agentAssistance.isAgent(id)) return this.store.agentAssistance.get(id);
    const { item, task, grant } = this.read(id);
    const visibleTask = this.store.permissions.canTask(task),
      writer = this.store.permissions.canTask(task, true);
    const accessEnded = !!grant.revoked_at || !this.sourceReadable(item, task);
    const canManage = item.requester.id === this.store.actorId && writer;
    const canReply =
      item.recipientKind !== 'ai' &&
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
        ...(item.ai
          ? {
              recipientKind: 'ai' as const,
              ai: {
                run: this.store.run(item.ai.runId),
                inputText: item.ai.inputText,
                inputHash: item.ai.inputHash,
              },
            }
          : {}),
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
        canEditTask: writer,
        canAdopt: writer && !accessEnded && item.state !== 'cancelled',
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
    if (this.store.agentAssistance.isAgent(id))
      throw new DomainError('USE_TYPED_RESPONSE', 'Agent 协助请使用类型回应', 422);
    const { item, task, grant } = this.read(id);
    if (item.recipientKind === 'ai')
      throw new DomainError(
        'AI_FOLLOWUP_REQUIRES_CONSENT',
        'AI 协助下一次执行必须重新明确选材与费用；不能通过真人回复接口派发',
        422,
      );
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
    if (this.store.agentAssistance.isAgent(id))
      return this.store.agentAssistance.change(id, input, key);
    this.manager(id);
    const data = parseAssistanceStateChange(input);
    this.store.mutate(`assistance.state:${id}`, key, data, () => {
      const { item } = this.manager(id);
      assertRevision(item.revision, data.expectedRevision);
      if (item.state === 'cancelled' || (data.action === 'close' && item.state === 'closed'))
        return { id };
      if (item.ai && data.action === 'close' && isActiveRun(this.store.run(item.ai.runId).state))
        throw new DomainError('ASSISTANCE_RUNNING', 'AI 执行尚未确认结束，请先取消本次协助', 409);
      if (data.action === 'cancel') this.stopAi(item);
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

  /** Invoked by the fixed node dispatcher; its callback writes the Run and dispatch
   * within this same idempotent transaction, before any process may launch. */
  createAi(
    taskId: string,
    input: unknown,
    key: string,
    dispatch: (item: AssistanceRecord, data: AiAssistanceCreate) => Run,
  ): AssistanceDetail {
    this.team();
    this.store.getTask(taskId, true);
    const data = parseAiAssistanceCreate(input);
    this.source(taskId, data.sourceMessageId); // Also required before receipt replay.
    const receipt = this.store.mutate(`assistance.ai.create:${taskId}`, key, data, () => {
      const task = this.store.getTask(taskId, true),
        source = this.source(taskId, data.sourceMessageId);
      assertRevision(task.revision, data.expectedTaskRevision);
      if (hash(source) !== data.expectedSourceHash)
        throw new DomainError(
          'ASSISTANCE_SOURCE_CHANGED',
          '来源消息已变化，请重新核对模型材料',
          409,
        );
      const count = this.store.db
        .prepare(
          "SELECT count(*) AS n FROM assistances WHERE space_id=? AND requester_id=? AND state IN ('open','responded')",
        )
        .get(this.store.spaceId, this.store.actorId) as { n: number };
      if (count.n >= 50) throw new DomainError('ASSISTANCE_LIMIT', '请先处理已有未结束协助', 422);
      const snapshot: AssistanceSnapshot = {
        text: selectedAssistanceText(source.body, data.range),
        actorName: source.actorName,
        actorType: source.actorType as 'human' | 'agent',
        createdAt: source.createdAt,
        sourceHash: data.expectedSourceHash,
      };
      const inputText = renderAiAssistance(data.question, snapshot.text),
        at = now();
      const item: AssistanceRecord = {
        id: randomUUID(),
        taskId,
        spaceId: task.spaceId,
        question: data.question,
        requester: this.member(this.store.actorId),
        recipient: { id: 'tool:claude-code', name: 'Claude Code' },
        recipientKind: 'ai',
        state: 'open',
        revision: 1,
        createdAt: at,
        updatedAt: at,
        sourceMessageId: source.id,
        sourceRange: data.range,
        taskRevision: task.revision,
        snapshot,
        snapshotHash: hash(snapshot),
        ai: { runId: randomUUID(), inputText, inputHash: hash(inputText) },
      };
      this.store.db
        .prepare(
          'INSERT INTO assistances(id,space_id,task_id,requester_id,recipient_id,state,body) VALUES(?,?,?,?,?,?,?)',
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
        .prepare("INSERT INTO assistance_grants VALUES(?,?,?,'model_text',NULL)")
        .run(item.id, item.recipient.id, item.snapshotHash);
      dispatch(item, data);
      this.event(item, 'ai_created');
      return { id: item.id };
    });
    return this.get(receipt.id);
  }
  /** Internal proof of current model-output authority; does not depend on HTTP Cookie context. */
  aiAuthorized(runId: string): boolean {
    const row = this.store.db
      .prepare(
        "SELECT a.body,t.body AS task_body,g.revoked_at,g.snapshot_hash FROM assistances a JOIN tasks t ON t.id=a.task_id JOIN assistance_grants g ON g.assistance_id=a.id WHERE json_extract(a.body,'$.ai.runId')=? AND g.scope='model_text'",
      )
      .get(runId) as
      | { body: string; task_body: string; revoked_at: string | null; snapshot_hash: string }
      | undefined;
    if (!row) return false;
    const item = JSON.parse(row.body) as AssistanceRecord,
      task = JSON.parse(row.task_body) as Task;
    if (
      item.recipientKind !== 'ai' ||
      !item.ai ||
      !['open', 'responded'].includes(item.state) ||
      row.revoked_at ||
      item.snapshotHash !== row.snapshot_hash ||
      hash(item.snapshot) !== row.snapshot_hash ||
      item.ai.inputHash !== hash(item.ai.inputText) ||
      item.ai.inputText !== renderAiAssistance(item.question, item.snapshot.text)
    )
      return false;
    if (!this.sourceReadable(item, task)) return false;
    if (task.visibility === 'private') return task.ownerUserId === item.requester.id;
    const role = this.store.db
      .prepare('SELECT role FROM collab_project_members WHERE project_id=? AND user_id=?')
      .get(task.projectId!, item.requester.id) as { role: string } | undefined;
    return role?.role === 'edit' || role?.role === 'manage';
  }
  /** Only a terminal dispatch may produce this response. No user-facing route calls it. */
  completeAi(run: Run, state: string, body: string) {
    if (state !== 'succeeded' || !run.assistanceId || !this.aiAuthorized(run.id)) return;
    const row = this.store.db
      .prepare('SELECT body FROM assistances WHERE id=?')
      .get(run.assistanceId) as { body: string };
    const item = JSON.parse(row.body) as AssistanceRecord;
    if (item.ai?.runId !== run.id || item.state !== 'open') return;
    const next = {
      ...item,
      state: 'responded' as const,
      revision: item.revision + 1,
      updatedAt: now(),
    };
    const reply: AssistanceReply = {
      id: randomUUID(),
      revision: next.revision,
      author: item.recipient,
      actorType: 'agent',
      runId: run.id,
      body: body.slice(0, 6000),
      createdAt: next.updatedAt,
    };
    this.store.db
      .prepare('INSERT INTO assistance_replies VALUES(?,?,?)')
      .run(item.id, next.revision, JSON.stringify(reply));
    this.write(next, 'ai_replied', 'tool:claude-code');
  }
  /** Within the same cancellation/revocation transaction. Never confirms process exit. */
  private stopAi(item: AssistanceRecord) {
    if (!item.ai) return;
    const row = this.store.db.prepare('SELECT body FROM runs WHERE id=?').get(item.ai.runId) as
      | { body: string }
      | undefined;
    if (!row) return;
    const run = JSON.parse(row.body) as Run;
    if (isActiveRun(run.state) && run.state !== 'stopping') {
      this.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(
        JSON.stringify({
          ...run,
          state: 'stopping',
          revision: run.revision + 1,
          updatedAt: now(),
        }),
        run.id,
      );
      this.store.db
        .prepare("INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,'run.updated',?,?)")
        .run(item.taskId, now(), item.spaceId);
    }
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
      this.stopAi(item);
      this.write(next, 'access_revoked');
    }
  }
}
