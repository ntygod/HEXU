import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseRestoreResultPacket,
  type RestoreResultReceipt,
  type RestoreResultView,
  type RestoreResultPacket,
} from '../../contracts/src/checkpoint-restore-results.js';
import type { RetentionView } from '../../contracts/src/checkpoint-retention.js';
import { canonicalJson } from '../../domain/src/index.js';
import { assertRestoreResultTransition } from '../../domain/src/checkpoint-restore-results.js';
import { CheckpointRetentionStore } from './checkpoint-retention.js';
import type { Store } from './store.js';
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
interface Row {
  id: string;
  request_id: string;
  task_id: string;
  sequence: number;
  body: string;
  body_hash: string;
  received_at: string;
  cursor: number;
}
export class CheckpointRestoreResultStore {
  readonly retained: CheckpointRetentionStore;
  constructor(
    readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {
    this.retained = new CheckpointRetentionStore(store, clock);
  }
  private view(r: Row, source: RetentionView): RestoreResultView {
    const packet = parseRestoreResultPacket(JSON.parse(r.body));
    const t = source.request;
    return {
      id: r.id,
      requestId: r.request_id,
      taskId: t.taskId,
      checkpointId: t.checkpointId,
      nodeId: t.nodeId,
      workspaceId: t.workspaceId,
      ownerId: t.ownerId,
      commit: t.commit,
      retentionExpiresAt: source.manifest!.expiresAt,
      nodeAuthorized: source.nodeAuthorized,
      sequence: r.sequence,
      report: packet.report,
      resultHash: r.body_hash,
      receivedAt: r.received_at,
    };
  }
  list(taskId: string, checkpointId: string, requestId: string, cursor: number | null) {
    const source = this.retained.get(taskId, checkpointId, requestId);
    const rows = this.store.db
      .prepare(
        'SELECT rowid AS cursor,* FROM checkpoint_restore_results WHERE request_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21',
      )
      .all(requestId, cursor ?? Number.MAX_SAFE_INTEGER) as unknown as Row[];
    return {
      items: rows.slice(0, 20).map((r) => this.view(r, source)),
      nextCursor: rows.length > 20 ? rows[19]!.cursor : null,
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
    const r = this.store.db
      .prepare('SELECT request_id FROM checkpoint_restore_results WHERE id=?')
      .get(id) as { request_id: string } | undefined;
    if (!r || r.request_id !== requestId)
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
  report(token: string, input: unknown): RestoreResultReceipt {
    const p = parseRestoreResultPacket(input);
    return this.store.atomic(() => {
      // Current original owner, task/project visibility and permanent node revision
      // are checked BEFORE receipts. Expiry/deletion does not erase old disk events.
      const source = this.retained.inspect(token, p.requestId),
        t = source.request,
        m = source.manifest;
      if (
        !m ||
        t.requestHash !== p.requestHash ||
        m.snapshotHash !== p.report.snapshotHash ||
        p.report.totalFiles !== m.coverage.files ||
        m.coverage.symlinks ||
        m.coverage.gitlinks ||
        m.coverage.lfsPointers
      )
        throw new DomainError('CHECKPOINT_MISMATCH', '恢复报告不属于原本机保留材料', 409);
      const hash = digest(p);
      const row = this.store.db
        .prepare('SELECT * FROM checkpoint_restore_results WHERE id=?')
        .get(p.restoreId) as unknown as Row | undefined;
      if (row && row.request_id !== p.requestId)
        throw new DomainError('CHECKPOINT_MISMATCH', '恢复身份已绑定另一份材料', 409);
      const old = this.store.db
        .prepare(
          'SELECT body_hash FROM checkpoint_restore_reports WHERE restore_id=? AND sequence=?',
        )
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
        p.report.recordedAt < m.retainedAt ||
        Date.parse(p.report.recordedAt) > this.clock() + 60000 ||
        (p.report.verifiedAt &&
          (p.report.verifiedAt < m.retainedAt || p.report.verifiedAt > m.expiresAt))
      )
        throw new DomainError('RESTORE_REPORT_CONFLICT', '恢复顺序或观察时间无效', 409);
      if (row)
        assertRestoreResultTransition(
          (JSON.parse(row.body) as RestoreResultPacket).report,
          p.report,
        );
      else {
        const n = this.store.db
          .prepare('SELECT COUNT(*) AS n FROM checkpoint_restore_results WHERE request_id=?')
          .get(p.requestId) as { n: number };
        if (n.n >= 128)
          throw new DomainError('RESTORE_REPORT_LIMIT', '此份材料的恢复记录达到上限', 409);
      }
      const receivedAt = new Date(this.clock()).toISOString(),
        body = JSON.stringify(p);
      this.store.db
        .prepare(
          'INSERT INTO checkpoint_restore_results(id,request_id,task_id,sequence,body,body_hash,received_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence,body=excluded.body,body_hash=excluded.body_hash,received_at=excluded.received_at',
        )
        .run(p.restoreId, p.requestId, t.taskId, p.sequence, body, hash, receivedAt);
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
    });
  }
}
