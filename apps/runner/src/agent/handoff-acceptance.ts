import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, revision } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { checkpointHash } from '../../../../packages/contracts/src/checkpoints.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import {
  parseHandoffNodeCommand,
  type HandoffAcceptance,
} from '../../../../packages/contracts/src/handoff-acceptance.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import { withReceivedRestoreSource } from './checkpoint-received-source.js';
import { rebuildPublishedRestorePlan } from './checkpoint-restore-plan.js';
import {
  RestoreJournal,
  readRestoreProgress,
  restoreProgressFromRow,
  type RestorePlan,
} from './checkpoint-restore-journal.js';
import { PinnedRestoreParent } from './checkpoint-restore-files.js';
import { verifyRestoreFiles } from './checkpoint-restore.js';
import { WorkspaceLease } from '../workspace-lease.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
interface Row {
  id: string;
  binding: string;
  target: string;
  request_hash: string;
  workspace_ref: string;
  phase: 'verifying' | 'pending' | 'settled' | 'failed';
  packet: string | null;
  outcome: string | null;
}
function validate(op: HandoffAcceptance, id: string) {
  if (
    !op ||
    typeof op !== 'object' ||
    JSON.stringify(op).length > 60000 ||
    !op.ticket ||
    !op.snapshot
  )
    throw new DomainError('INVALID_RESPONSE', '接手服务返回不受支持的记录');
  const t = op.ticket;
  for (const v of [
    t.id,
    t.handoffId,
    t.taskId,
    t.projectId,
    t.spaceId,
    t.recipientId,
    t.nodeId,
    t.transferId,
    t.ownerUserId,
  ])
    nodeId(v);
  for (const v of [t.handoffHash, t.contextHash, t.transferHash, t.snapshotHash, t.requestHash])
    checkpointHash(v);
  retentionDate(t.createdAt);
  retentionDate(t.expiresAt);
  revision(t.handoffRevision);
  revision(t.taskRevision);
  revision(op.revision);
  if (
    t.version !== 1 ||
    t.id !== id ||
    typeof t.transferOwner !== 'boolean' ||
    hash({ ...t, requestHash: '' }) !== t.requestHash ||
    hash(op.snapshot) !== t.handoffHash ||
    op.snapshot.id !== t.handoffId ||
    op.snapshot.taskId !== t.taskId ||
    op.snapshot.material.transferId !== t.transferId ||
    op.snapshot.material.targetNodeId !== t.nodeId ||
    op.snapshot.material.recipient.id !== t.recipientId ||
    !['waiting_local', 'needs_attention', 'succeeded', 'cancelled'].includes(op.state)
  )
    throw new DomainError('INVALID_RESPONSE', '接手操作、固定材料或记录指纹不一致');
  return op;
}

/** Existing pending evidence blocks deleting/re-pairing its credentials. Read-only:
 * never create a journal merely to check whether it is empty. */
export function assertHandoffEvidenceSettled(home: string) {
  const path = join(home, 'handoff-acceptances', 'journal.sqlite');
  if (!existsSync(path)) return;
  restorePrivatePath(join(home, 'handoff-acceptances'), true);
  restorePrivatePath(path, false);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_confirmations'")
        .get() &&
      db.prepare("SELECT 1 FROM handoff_confirmations WHERE phase IN ('verifying','pending')").get()
    )
      throw new DomainError(
        'HANDOFF_UNSETTLED',
        '接手确认或回执尚未处置，请保留原凭证并对账，不能重新配对绕过',
        409,
      );
  } finally {
    db.close();
  }
}

/** The caller supplies a local path, never the browser/control host. Only the
 * receiver's unchanged, already-published ordinary files can support acceptance.
 * No restored-file changes, Git commands, path registration or model launch. */
export async function acceptLocalHandoff(
  home: string,
  id: string,
  target: string,
  ask: (prompt: string) => Promise<string>,
  options: { signal?: AbortSignal; log?: (text: string) => void } = {},
): Promise<HandoffAcceptance> {
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '本机接手确认目前仅支持 Linux');
  nodeId(id);
  if (!isAbsolute(target) || resolve(target) !== target)
    throw new DomainError('INVALID_INPUT', '目标需为本机原恢复记录的完整绝对路径');
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  if (!c.nodeId) throw new DomainError('NOT_PAIRED', '请使用原接收节点的配对身份');
  const stillBound = () => {
    if (options.signal?.aborted)
      throw new DomainError('HANDOFF_CANCELLED', '本机确认已取消，没有启动模型');
    if (
      restorePrivatePath(home, true) !== homeIdentity ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原本机身份已变化，未继续确认');
  };
  const inspect = async () => {
    stillBound();
    const op = validate(
      await nodeRequest<HandoffAcceptance>(
        c.controlUrl,
        'handoff-acceptance',
        { action: 'inspect', operationId: id },
        c.nodeToken,
        options.signal,
      ),
      id,
    );
    if (
      op.ticket.nodeId !== c.nodeId ||
      op.ticket.projectId !== c.projectId ||
      op.ticket.spaceId !== c.spaceId
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '邀请不是此接收节点的原绑定');
    stillBound();
    return op;
  };
  const op = await inspect();
  const storage = new AgentStorage(join(home, 'handoff-acceptances'));
  let lease: WorkspaceLease | undefined;
  let tableReady = false;
  try {
    storage.db.exec(`CREATE TABLE IF NOT EXISTS handoff_confirmations(
      id TEXT PRIMARY KEY,binding TEXT NOT NULL,target TEXT NOT NULL,request_hash TEXT NOT NULL,
      workspace_ref TEXT NOT NULL,phase TEXT NOT NULL,packet TEXT,outcome TEXT);`);
    tableReady = true;
    const row = storage.db
      .prepare('SELECT * FROM handoff_confirmations WHERE id=?')
      .get(id) as unknown as Row | undefined;
    if (
      row &&
      (row.binding !== binding ||
        row.target !== target ||
        row.request_hash !== op.ticket.requestHash)
    )
      throw new DomainError(
        'CHECKPOINT_SCOPE_CHANGED',
        '原确认的身份、目标或固定请求已变化，未重写记录',
      );
    const settle = async (packet: ReturnType<typeof parseHandoffNodeCommand>) => {
      stillBound();
      const result = validate(
        await nodeRequest<HandoffAcceptance>(
          c.controlUrl,
          'handoff-acceptance',
          packet,
          c.nodeToken,
          options.signal,
        ),
        id,
      );
      if (
        result.ticket.requestHash !== op.ticket.requestHash ||
        (result.state === 'succeeded' && result.proofHash !== hash(packet))
      )
        throw new DomainError('ACK_MISMATCH', '回复不对应原接手核验包，保留记录');
      if (result.state === 'waiting_local')
        throw new DomainError('ACK_MISMATCH', '提交没有给出明确结果，保留原包');
      storage.db
        .prepare("UPDATE handoff_confirmations SET phase='settled',outcome=? WHERE id=?")
        .run(JSON.stringify(result), id);
      return result;
    };
    const claimId = `handoff-accept:${id}`;
    if (row?.packet) {
      // Recover only this verifier's namespaced reservation. A later, different
      // writer must never be removed merely to acknowledge a historical result.
      try {
        if (op.state === 'waiting_local') {
          try {
            lease = new WorkspaceLease(target, claimId);
          } catch (cause) {
            if (!(cause instanceof DomainError) || cause.code !== 'LOCAL_WORKSPACE_BUSY')
              throw cause;
            lease = new WorkspaceLease(target, claimId, true);
          }
        } else lease = new WorkspaceLease(target, claimId, true);
      } catch (cause) {
        if (op.state === 'waiting_local') throw cause;
      }
      return await settle(parseHandoffNodeCommand(JSON.parse(row.packet))); // exact receipt; no new file content or consent
    }
    if (op.state !== 'waiting_local') {
      if (row)
        storage.db
          .prepare("UPDATE handoff_confirmations SET phase='settled',outcome=? WHERE id=?")
          .run(JSON.stringify(op), id);
      return op;
    }
    if (op.ticket.expiresAt <= new Date().toISOString())
      throw new DomainError('HANDOFF_EXPIRED', '接手确认已到期');
    const initial = readRestoreProgress(home, target);
    if (
      !initial ||
      initial.state !== 'restored' ||
      initial.materialState !== 'published' ||
      initial.sourceKind !== 'transfer' ||
      initial.transferId !== op.ticket.transferId ||
      !initial.stageIdentity
    )
      throw new DomainError(
        'HANDOFF_RESTORE_REQUIRED',
        '目标需有此接收副本的成功发布记录；不会自动恢复或采用未知现场',
      );
    const log = options.log ?? console.log;
    log(
      JSON.stringify({
        task: op.snapshot.taskTitle,
        summary: op.snapshot.summary,
        remainingWork: op.snapshot.remainingWork,
        environment: op.snapshot.environment,
        commit: op.snapshot.material.commit,
        localTarget: target,
        transferOwner: op.ticket.transferOwner,
        startsModel: false,
      }),
    );
    if ((await ask(`输入 ACCEPT ${id}，核对本机文件并接受以上工作：`)) !== `ACCEPT ${id}`)
      throw new DomainError('HANDOFF_CANCELLED', '未确认接受，没有改变任务或文件');
    const fresh = await inspect();
    if (fresh.ticket.requestHash !== op.ticket.requestHash)
      throw new DomainError('ACK_MISMATCH', '原接手请求指纹改变');
    if (fresh.state !== 'waiting_local') {
      if (row)
        storage.db
          .prepare("UPDATE handoff_confirmations SET phase='settled',outcome=? WHERE id=?")
          .run(JSON.stringify(fresh), id);
      return fresh;
    }
    if (!row) {
      const count = storage.db.prepare('SELECT COUNT(*) AS n FROM handoff_confirmations').get() as {
        n: number;
      };
      if (count.n >= 1000)
        throw new DomainError('HANDOFF_LIMIT', '本机接手记录已达上限，请保留证据后维护');
      storage.db
        .prepare('INSERT INTO handoff_confirmations VALUES(?,?,?,?,?,?,NULL,NULL)')
        .run(id, binding, target, op.ticket.requestHash, randomUUID(), 'verifying');
    } else
      storage.db.prepare("UPDATE handoff_confirmations SET phase='verifying' WHERE id=?").run(id);
    // This namespaced reservation belongs only to this read-only verifier. Taking
    // its exclusive journal guard proves the previous verifier has exited. A
    // different/unknown model writer is never recovered, removed or signalled.
    try {
      lease = new WorkspaceLease(target, claimId);
    } catch (cause) {
      if (!row || !(cause instanceof DomainError) || cause.code !== 'LOCAL_WORKSPACE_BUSY')
        throw cause;
      lease = new WorkspaceLease(target, claimId, true);
    }
    const journal = new RestoreJournal(home);
    try {
      const saved = journal.row(target);
      if (!saved || saved.binding !== binding)
        throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '恢复日志不属于原接收身份');
      const p = restoreProgressFromRow(saved),
        plan = JSON.parse(saved.plan) as RestorePlan;
      const { planHash, observedAt: _observed, ...content } = plan;
      if (
        hash(content) !== planHash ||
        p.id !== initial.id ||
        p.state !== 'restored' ||
        p.materialState !== 'published' ||
        p.sourceKind !== 'transfer' ||
        p.transferId !== op.ticket.transferId ||
        p.requestId !== op.ticket.transferId ||
        plan.source.requestId !== p.requestId ||
        plan.source.nodeId !== c.nodeId ||
        p.completedFiles !== plan.entries.filter((e) => e.kind === 'file').length ||
        p.totalFiles !== p.completedFiles ||
        p.writtenBytes !== plan.materializedBytes ||
        p.totalBytes !== p.writtenBytes ||
        !p.stageIdentity ||
        p.cleanup !== 'not_needed' ||
        plan.target.path !== target ||
        plan.source.kind !== 'transfer'
      )
        throw new DomainError(
          'RESTORE_JOURNAL_INVALID',
          '原恢复、来源或计划已变化，不能凭历史状态接受',
        );
      return await withReceivedRestoreSource(
        home,
        op.ticket.transferId,
        options.signal,
        async (source) => {
          if (
            source.planSource.transfer?.source.taskId !== op.ticket.taskId ||
            source.planSource.transfer.requestHash !== op.ticket.transferHash ||
            source.manifest.snapshotHash !== op.ticket.snapshotHash
          )
            throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '本机副本与原邀请不一致');
          const current = await source.snapshot((read) =>
            rebuildPublishedRestorePlan(
              source.planSource,
              read,
              target,
              source.protectedPaths,
              p.stageIdentity!,
              options.signal,
            ),
          );
          if (current.planHash !== plan.planHash)
            throw new DomainError('RESTORE_PLAN_CHANGED', '持久对象或原目标绑定已改变');
          const parent = new PinnedRestoreParent(current.target, source.protectedIdentities);
          let root: number | undefined;
          try {
            root = parent.openStage(basename(target), p.stageIdentity!);
            verifyRestoreFiles(root, current, journal, p);
            const latest = await inspect();
            if (latest.state !== 'waiting_local') {
              storage.db
                .prepare("UPDATE handoff_confirmations SET phase='settled',outcome=? WHERE id=?")
                .run(JSON.stringify(latest), id);
              return latest;
            }
            await source.authorized();
            source.stillBound();
            stillBound();
            parent.revalidate();
            verifyRestoreFiles(root, current, journal, p);
            const local = storage.db
              .prepare('SELECT workspace_ref FROM handoff_confirmations WHERE id=?')
              .get(id) as { workspace_ref: string };
            const packet = parseHandoffNodeCommand({
              action: 'commit',
              operationId: id,
              requestHash: op.ticket.requestHash,
              proof: {
                restoreId: p.id,
                planHash,
                snapshotHash: source.manifest.snapshotHash,
                workspaceRef: local.workspace_ref,
                verifiedAt: new Date().toISOString(),
                files: current.entries.filter((e) => e.kind === 'file').length,
                bytes: current.materializedBytes,
              },
            });
            storage.db
              .prepare("UPDATE handoff_confirmations SET phase='pending',packet=? WHERE id=?")
              .run(JSON.stringify(packet), id); // FULL sync before sending; never re-hash/reconfirm an uncertain packet.
            return await settle(packet);
          } finally {
            if (root !== undefined) closeSync(root);
            parent.close();
          }
        },
      );
    } finally {
      journal.close();
    }
  } catch (cause) {
    try {
      const row = storage.db
        .prepare('SELECT phase,packet FROM handoff_confirmations WHERE id=?')
        .get(id) as Pick<Row, 'phase' | 'packet'> | undefined;
      if (row && !row.packet) {
        storage.db.prepare("UPDATE handoff_confirmations SET phase='failed' WHERE id=?").run(id);
        // A bounded failure is different from an uncertain commit: never send it
        // once a fixed proof packet may already have reached the server.
        const code = cause instanceof DomainError ? cause.code : '';
        const reason =
          code === 'LOCAL_WORKSPACE_BUSY'
            ? 'workspace_busy'
            : code.includes('CANCELLED')
              ? 'cancelled'
              : code.includes('FILES_CHANGED') || code.includes('PLAN_CHANGED')
                ? 'files_changed'
                : 'local_check_failed';
        await nodeRequest(
          c.controlUrl,
          'handoff-acceptance',
          { action: 'fail', operationId: id, requestHash: op.ticket.requestHash, reason },
          c.nodeToken,
        );
      }
    } catch {
      /* Keep the original diagnostic and durable evidence on transport/storage failure. */
    }
    throw cause;
  } finally {
    // Preserve the read reservation with an uncertain packet. This never alters
    // an unrelated or unknown process writer; only an exact receipt settles it.
    let keepReservation = true;
    try {
      keepReservation =
        tableReady &&
        !!storage.db
          .prepare("SELECT 1 FROM handoff_confirmations WHERE id=? AND phase='pending'")
          .get(id);
    } finally {
      try {
        if (keepReservation) lease?.close();
        else lease?.release();
      } finally {
        storage.close();
      }
    }
  }
}
