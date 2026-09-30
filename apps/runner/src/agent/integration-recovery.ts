import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import type { IntegrationView } from '../../../../packages/contracts/src/integrations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import { parseLocalApplicationRecord } from './integration-application-record.js';
import {
  freezeIntegrationRecoveryContext,
  originalApplicationEvidenceHash,
  validateRecoveryContextBinding,
} from './integration-recovery-context.js';
import {
  parseRecoveryAcknowledgement,
  readLocalIntegrationRecovery,
  recoveryReport,
  saveLocalIntegrationRecovery,
  type LocalIntegrationRecovery,
} from './integration-recovery-journal.js';
import { releaseWorkspaceClaim, workspaceReleaseReceipt } from '../workspace-lease.js';
import { terminalLabel } from './terminal-label.js';

const inside = (parent: string, child: string) => {
  const p = relative(parent, child);
  return !p || (!isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep));
};

/** Preserve every current file and every original application observation.
 * Operator confirmation settles only the original writer claim. No model, Git,
 * helper, original application replay, output inspection or deletion is used. */
export async function recoverIntegration(
  home: string,
  integrationId: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
) {
  nodeId(integrationId);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '整合本机结算目前仅支持 Linux 普通 Git 目录');
  home = resolve(home);
  const directory = join(home, 'integration-application');
  const paths = [
    home,
    directory,
    join(directory, 'journal.sqlite'),
    join(home, 'credentials.json'),
  ];
  const identities = paths.map((p, i) => restorePrivatePath(p, i < 2));
  const credentials = readCredentials(home),
    binding = restoreBinding(credentials);
  if (
    !credentials.nodeId ||
    credentials.directories
      .flatMap((w) => [w.root, w.gitDir])
      .some((p) => inside(home, p) || inside(p, home))
  )
    throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原节点身份或私有目录范围不一致');
  const bound = () => {
    if (
      paths.some((p, i) => restorePrivatePath(p, i < 2) !== identities[i]) ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原本机凭证、授权目录或日志身份已变化');
  };
  const journal = new AgentStorage(directory);
  try {
    bound();
    const row = journal.db
      .prepare('SELECT body FROM applications WHERE id=?')
      .get(integrationId) as { body: string } | undefined;
    if (!row)
      throw new DomainError(
        'INTEGRATION_RECORD_NOT_FOUND',
        '原日志没有该应用；没有建立新应用或释放任何占用',
      );
    const record = parseLocalApplicationRecord(row.body, integrationId);
    let originalBody = row.body;
    const originalStillBound = () => {
      bound();
      if (
        journal.db.prepare('SELECT body FROM applications WHERE id=?').get(integrationId)?.body !==
        originalBody
      )
        throw new DomainError(
          'INTEGRATION_JOURNAL_INVALID',
          '原应用证据在结算期间变化；保留现场与原结算请求',
        );
    };
    if (record.binding !== binding)
      throw new DomainError(
        'INTEGRATION_RECOVERY_UNAVAILABLE',
        '只能在原凭证下明确结算准备中、写入中或待核对的原应用',
      );
    if (!record.recoveryContext) {
      // Legacy evidence cannot borrow identifiers from local guesses or an
      // unavailable/revoked service. An authorized exact response is mandatory.
      const view = await nodeRequest<IntegrationView>(
        credentials.controlUrl,
        'integration-inspect',
        { integrationId },
        credentials.nodeToken,
      );
      bound();
      const context = freezeIntegrationRecoveryContext(view.operation, credentials);
      if (
        context.integrationId !== record.integrationId ||
        context.applicationId !== record.applicationId ||
        context.applicationInputHash !== record.inputHash ||
        context.root !== record.root ||
        record.added.some((entry) => {
          const expected = view.operation.report!.plan!.files.find(
            (f) => f.path === entry.path,
          )?.source;
          return (
            !expected ||
            expected.objectId !== entry.objectId ||
            expected.mode !== entry.gitMode ||
            expected.bytes !== entry.bytes
          );
        })
      )
        throw new DomainError(
          'INTEGRATION_CONTEXT_INVALID',
          '当前授权回复不是原应用的固定来源、选择或目标',
        );
      record.recoveryContext = context;
      validateRecoveryContextBinding(record, credentials);
      // The sole permitted original-row change is explicit context hydration.
      journal.db
        .prepare('UPDATE applications SET body=? WHERE id=? AND body=?')
        .run(JSON.stringify(record), integrationId, row.body);
      originalBody = JSON.stringify(record);
      originalStillBound();
      log('已从当前获授权的原操作回复补全历史恢复上下文；原应用阶段与待发回执保持不变。');
    }
    const context = validateRecoveryContextBinding(record, credentials);
    let recovery = readLocalIntegrationRecovery(journal.db, record);
    if (!recovery) {
      if (!['prepared', 'applying', 'needs_attention'].includes(record.phase))
        throw new DomainError(
          'INTEGRATION_RECOVERY_UNAVAILABLE',
          '原应用不是准备中、写入中或待核对状态',
        );
      log(
        `原整合 ${integrationId} · 应用 ${record.applicationId}\n原 Task ${context.taskId}\n原目录 ${terminalLabel(context.root)}\n保留所有当前文件、HEAD 和索引，只释放原应用占用。不会核验当前文件、判断应用成功、继续写入或回滚。`,
      );
      log(
        `历史固定来源 ${context.source.resultId} · v${context.source.revision} · 修订 ${context.source.revisionId}\n来源提交 ${context.source.commit} · 材料 ${context.source.materialKind}:${context.source.materialId}\n原目标提交 ${context.target.commit} · 检查点 ${context.target.checkpointId} · 恢复副本 ${context.target.retentionId}\n原选定 ${context.selectedPaths.length} 个文件；原记录已新增 ${record.added.length} 个文件、${record.directories?.length ?? 0} 个目录；未确认写入意图 ${record.intent === null ? '无' : '有'}。以上均为历史证据，当前文件未经核验。`,
      );
      if (record.existingChanges)
        log(
          `原记录另有 ${record.existingChanges.changes.length} 个替换/移出文件；私有备份 ${terminalLabel(record.existingChanges.backup.path)}。保留该目录、暂存和全部现有内容，不按新增数量推断现场。`,
        );
      log(
        '确认后仅在原 Task 当前授权允许时共享有界结算观察（原应用、停止确认、释放时间、原已记录数量及未确认写入意图标记）；网络或授权失败仍保留本机释放结果和原待发包。',
      );
      if (
        (await ask(
          `请确认原应用进程 ${record.applicationId} 以及所有 integration-add / integration-change / restore-publish 子进程/遗留孤儿进程均已停止。输入 STOPPED ${record.applicationId}：`,
        )) !== `STOPPED ${record.applicationId}`
      )
        throw new DomainError(
          'CONFIRMATION_REQUIRED',
          '未明确确认原应用及 integration-add / integration-change / restore-publish 子进程/孤儿进程已停止；保留全部文件与原写锁',
        );
      originalStillBound();
      const recoveryId = randomUUID(),
        evidenceHash = originalApplicationEvidenceHash(record);
      recovery = {
        version: 1,
        integrationId,
        applicationId: record.applicationId,
        recoveryId,
        contextHash: context.contextHash,
        originalApplicationEvidenceHash: evidenceHash,
        originalApplication: structuredClone(record),
        phase: 'release_prepared',
        releaseRequest: {
          version: 1,
          recoveryId,
          claimId: `integration:${record.applicationId}`,
          root: context.root,
          identity: context.rootIdentity,
          gitIdentity: context.gitIdentity,
          evidenceHash,
          stoppedConfirmedAt: new Date().toISOString(),
        },
        releaseReceipt: null,
        report: null,
        recoveryPending: null,
        acknowledged: null,
      } satisfies LocalIntegrationRecovery;
      saveLocalIntegrationRecovery(journal.db, record, recovery);
    }
    originalStillBound();
    // Exact receipt replay happens before any directory read. A crash after the
    // registry commit never turns missing-claim absence into guessed success,
    // and cannot delete or even inspect a newer writer's claim.
    const receipt =
      workspaceReleaseReceipt(recovery.releaseRequest) ??
      releaseWorkspaceClaim(recovery.releaseRequest);
    if (recovery.phase === 'release_prepared') {
      recovery.phase = 'released';
      recovery.releaseReceipt = receipt;
      recovery.report = recoveryReport(record, recovery, receipt);
      recovery.recoveryPending = recovery.report;
      originalStillBound();
      saveLocalIntegrationRecovery(journal.db, record, recovery);
    } else if (canonicalJson(receipt) !== canonicalJson(recovery.releaseReceipt))
      throw new DomainError('INTEGRATION_RECOVERY_INVALID', '持久释放回执与原结算记录不同');
    let publicationError: string | null = null;
    if (recovery.recoveryPending) {
      try {
        originalStillBound();
        const ack = await nodeRequest(
          credentials.controlUrl,
          'integration-recovery-publish',
          recovery.recoveryPending,
          credentials.nodeToken,
        );
        originalStillBound();
        const acknowledged = {
          ...recovery,
          acknowledged: parseRecoveryAcknowledgement(ack, recovery.recoveryPending),
          recoveryPending: null,
        };
        saveLocalIntegrationRecovery(journal.db, record, acknowledged);
        recovery = acknowledged;
      } catch (cause) {
        publicationError = cause instanceof DomainError ? cause.code : 'PUBLICATION_UNCONFIRMED';
        log(
          '原应用占用已在本机释放，全部文件与原应用证据保留；任务结算观察尚未确认，将只重发原结算包。',
        );
      }
    }
    return {
      integrationId,
      applicationId: record.applicationId,
      recoveryId: recovery.recoveryId,
      state: 'released' as const,
      disposition: 'preserve_files' as const,
      filesVerified: false as const,
      publication: recovery.recoveryPending ? ('pending' as const) : ('acknowledged' as const),
      publicationError,
      originalApplicationPhase: record.phase,
      originalPendingReportSequence: record.pending?.sequence ?? null,
    };
  } finally {
    journal.close();
  }
}
