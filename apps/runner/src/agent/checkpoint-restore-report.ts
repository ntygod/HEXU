import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  parseRestoreResult,
  parseRestoreResultPacket,
  type RestoreResultPacket,
  type RestoreResultReceipt,
} from '../../../../packages/contracts/src/checkpoint-restore-results.js';
import type { RetentionView } from '../../../../packages/contracts/src/checkpoint-retention.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { nodeRequest } from './connection.js';
import { readCredentials } from './storage.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import {
  RestoreJournal,
  readRestoreProgress,
  restoreProgressFromRow,
  type RestorePlan,
} from './checkpoint-restore-journal.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
};
interface Delivery {
  sequence: number;
  last_packet: string | null;
  pending: string | null;
}

/** Explicit publication of historical metadata, not another restore or filesystem probe.
 * A lost receipt freezes the complete packet before transport. New local changes
 * are reported only by a later invocation, never mixed into a pending retry. */
export async function reportRestoreCheckpoint(
  home: string,
  target: string,
  ask: (prompt: string) => Promise<string>,
  log: (message: string) => void = console.log,
) {
  home = resolve(home);
  const initial = readRestoreProgress(home, target);
  if (!initial)
    throw new DomainError('RESTORE_NOT_AVAILABLE', '没有原本机恢复记录，未创建报告或目录');
  const c = readCredentials(home),
    binding = restoreBinding(c);
  if (!c.nodeId) throw new DomainError('NOT_PAIRED', '节点尚未配对');
  if (c.directories.some((w) => [w.root, w.gitDir].some((p) => inside(p, home) || inside(home, p))))
    throw new DomainError('RESTORE_TARGET_OVERLAP', '本机状态与原来源重叠，不能写入报告');
  const paths = [
    home,
    join(home, 'checkpoint-restores'),
    join(home, 'checkpoint-restores', 'journal.sqlite'),
  ];
  const identities = paths.map((p, i) => restorePrivatePath(p, i < 2));
  const stillBound = () => {
    if (
      restoreBinding(readCredentials(home)) !== binding ||
      paths.some((p, i) => restorePrivatePath(p, i < 2) !== identities[i])
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原身份或日志位置已变化，未继续发布');
  };
  // The existing process guard prevents reporting a live writer as interrupted.
  // Its ordinary restart reconciliation never performs file I/O or signals a PID.
  const journal = new RestoreJournal(home),
    db = journal.storage.db;
  try {
    stillBound();
    const row = journal.row(target);
    if (!row || row.binding !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '报告不属于原本机身份');
    const plan = JSON.parse(row.plan) as RestorePlan;
    const { planHash, observedAt: _observedAt, ...content } = plan;
    const p = restoreProgressFromRow(row);
    if (
      hash(content) !== planHash ||
      plan.target.path !== target ||
      plan.source.requestId !== p.requestId ||
      plan.source.nodeId !== c.nodeId ||
      p.totalFiles !== plan.entries.filter((e) => e.kind === 'file').length ||
      p.totalBytes !== plan.materializedBytes
    )
      throw new DomainError('RESTORE_JOURNAL_INVALID', '原计划或进度绑定损坏，不能猜测恢复结果');
    const summary = parseRestoreResult({
      version: 1,
      kind: 'local_restore_observation',
      planHash,
      snapshotHash: plan.source.manifest.snapshotHash,
      state: p.state,
      materialState: p.materialState,
      cleanup: p.cleanup,
      completedFiles: p.completedFiles,
      writtenBytes: p.writtenBytes,
      totalFiles: p.totalFiles,
      totalBytes: p.totalBytes,
      verifiedAt: p.verifiedAt ?? null,
      recordedAt: p.updatedAt,
    });
    const inspect = async () => {
      stillBound();
      const v = await nodeRequest<RetentionView>(
        c.controlUrl,
        'checkpoint-retention-inspect',
        { requestId: p.requestId },
        c.nodeToken,
      );
      stillBound();
      if (
        !v.nodeAuthorized ||
        v.request.id !== p.requestId ||
        v.request.nodeId !== c.nodeId ||
        v.request.projectId !== c.projectId ||
        v.request.spaceId !== c.spaceId ||
        v.request.checkpointId !== plan.source.checkpointId ||
        v.request.workspaceId !== plan.source.workspaceId ||
        !c.directories.some((w) => w.id === v.request.workspaceId) ||
        canonicalJson(v.manifest) !== canonicalJson(plan.source.manifest)
      )
        throw new DomainError('CHECKPOINT_MISMATCH', '当前原任务、节点或材料与本机记录不一致');
      return v;
    };
    const source = await inspect();
    db.exec(
      'CREATE TABLE IF NOT EXISTS restore_result_delivery(id TEXT PRIMARY KEY REFERENCES restores(id),sequence INTEGER NOT NULL,last_packet TEXT,pending TEXT)',
    );
    const delivery = db
      .prepare('SELECT * FROM restore_result_delivery WHERE id=?')
      .get(p.id) as unknown as Delivery | undefined;
    let packet: RestoreResultPacket;
    if (delivery?.pending) {
      packet = parseRestoreResultPacket(JSON.parse(delivery.pending));
      log('只确认上次固定报告；不会读取恢复目录、重新写入或把后续清理混入旧回执。');
    } else if (
      delivery?.last_packet &&
      canonicalJson(parseRestoreResultPacket(JSON.parse(delivery.last_packet)).report) ===
        canonicalJson(summary)
    ) {
      packet = parseRestoreResultPacket(JSON.parse(delivery.last_packet));
      log('本机记录未变化，仅核对原回执，不增加报告序号。');
    } else {
      log(`恢复记录 ${p.id} · 状态 ${p.state} · 材料 ${p.materialState} · 清理 ${p.cleanup}`);
      log(
        '仅发布原任务可见的来源、指纹、数量和最后记录时间；不上传路径、文件名、字节或凭证，不授予执行权。',
      );
      if ((await ask(`输入 REPORT ${p.id}：`)) !== `REPORT ${p.id}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '未确认报告；原恢复文件和进度不变');
      await inspect();
      packet = parseRestoreResultPacket({
        requestId: p.requestId,
        requestHash: source.request.requestHash,
        restoreId: p.id,
        sequence: (delivery?.sequence ?? 0) + 1,
        report: summary,
        confirmPublication: true,
      });
      // FULL synchronous connection. One immutable pending packet per restore;
      // delivery failure cannot overwrite it with a newer local observation.
      db.prepare(
        'INSERT INTO restore_result_delivery VALUES(?,0,NULL,?) ON CONFLICT(id) DO UPDATE SET pending=excluded.pending',
      ).run(p.id, JSON.stringify(packet));
    }
    if (
      packet.restoreId !== p.id ||
      packet.requestId !== p.requestId ||
      packet.requestHash !== source.request.requestHash ||
      packet.report.planHash !== planHash ||
      packet.report.snapshotHash !== summary.snapshotHash ||
      (delivery?.pending && packet.sequence !== delivery.sequence + 1)
    )
      throw new DomainError(
        'RESTORE_JOURNAL_INVALID',
        '待确认报告与原绑定或序号不一致，已保留证据',
      );
    stillBound();
    const receipt = await nodeRequest<RestoreResultReceipt>(
      c.controlUrl,
      'checkpoint-restore-report',
      packet,
      c.nodeToken,
    );
    stillBound();
    if (
      receipt.restoreId !== p.id ||
      receipt.requestId !== p.requestId ||
      receipt.acceptedSequence !== packet.sequence ||
      receipt.acceptedHash !== hash(packet) ||
      receipt.latest?.id !== p.id ||
      receipt.latest.requestId !== p.requestId ||
      !Number.isSafeInteger(receipt.latest.sequence) ||
      receipt.latest.sequence < packet.sequence
    )
      throw new DomainError('RESTORE_RECEIPT_MISMATCH', '未确认同一恢复报告，原待发结果仍保留');
    const latestReport = parseRestoreResult(receipt.latest.report);
    if (
      receipt.latest.nodeId !== c.nodeId ||
      receipt.latest.taskId !== source.request.taskId ||
      receipt.latest.checkpointId !== plan.source.checkpointId ||
      latestReport.planHash !== planHash ||
      latestReport.snapshotHash !== summary.snapshotHash
    )
      throw new DomainError('RESTORE_RECEIPT_MISMATCH', '回执的最新投影不属于原材料，原报告仍保留');
    db.prepare(
      'UPDATE restore_result_delivery SET sequence=?,last_packet=?,pending=NULL WHERE id=?',
    ).run(packet.sequence, JSON.stringify(packet), p.id);
    const localChangesPending = canonicalJson(packet.report) !== canonicalJson(summary);
    if (localChangesPending) log('旧报告已确认；本机存在后续变化，再次明确报告才发送新观察。');
    return {
      publication: 'confirmed' as const,
      receipt,
      localChangesPending,
      currentFilesVerified: false as const,
      modelExecutionAuthorized: false as const,
    };
  } finally {
    journal.close();
  }
}
