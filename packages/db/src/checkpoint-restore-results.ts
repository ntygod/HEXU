import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseRestoreResultPacket,
  type RestoreResultReceipt,
  type RestoreResultView,
  type RestoreResultPacket,
} from '../../contracts/src/checkpoint-restore-results.js';
import type { RetentionView } from '../../contracts/src/checkpoint-retention.js';
import type { TransferView } from '../../contracts/src/checkpoint-transfer.js';
import { canonicalJson } from '../../domain/src/index.js';
import { assertRestoreResultTransition } from '../../domain/src/checkpoint-restore-results.js';
import { CheckpointRetentionStore } from './checkpoint-retention.js';
import { CheckpointTransferStore } from './checkpoint-transfer.js';
import type { Store } from './store.js';
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
type Source = RetentionView | TransferView;
interface Row {
  id: string;
  request_id: string;
  transfer_id: string | null;
  task_id: string;
  sequence: number;
  body: string;
  body_hash: string;
  received_at: string;
  cursor: number;
}
export class CheckpointRestoreResultStore {
  readonly retained: CheckpointRetentionStore;
  readonly transfers: CheckpointTransferStore;
  constructor(
    readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {
    this.retained = new CheckpointRetentionStore(store, clock);
    this.transfers = new CheckpointTransferStore(store, clock);
  }
  private view(r: Row, source: Source): RestoreResultView {
    const packet = parseRestoreResultPacket(JSON.parse(r.body));
    const transferred = 'ticket' in source ? source.ticket : null;
    const t = 'ticket' in source ? source.ticket.source : source.request;
    const manifest = 'ticket' in source ? source.ticket.manifest : source.manifest!;
    return {
      id: r.id,
      requestId: transferred?.id ?? r.request_id,
      ...(transferred
        ? {
            sourceKind: 'transfer' as const,
            transferId: transferred.id,
            sourceRequestId: t.id,
            sourceNodeId: t.nodeId,
          }
        : {}),
      taskId: t.taskId,
      checkpointId: t.checkpointId,
      nodeId: transferred?.target.id ?? t.nodeId,
      workspaceId: transferred ? null : t.workspaceId,
      ownerId: transferred?.target.ownerId ?? t.ownerId,
      commit: t.commit,
      retentionExpiresAt: manifest.expiresAt,
      nodeAuthorized: 'ticket' in source ? source.authorized : source.nodeAuthorized,
      sequence: r.sequence,
      report: packet.report,
      resultHash: r.body_hash,
      receivedAt: r.received_at,
    };
  }
  private page(
    source: Source,
    requestId: string,
    transferId: string | null,
    cursor: number | null,
  ) {
    const rows = this.store.db
      .prepare(
        'SELECT rowid AS cursor,* FROM checkpoint_restore_results WHERE request_id=? AND transfer_id IS ? AND rowid<? ORDER BY rowid DESC LIMIT 21',
      )
      .all(requestId, transferId, cursor ?? Number.MAX_SAFE_INTEGER) as unknown as Row[];
    return {
      items: rows.slice(0, 20).map((r) => this.view(r, source)),
      nextCursor: rows.length > 20 ? rows[19]!.cursor : null,
    };
  }
  list(taskId: string, checkpointId: string, requestId: string, cursor: number | null) {
    return this.page(this.retained.get(taskId, checkpointId, requestId), requestId, null, cursor);
  }
  listTransfer(
    taskId: string,
    checkpointId: string,
    requestId: string,
    transferId: string,
    cursor: number | null,
  ) {
    return this.page(
      this.transfers.get(taskId, checkpointId, requestId, transferId),
      requestId,
      transferId,
      cursor,
    );
  }
  private reportHistory(
    requestId: string,
    transferId: string | null,
    id: string,
    cursor: number | null,
  ) {
    const r = this.store.db
      .prepare('SELECT request_id,transfer_id FROM checkpoint_restore_results WHERE id=?')
      .get(id) as { request_id: string; transfer_id: string | null } | undefined;
    if (!r || r.request_id !== requestId || r.transfer_id !== transferId)
      throw new DomainError('NOT_FOUND', '恢复记录不存在或不可访问', 404);
    const rows = this.store.db
      .prepare(
        'SELECT sequence,body,body_hash,received_at FROM checkpoint_restore_reports WHERE restore_id=? AND sequence<? ORDER BY sequence DESC LIMIT 21',
      )
      .all(id, cursor ?? Number.MAX_SAFE_INTEGER) as unknown as Row[];
    return {
      items: rows.slice(0, 20).map((r) => ({
        sequence: r.sequence,
        resultHash: r.body_hash,
        report: parseRestoreResultPacket(JSON.parse(r.body)).report,
        receivedAt: r.received_at,
      })),
      nextCursor: rows.length > 20 ? rows[19]!.sequence : null,
    };
  }
  history(
    taskId: string,
    checkpointId: string,
    requestId: string,
    id: string,
    cursor: number | null,
  ) {
    this.retained.get(taskId, checkpointId, requestId);
    return this.reportHistory(requestId, null, id, cursor);
  }
  historyTransfer(
    taskId: string,
    checkpointId: string,
    requestId: string,
    transferId: string,
    id: string,
    cursor: number | null,
  ) {
    this.transfers.get(taskId, checkpointId, requestId, transferId);
    return this.reportHistory(requestId, transferId, id, cursor);
  }
  report(token: string, input: unknown): RestoreResultReceipt {
    const p = parseRestoreResultPacket(input);
    if (p.sourceKind) throw new DomainError('INVALID_INPUT', '接收恢复报告不能冒充原保留恢复');
    return this.store.atomic(() => this.save(p, this.retained.inspect(token, p.requestId)));
  }
  reportTransfer(token: string, input: unknown): RestoreResultReceipt {
    const p = parseRestoreResultPacket(input);
    if (p.sourceKind !== 'transfer') throw new DomainError('INVALID_INPUT', '需明确接收传输来源');
    return this.store.atomic(() =>
      this.save(p, this.transfers.inspectReceived(token, p.requestId)),
    );
  }
  /** Both source resolvers run in the same transaction BEFORE old receipt lookup.
   * One result/report/outbox system, with a real transfer FK rather than forged retention. */
  private save(p: RestoreResultPacket, source: Source): RestoreResultReceipt {
    const transferred = 'ticket' in source ? source.ticket : null;
    const t = 'ticket' in source ? source.ticket.source : source.request;
    const m = 'ticket' in source ? source.ticket.manifest : source.manifest;
    const earliest = 'ticket' in source ? source.receivedAt! : m?.retainedAt;
    if (
      !m ||
      (transferred?.requestHash ?? t.requestHash) !== p.requestHash ||
      m.snapshotHash !== p.report.snapshotHash ||
      p.report.totalFiles !== m.coverage.files ||
      m.coverage.symlinks ||
      m.coverage.gitlinks ||
      m.coverage.lfsPointers
    )
      throw new DomainError('CHECKPOINT_MISMATCH', '恢复报告不属于原材料或接收来源', 409);
    const hash = digest(p),
      transferId = transferred?.id ?? null;
    const row = this.store.db
      .prepare('SELECT * FROM checkpoint_restore_results WHERE id=?')
      .get(p.restoreId) as unknown as Row | undefined;
    if (row && (row.request_id !== t.id || row.transfer_id !== transferId))
      throw new DomainError('CHECKPOINT_MISMATCH', '恢复身份已绑定另一份材料或接收节点', 409);
    const old = this.store.db
      .prepare('SELECT body_hash FROM checkpoint_restore_reports WHERE restore_id=? AND sequence=?')
      .get(p.restoreId, p.sequence) as { body_hash: string } | undefined;
    if (old) {
      if (old.body_hash !== hash)
        throw new DomainError('RESTORE_REPORT_CONFLICT', '同序号不能替换恢复报告', 409);
      return {
        restoreId: p.restoreId,
        requestId: p.requestId,
        acceptedSequence: p.sequence,
        acceptedHash: hash,
        latest: this.view(row!, source),
      };
    }
    if (
      p.sequence !== (row?.sequence ?? 0) + 1 ||
      p.report.recordedAt < earliest! ||
      Date.parse(p.report.recordedAt) > this.clock() + 60000 ||
      (p.report.verifiedAt &&
        (p.report.verifiedAt < earliest! || p.report.verifiedAt > m.expiresAt))
    )
      throw new DomainError('RESTORE_REPORT_CONFLICT', '恢复顺序或观察时间无效', 409);
    if (row)
      assertRestoreResultTransition(
        parseRestoreResultPacket(JSON.parse(row.body)).report,
        p.report,
      );
    else {
      const n = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM checkpoint_restore_results WHERE request_id=?')
        .get(t.id) as { n: number };
      if (n.n >= 128)
        throw new DomainError('RESTORE_REPORT_LIMIT', '此份材料的恢复记录达到上限', 409);
    }
    const receivedAt = new Date(this.clock()).toISOString(),
      body = JSON.stringify(p);
    this.store.db
      .prepare(
        'INSERT INTO checkpoint_restore_results(id,request_id,transfer_id,task_id,sequence,body,body_hash,received_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence,body=excluded.body,body_hash=excluded.body_hash,received_at=excluded.received_at',
      )
      .run(p.restoreId, t.id, transferId, t.taskId, p.sequence, body, hash, receivedAt);
    this.store.db
      .prepare('INSERT INTO checkpoint_restore_reports VALUES(?,?,?,?,?)')
      .run(p.restoreId, p.sequence, hash, body, receivedAt);
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(t.taskId, 'checkpoint.restore.reported', receivedAt, t.spaceId);
    const saved = this.store.db
      .prepare('SELECT * FROM checkpoint_restore_results WHERE id=?')
      .get(p.restoreId) as unknown as Row;
    return {
      restoreId: p.restoreId,
      requestId: p.requestId,
      acceptedSequence: p.sequence,
      acceptedHash: hash,
      latest: this.view(saved, source),
    };
  }
}
