import { randomUUID } from 'node:crypto';
import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  parseHandoffOffer,
  parseHandoffClose,
  type Handoff,
  type HandoffAction,
  type HandoffEvent,
  type HandoffList,
  type HandoffMaterial,
  type HandoffOptions,
  type HandoffView,
} from '../../contracts/src/handoffs.js';
import { parseTransferTicket } from '../../contracts/src/checkpoint-transfer.js';
import { assertRevision } from '../../domain/src/index.js';
import { closeHandoff } from '../../domain/src/handoffs.js';
import { CheckpointTransferStore } from './checkpoint-transfer.js';
import type { Store } from './store.js';

type Row = { rowid: number; body: string };
const decode = (row: Row) => JSON.parse(row.body) as Handoff;

/** Human invitations scoped to an existing project task. No execution or access grant. */
export class HandoffStore {
  private readonly transfers: CheckpointTransferStore;
  constructor(
    readonly store: Store,
    private clock: () => number = Date.now,
  ) {
    this.transfers = new CheckpointTransferStore(store, clock);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private task(id: string, write = false): Task {
    const task = this.store.getTask(id, write);
    if (!this.store.teamMode || task.visibility !== 'project' || !task.projectId)
      throw new DomainError('HANDOFF_UNAVAILABLE', '接手邀请仅用于真实账号的项目可见任务', 422);
    return task;
  }
  private row(taskId: string, id: string): Handoff {
    const row = this.store.db
      .prepare('SELECT body FROM handoffs WHERE task_id=? AND id=?')
      .get(taskId, id) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '邀请不存在或不属于此任务', 404);
    return decode(row);
  }
  private transfer(taskId: string, id: string) {
    const row = this.store.db
      .prepare('SELECT body FROM checkpoint_transfers WHERE task_id=? AND id=?')
      .get(taskId, id) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '材料不属于当前任务', 404);
    const t = parseTransferTicket(JSON.parse(row.body));
    return this.transfers.get(taskId, t.source.checkpointId, t.source.id, id);
  }
  private material(taskId: string, id: string): HandoffMaterial {
    const v = this.transfer(taskId, id),
      t = v.ticket;
    if (
      v.state !== 'received' ||
      !v.receivedAt ||
      !v.authorized ||
      t.manifest.expiresAt <= this.now()
    )
      throw new DomainError(
        'HANDOFF_MATERIAL_UNAVAILABLE',
        '需对方已确认接收且仍在期限和授权内的固定副本',
        409,
      );
    return {
      transferId: t.id,
      transferHash: t.requestHash,
      checkpointId: t.source.checkpointId,
      retentionId: t.source.id,
      commit: t.manifest.commit,
      snapshotHash: t.manifest.snapshotHash,
      coverage: t.manifest.coverage,
      expiresAt: t.manifest.expiresAt,
      receivedAt: v.receivedAt,
      sourceNodeId: t.source.nodeId,
      targetNodeId: t.target.id,
      targetNodeName: t.target.name,
      recipient: { id: t.target.ownerId, name: t.target.ownerName },
    };
  }
  private author(taskId: string, transferId: string) {
    this.task(taskId, true);
    const v = this.transfer(taskId, transferId);
    if (
      v.ticket.source.ownerId !== this.store.actorId ||
      v.ticket.target.ownerId === this.store.actorId
    )
      throw new DomainError(
        'HANDOFF_AUTHOR_REQUIRED',
        '仅原发送者可向另一位接收者发布接手邀请',
        403,
      );
    if (!v.authorized)
      throw new DomainError('HANDOFF_SCOPE_CHANGED', '原收发双方的任务或节点授权已改变', 409);
    return v;
  }
  private event(h: Handoff, action: HandoffEvent['action'], system = false) {
    const event: HandoffEvent = {
      revision: h.revision,
      action,
      at: h.updatedAt,
      actor: system ? null : { id: this.store.actorId, name: this.store.actorName() },
    };
    this.store.db
      .prepare('INSERT INTO handoff_events(handoff_id,revision,body) VALUES(?,?,?)')
      .run(h.id, event.revision, JSON.stringify(event));
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(h.taskId, `handoff.${action}`, h.updatedAt, h.spaceId);
  }
  private save(h: Handoff) {
    this.store.db
      .prepare('UPDATE handoffs SET state=?,revision=?,body=? WHERE id=?')
      .run(h.state, h.revision, JSON.stringify(h), h.id);
  }
  /** Clock expiry is a durable state transition, independent of request identity. */
  expire() {
    const at = this.now();
    const rows = this.store.db
      .prepare("SELECT body FROM handoffs WHERE state='offered' AND expires_at<=? LIMIT 200")
      .all(at) as Row[];
    if (!rows.length) return;
    this.store.atomic(() => {
      for (const row of rows) {
        const old = decode(row),
          current = this.row(old.taskId, old.id);
        if (current.state !== 'offered' || current.expiresAt > at) continue;
        const h: Handoff = {
          ...current,
          state: 'expired',
          revision: current.revision + 1,
          updatedAt: at,
        };
        this.save(h);
        this.event(h, 'expire', true);
      }
    });
  }
  private view(task: Task, h: Handoff): HandoffView {
    let materialAvailable = false;
    try {
      materialAvailable =
        this.material(task.id, h.material.transferId).transferHash === h.material.transferHash;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
    let editable = false;
    try {
      this.task(task.id, true);
      editable = true;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
    return {
      handoff: h,
      materialAvailable,
      taskChanged: task.revision !== h.taskRevision,
      canReject:
        editable && h.state === 'offered' && h.material.recipient.id === this.store.actorId,
      canWithdraw: editable && h.state === 'offered' && h.sender.id === this.store.actorId,
    };
  }
  options(taskId: string): HandoffOptions {
    const task = this.task(taskId, true);
    const rows = this.store.db
      .prepare(
        "SELECT id FROM checkpoint_transfers WHERE task_id=? AND state='received' ORDER BY rowid DESC LIMIT 200",
      )
      .all(taskId) as { id: string }[];
    return {
      taskRevision: task.revision,
      materials: rows.flatMap(({ id }) => {
        try {
          this.author(taskId, id);
          return [this.material(taskId, id)];
        } catch (error) {
          if (error instanceof DomainError) return [];
          throw error;
        }
      }),
    };
  }
  offer(taskId: string, input: unknown, key: string): HandoffView {
    const data = parseHandoffOffer(input);
    this.author(taskId, data.transferId); // Authority is checked even before a stored receipt.
    this.expire();
    const receipt = this.store.mutate(`handoff.offer:${taskId}`, key, data, () => {
      const v = this.author(taskId, data.transferId),
        task = this.task(taskId, true);
      assertRevision(task.revision, data.expectedTaskRevision);
      const material = this.material(taskId, data.transferId);
      if (v.ticket.requestHash !== data.transferHash)
        throw new DomainError('HANDOFF_MATERIAL_CHANGED', '固定材料已变化，请重新核对', 409);
      if (
        this.store.db
          .prepare("SELECT 1 FROM handoffs WHERE transfer_id=? AND state='offered'")
          .get(data.transferId)
      )
        throw new DomainError(
          'HANDOFF_ALREADY_OFFERED',
          '此副本已有待处理邀请，请先查看原邀请',
          409,
        );
      const count = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM handoffs WHERE task_id=?')
        .get(taskId) as { n: number };
      if (count.n >= 200)
        throw new DomainError('HANDOFF_LIMIT', '此任务的接手邀请已达记录上限', 409);
      const at = this.now();
      const h: Handoff = {
        id: randomUUID(),
        taskId,
        spaceId: task.spaceId,
        projectId: task.projectId!,
        revision: 1,
        state: 'offered',
        sender: { id: this.store.actorId, name: this.store.actorName() },
        material,
        taskRevision: task.revision,
        taskTitle: task.title,
        summary: data.summary,
        remainingWork: data.remainingWork,
        environment: data.environment,
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(
          Math.min(Date.parse(at) + data.hours * 3600000, Date.parse(material.expiresAt)),
        ).toISOString(),
      };
      this.store.db
        .prepare(
          'INSERT INTO handoffs(id,task_id,space_id,transfer_id,sender_id,recipient_id,state,revision,expires_at,body) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          h.id,
          taskId,
          h.spaceId,
          material.transferId,
          h.sender.id,
          material.recipient.id,
          h.state,
          h.revision,
          h.expiresAt,
          JSON.stringify(h),
        );
      this.event(h, 'offer');
      return { id: h.id };
    });
    return this.get(taskId, receipt.id);
  }
  list(taskId: string, cursor: number | null = null): HandoffList {
    const task = this.task(taskId);
    this.expire();
    const rows = this.store.db
      .prepare(
        'SELECT rowid,body FROM handoffs WHERE task_id=? AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT 21',
      )
      .all(taskId, cursor, cursor) as Row[];
    return {
      items: rows.slice(0, 20).map((r) => this.view(task, decode(r))),
      nextCursor: rows.length > 20 ? rows[19]!.rowid : null,
    };
  }
  get(taskId: string, id: string): HandoffView {
    const task = this.task(taskId);
    this.expire();
    return this.view(task, this.row(taskId, id));
  }
  history(taskId: string, id: string) {
    this.get(taskId, id);
    const rows = this.store.db
      .prepare('SELECT body FROM handoff_events WHERE handoff_id=? ORDER BY revision')
      .all(id) as Row[];
    return { items: rows.map((r) => JSON.parse(r.body) as HandoffEvent) };
  }
  close(
    taskId: string,
    id: string,
    action: HandoffAction,
    input: unknown,
    key: string,
  ): HandoffView {
    const data = parseHandoffClose(input);
    const check = () => {
      this.task(taskId, true);
      const h = this.row(taskId, id);
      if ((action === 'reject' ? h.material.recipient.id : h.sender.id) !== this.store.actorId)
        throw new DomainError('HANDOFF_PARTY_REQUIRED', '只有受邀人可拒绝，只有发布者可撤回', 403);
      return h;
    };
    check();
    this.expire();
    this.store.mutate(`handoff.${action}:${id}`, key, data, () => {
      const h = check();
      assertRevision(h.revision, data.expectedRevision);
      const next = {
        ...h,
        state: closeHandoff(h.state, action),
        revision: h.revision + 1,
        updatedAt: this.now(),
      };
      this.save(next);
      this.event(next, action);
      return { id };
    });
    return this.get(taskId, id);
  }
}
