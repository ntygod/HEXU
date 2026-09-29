import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Task } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import type { Handoff } from '../../contracts/src/handoffs.js';
import {
  parseHandoffAcceptance,
  parseHandoffNodeCommand,
  type HandoffAcceptance,
  type HandoffAcceptancePreview,
  type HandoffAcceptanceTicket,
} from '../../contracts/src/handoff-acceptance.js';
import { assertRevision, canonicalJson, isActiveRun } from '../../domain/src/index.js';
import { humanContextHash } from './continuations.js';
import { assertNoPendingHandoff } from './handoff-reservations.js';
import { HandoffStore } from './handoffs.js';
import { CheckpointTransferStore } from './checkpoint-transfer.js';
import type { Store } from './store.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export class HandoffAcceptanceStore {
  readonly handoffs: HandoffStore;
  readonly transfers: CheckpointTransferStore;
  constructor(
    readonly store: Store,
    private clock: () => number = Date.now,
  ) {
    this.handoffs = new HandoffStore(store, clock);
    this.transfers = new CheckpointTransferStore(store, clock);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private row(id: string): HandoffAcceptance {
    const row = this.store.db.prepare('SELECT body FROM handoff_acceptances WHERE id=?').get(id) as
      | { body: string }
      | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '接手操作不存在或不可访问', 404);
    return JSON.parse(row.body) as HandoffAcceptance;
  }
  private recipient(taskId: string, handoffId: string) {
    const task = this.store.getTask(taskId, true),
      h = this.handoffs.record(taskId, handoffId);
    if (h.material.recipient.id !== this.store.actorId)
      throw new DomainError('HANDOFF_RECIPIENT_REQUIRED', '只有原指定接收者可以接受接手', 403);
    return { task, h };
  }
  private material(h: Handoff) {
    const m = h.material,
      v = this.transfers.get(h.taskId, m.checkpointId, m.retentionId, m.transferId);
    if (
      !v.authorized ||
      v.state !== 'received' ||
      !v.receivedAt ||
      v.ticket.requestHash !== m.transferHash ||
      v.ticket.manifest.snapshotHash !== m.snapshotHash ||
      v.ticket.target.ownerId !== h.material.recipient.id ||
      v.ticket.target.id !== m.targetNodeId ||
      v.ticket.source.ownerId !== h.sender.id ||
      m.expiresAt <= this.now()
    )
      throw new DomainError(
        'HANDOFF_MATERIAL_UNAVAILABLE',
        '原材料、期限或双方当前授权已变化',
        409,
      );
  }
  private noWriters(taskId: string) {
    const runs = this.store.runs(taskId).filter((r) => r.purpose !== 'assist');
    const ids = new Set(runs.map((r) => r.id));
    const node = this.store.db
      .prepare("SELECT run_id FROM node_dispatches WHERE task_id=? AND stage!='terminal'")
      .all(taskId) as { run_id: string }[];
    const native = this.store.db
      .prepare(
        'SELECT l.run_id FROM native_workspace_locks l JOIN runs r ON r.id=l.run_id WHERE r.task_id=?',
      )
      .all(taskId) as { run_id: string }[];
    if (
      runs.some((r) => isActiveRun(r.state) || r.observation === 'unknown') ||
      [...node, ...native].some((r) => ids.has(r.run_id))
    )
      throw new DomainError(
        'HANDOFF_WRITER_ACTIVE',
        '任务仍有活动或未确认的代码写入，请先使用原停止/恢复流程核对',
        409,
      );
    for (const table of ['continuation_operations', 'node_continuation_operations'])
      if (
        this.store.db
          .prepare(
            `SELECT 1 FROM ${table} WHERE task_id=? AND state IN ('waiting_for_stop','preparing')`,
          )
          .get(taskId)
      )
        throw new DomainError('CONTINUATION_PENDING', '任务还有待接续安排，请先完成或取消', 409);
  }
  private ready(taskId: string, handoffId: string) {
    const { task, h } = this.recipient(taskId, handoffId);
    if (h.state !== 'offered' || h.expiresAt <= this.now())
      throw new DomainError('HANDOFF_CLOSED', '邀请已经结束或到期', 409);
    this.material(h);
    this.noWriters(taskId);
    return { task, h };
  }
  private current(op: HandoffAcceptance) {
    const t = op.ticket,
      { task, h } = this.ready(t.taskId, t.handoffId);
    if (
      h.revision !== t.handoffRevision ||
      hash(h) !== t.handoffHash ||
      task.revision !== t.taskRevision ||
      task.ownerUserId !== t.ownerUserId ||
      humanContextHash(this.store, task.id) !== t.contextHash ||
      t.expiresAt <= this.now()
    )
      throw new DomainError(
        'HANDOFF_CONTEXT_CHANGED',
        '邀请、任务讨论、负责人或确认期限已改变，请重新核对后发起',
        409,
      );
    return { task, h };
  }
  private event(op: HandoffAcceptance, kind = 'handoff.acceptance_updated') {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(op.ticket.taskId, kind, op.updatedAt, op.ticket.spaceId);
  }
  private save(op: HandoffAcceptance) {
    this.store.db
      .prepare('UPDATE handoff_acceptances SET state=?,body=? WHERE id=?')
      .run(op.state, JSON.stringify(op), op.ticket.id);
    this.event(op);
  }
  private pause(op: HandoffAcceptance, reason: string) {
    const next: HandoffAcceptance = {
      ...op,
      state: 'needs_attention',
      revision: op.revision + 1,
      updatedAt: this.now(),
      reason,
    };
    this.save(next);
    return next;
  }
  private asRecipient<T>(op: HandoffAcceptance, action: () => T): T {
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(op.ticket.recipientId) as IdentityUser | undefined;
    if (!user) throw new DomainError('FORBIDDEN', '原接收成员已不可访问', 403);
    return this.store.as({ user, spaceId: op.ticket.spaceId }, action);
  }
  /** Restart never accepts, restores, spawns or releases an unknown writer. */
  sweep(restarted = false) {
    const rows = this.store.db
      .prepare("SELECT id FROM handoff_acceptances WHERE state='waiting_local' LIMIT 200")
      .all() as { id: string }[];
    if (!rows.length) return;
    this.store.atomic(() => {
      for (const { id } of rows) {
        const op = this.row(id);
        if (op.state !== 'waiting_local') continue;
        if (restarted) {
          this.pause(op, '服务已重启；原确认暂停，请重新核对后发起接手');
          continue;
        }
        try {
          this.asRecipient(op, () => this.current(op));
        } catch (cause) {
          if (!(cause instanceof DomainError)) throw cause;
          this.pause(op, '原邀请、权限、任务或写入状态已变化，请重新核对后发起接手');
        }
      }
    });
  }
  preview(taskId: string, handoffId: string): HandoffAcceptancePreview {
    const { task, h } = this.ready(taskId, handoffId);
    return {
      handoffRevision: h.revision,
      taskRevision: task.revision,
      contextHash: humanContextHash(this.store, taskId),
      taskTitle: task.title,
      taskDescription: task.description,
      ownerUserId: task.ownerUserId,
      transferOwnerRequested: h.transferOwnerRequested === true,
    };
  }
  create(taskId: string, handoffId: string, input: unknown, key: string) {
    const data = parseHandoffAcceptance(input);
    this.recipient(taskId, handoffId);
    this.sweep();
    const receipt = this.store.mutate(`handoff.accept:${handoffId}`, key, data, () => {
      const { task, h } = this.ready(taskId, handoffId);
      assertRevision(h.revision, data.expectedHandoffRevision);
      assertRevision(task.revision, data.expectedTaskRevision);
      if (humanContextHash(this.store, taskId) !== data.contextHash)
        throw new DomainError(
          'HANDOFF_CONTEXT_CHANGED',
          '任务讨论已变化，请核对当前说明再确认',
          409,
        );
      if (data.transferOwner && !h.transferOwnerRequested)
        throw new DomainError('HANDOFF_OWNER_CONSENT_REQUIRED', '原邀请没有提出负责人移交', 409);
      assertNoPendingHandoff(this.store, taskId);
      const count = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM handoff_acceptances WHERE handoff_id=?')
        .get(handoffId) as { n: number };
      if (count.n >= 32)
        throw new DomainError('HANDOFF_LIMIT', '此邀请确认记录已达上限，请保留历史并重新邀请', 409);
      const at = this.now();
      const ticket: HandoffAcceptanceTicket = {
        version: 1,
        id: randomUUID(),
        handoffId,
        handoffRevision: h.revision,
        handoffHash: hash(h),
        taskId,
        taskRevision: task.revision,
        contextHash: data.contextHash,
        projectId: h.projectId,
        spaceId: h.spaceId,
        recipientId: this.store.actorId,
        nodeId: h.material.targetNodeId,
        transferId: h.material.transferId,
        transferHash: h.material.transferHash,
        snapshotHash: h.material.snapshotHash,
        ownerUserId: task.ownerUserId,
        transferOwner: data.transferOwner,
        createdAt: at,
        expiresAt: new Date(
          Math.min(
            Date.parse(at) + 10 * 60000,
            Date.parse(h.expiresAt),
            Date.parse(h.material.expiresAt),
          ),
        ).toISOString(),
        requestHash: '',
      };
      ticket.requestHash = hash(ticket);
      const op: HandoffAcceptance = {
        ticket,
        snapshot: h,
        state: 'waiting_local',
        revision: 1,
        updatedAt: at,
        reason: null,
        proof: null,
        proofHash: null,
        acceptedAt: null,
      };
      this.store.db
        .prepare(
          'INSERT INTO handoff_acceptances(id,handoff_id,task_id,node_id,state,body) VALUES(?,?,?,?,?,?)',
        )
        .run(ticket.id, handoffId, taskId, ticket.nodeId, op.state, JSON.stringify(op));
      this.event(op);
      return { id: ticket.id };
    });
    return this.get(taskId, handoffId, receipt.id);
  }
  get(taskId: string, handoffId: string, id: string) {
    this.handoffs.record(taskId, handoffId);
    this.sweep();
    const op = this.row(id);
    if (op.ticket.taskId !== taskId || op.ticket.handoffId !== handoffId)
      throw new DomainError('NOT_FOUND', '接手操作不属于此邀请', 404);
    return op;
  }
  list(taskId: string, handoffId: string) {
    this.handoffs.record(taskId, handoffId);
    this.sweep();
    return {
      items: (
        this.store.db
          .prepare(
            'SELECT body FROM handoff_acceptances WHERE handoff_id=? ORDER BY rowid DESC LIMIT 32',
          )
          .all(handoffId) as { body: string }[]
      ).map((r) => JSON.parse(r.body) as HandoffAcceptance),
    };
  }
  cancel(taskId: string, handoffId: string, id: string, expectedRevision: number, key: string) {
    this.store.getTask(taskId, true);
    this.get(taskId, handoffId, id);
    this.store.mutate(`handoff.acceptance.cancel:${id}`, key, { expectedRevision }, () => {
      this.store.getTask(taskId, true);
      const op = this.row(id);
      assertRevision(op.revision, expectedRevision);
      if (op.state === 'succeeded')
        throw new DomainError('HANDOFF_ALREADY_ACCEPTED', '接手已经提交，取消不能回滚操作者', 409);
      if (op.state !== 'cancelled')
        this.save({
          ...op,
          state: 'cancelled',
          revision: op.revision + 1,
          updatedAt: this.now(),
          reason: '当前项目编辑者取消了接手确认；没有删除文件或停止进程',
        });
      return { id };
    });
    return this.get(taskId, handoffId, id);
  }
  nodeCommand(token: string, input: unknown): HandoffAcceptance {
    const data = parseHandoffNodeCommand(input);
    const caller = this.transfers.retained.checkpoints.nodes.settlementIdentity(token);
    if (caller.settlementOnly) throw new DomainError('NODE_REVOKED', '原接收节点授权已撤销', 401);
    const checkNode = (op: HandoffAcceptance) => {
      const node = this.transfers.retained.checkpoints.nodes.settlementIdentity(token),
        t = op.ticket;
      if (node.settlementOnly) throw new DomainError('NODE_REVOKED', '原接收节点授权已撤销', 401);
      if (
        node.id !== t.nodeId ||
        node.owner_id !== t.recipientId ||
        node.project_id !== t.projectId ||
        node.space_id !== t.spaceId
      )
        throw new DomainError('NOT_FOUND', '接手操作不属于此接收节点', 404);
    };
    const initial = this.row(data.operationId);
    checkNode(initial);
    // Permission is rechecked even for receipt replay; node Bearer is never a browser principal.
    return this.asRecipient(initial, () => {
      this.recipient(initial.ticket.taskId, initial.ticket.handoffId);
      if (data.action === 'inspect' || data.action === 'workspace-source') {
        this.sweep();
        const current = this.row(data.operationId);
        if (data.action === 'workspace-source') {
          if (current.state !== 'succeeded')
            throw new DomainError('HANDOFF_NOT_ACCEPTED', '接手尚未确认，不能准备研发现场', 409);
          const task = this.store.getTask(current.ticket.taskId, true);
          const last = this.store.db
            .prepare(
              "SELECT id FROM handoff_acceptances WHERE task_id=? AND state='succeeded' ORDER BY rowid DESC LIMIT 1",
            )
            .get(task.id) as { id: string } | undefined;
          if (last?.id !== current.ticket.id || task.operatorUserId !== this.store.actorId)
            throw new DomainError(
              'HANDOFF_CONTEXT_CHANGED',
              '请使用当前操作者最近已接受的接手记录',
              409,
            );
          this.material(current.snapshot);
          this.noWriters(task.id);
          assertNoPendingHandoff(this.store, task.id);
        }
        return current;
      }
      return this.store.atomic(() => {
        const op = this.row(data.operationId),
          t = op.ticket;
        checkNode(op);
        this.recipient(t.taskId, t.handoffId);
        if (data.requestHash !== t.requestHash)
          throw new DomainError('HANDOFF_PACKET_CHANGED', '接手确认不对应原操作', 409);
        if (data.action === 'fail') {
          if (op.state !== 'waiting_local') return op;
          const reasons = {
            files_changed: '本机文件或目录已变化，请核对原恢复现场',
            workspace_busy: '本机现场还有活动或未确认的写入，未接受接手',
            cancelled: '接收者取消了本机核验，未接受接手',
            local_check_failed: '本机现场核验未通过，请在原节点核对后重新发起',
          };
          return this.pause(op, reasons[data.reason]);
        }
        const fingerprint = hash(data);
        if (op.state === 'succeeded') {
          if (op.proofHash !== fingerprint)
            throw new DomainError('HANDOFF_PACKET_CHANGED', '已提交结果只能对账原核验包', 409);
          return op;
        }
        if (op.state !== 'waiting_local') return op;
        let task: Task, h: Handoff;
        try {
          ({ task, h } = this.current(op));
        } catch (cause) {
          if (!(cause instanceof DomainError)) throw cause;
          return this.pause(op, '任务、权限、材料或写入状态已经变化，未接受接手');
        }
        const p = data.proof,
          verified = Date.parse(p.verifiedAt);
        if (p.snapshotHash !== t.snapshotHash || p.files !== h.material.coverage.files)
          throw new DomainError('HANDOFF_PACKET_CHANGED', '本机核验与原固定材料不一致', 409);
        if (
          verified < Date.parse(t.createdAt) ||
          verified > this.clock() + 5000 ||
          verified < this.clock() - 30000
        )
          return this.pause(op, '本机核验已过期或时间异常，请重新发起并核对现场');
        const at = this.now();
        const { participantUserIds: _participants, ...savedTask } = task;
        const next: Task = {
          ...savedTask,
          operatorUserId: t.recipientId,
          operatorName: this.store.actorName(),
          ownerUserId: t.transferOwner ? t.recipientId : task.ownerUserId,
          revision: task.revision + 1,
          updatedAt: at,
        };
        if (t.transferOwner && task.ownerUserId !== t.recipientId) {
          const options = this.store.taskAssignment.options(task.id);
          const to = options.candidates.find((c) => c.id === t.recipientId);
          if (!to) return this.pause(op, '接收者当前不能承担该项目任务，未改变负责人');
          this.store.db
            .prepare(
              `INSERT INTO task_assignment_events
            (task_id,revision,from_user_id,from_name,to_user_id,to_name,actor_id,actor_name,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              task.id,
              next.revision,
              task.ownerUserId,
              options.owner.name,
              t.recipientId,
              to.name,
              this.store.actorId,
              this.store.actorName(),
              at,
            );
          this.event({ ...op, updatedAt: at }, 'task.assignment_changed');
        }
        this.store.db
          .prepare('UPDATE tasks SET body=? WHERE id=? AND space_id=?')
          .run(JSON.stringify(next), task.id, task.spaceId);
        const accepted: Handoff = {
          ...h,
          state: 'accepted',
          revision: h.revision + 1,
          updatedAt: at,
        };
        this.store.db
          .prepare('UPDATE handoffs SET state=?,revision=?,body=? WHERE id=?')
          .run(accepted.state, accepted.revision, JSON.stringify(accepted), h.id);
        this.store.db
          .prepare('INSERT INTO handoff_events(handoff_id,revision,body) VALUES(?,?,?)')
          .run(
            h.id,
            accepted.revision,
            JSON.stringify({
              revision: accepted.revision,
              action: 'accept',
              actor: { id: this.store.actorId, name: this.store.actorName() },
              at,
            }),
          );
        const done: HandoffAcceptance = {
          ...op,
          state: 'succeeded',
          revision: op.revision + 1,
          updatedAt: at,
          proof: p,
          proofHash: fingerprint,
          acceptedAt: at,
          reason: null,
        };
        this.save(done);
        this.event(done, 'handoff.accepted');
        this.event(done, 'task.updated');
        return done;
      });
    });
  }
}
