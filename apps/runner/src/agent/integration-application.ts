import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { lstatSync } from 'node:fs';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  parseIntegrationApplicationReport,
  parseIntegrationApplicationCandidate,
  type IntegrationView,
  type IntegrationOperation,
  type IntegrationApplicationReport,
} from '../../../../packages/contracts/src/integrations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import {
  restoreBinding,
  restorePrivatePath,
  withRestoreSource,
  type RestoreMaterialSource,
} from './checkpoint-restore-preflight.js';
import { withReceivedRestoreSource } from './checkpoint-received-source.js';
import { verifySnapshot, objectHash } from './checkpoint-objects.js';
import { captureCommitReference } from './checkpoints.js';
import { verifyCleanCommit } from './committed-workspace.js';
import { assertCodeQuiescent } from './result-code.js';
import { buildIntegrationPlan } from './integration-plan.js';
import { integrationAdditionPlan } from './integration-application-plan.js';
import { checkRestoreHelper, PinnedRestoreParent, inode } from './checkpoint-restore-files.js';
import { inspectRestoreTarget, type RestoreEntry } from './checkpoint-restore-plan.js';
import { IntegrationApplicationCandidate } from './integration-application-candidate.js';
import { IntegrationApplicationBackup } from './integration-application-backup.js';
import { buildIntegrationTrialPlan } from './integration-trial-plan.js';
import {
  checkIntegrationChangeHelper,
  observeIntegrationChangeTarget,
  publishIntegrationFileChange,
} from './integration-change-files.js';
import {
  hasExistingIntegrationMaterial,
  type ExistingIntegrationChanges,
} from './integration-existing-change-record.js';
import {
  IntegrationAdditionParents,
  newIntegrationDirectoryIntent,
  publishIntegrationDirectory,
} from './integration-add-directories.js';
import { checkIntegrationAddHelper, publishIntegrationAddition } from './integration-add-files.js';
import { WorkspaceLease } from '../workspace-lease.js';
import { terminalLabel } from './terminal-label.js';
import {
  validateLocalShape,
  confirmedApplicationPaths,
  parseLocalApplicationRecord,
  type LocalApplication,
} from './integration-application-record.js';
export { validateLocalShape, type LocalApplication } from './integration-application-record.js';
import {
  freezeIntegrationRecoveryContext,
  validateRecoveryContextBinding,
} from './integration-recovery-context.js';
import {
  hasSettledIntegrationRecovery,
  readLocalIntegrationRecovery,
} from './integration-recovery-journal.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
function validateLocalApplication(record: LocalApplication, operation: IntegrationOperation) {
  validateLocalShape(record);
  const application = operation.application!;
  const invalid = () =>
    new DomainError(
      'INTEGRATION_JOURNAL_INVALID',
      '本机应用证据不完整或不一致；保留现场与写锁，不猜测完成',
    );
  if (
    !record ||
    record.integrationId !== operation.id ||
    !['prepared', 'applying', 'completed', 'failed', 'needs_attention'].includes(record.phase) ||
    !Array.isArray(record.added) ||
    record.added.length > application.paths.length ||
    ![0, 1, 2].includes(record.acknowledged) ||
    (record.intent !== null && !application.paths.includes(record.intent))
  )
    throw invalid();
  const seen = new Set<string>();
  for (const entry of record.added) {
    const expected = operation.report!.plan!.files.find((f) => f.path === entry.path)?.source;
    if (
      !application.paths.includes(entry.path) ||
      seen.has(entry.path) ||
      entry.kind !== 'file' ||
      !expected ||
      entry.objectId !== expected.objectId ||
      entry.gitMode !== expected.mode ||
      entry.bytes !== expected.bytes ||
      typeof entry.identity !== 'string' ||
      !/^\d+:\d+$/.test(entry.identity)
    )
      throw invalid();
    seen.add(entry.path);
  }
  for (const entry of record.existingChanges?.changes ?? []) {
    const f = operation.report!.plan!.files.find((f) => f.path === entry.before.path);
    const matches = (
      e: RestoreEntry | null,
      v: { objectId: string; mode: string; bytes: number } | null | undefined,
    ) =>
      e === null
        ? v === null
        : !!v && e.objectId === v.objectId && e.gitMode === v.mode && e.bytes === v.bytes;
    if (
      !f ||
      !['modify', 'delete'].includes(f.action) ||
      f.conflict ||
      seen.has(entry.before.path) ||
      !matches(entry.before, f.target) ||
      !matches(entry.after, f.source)
    )
      throw invalid();
    seen.add(entry.before.path);
  }
  if (
    (record.phase === 'completed' &&
      (record.intent !== null ||
        record.directoryIntent ||
        seen.size !== application.paths.length)) ||
    (['failed', 'prepared'].includes(record.phase) &&
      (record.intent !== null ||
        record.added.length > 0 ||
        record.directories?.length ||
        record.directoryIntent ||
        hasExistingIntegrationMaterial(record.existingChanges)))
  )
    throw invalid();
  if (record.pending) {
    const p = parseIntegrationApplicationReport(record.pending);
    if (
      p.integrationId !== operation.id ||
      p.applicationId !== application.id ||
      p.inputHash !== application.inputHash ||
      canonicalJson(p.appliedPaths) !== canonicalJson([...seen].sort()) ||
      (record.phase === 'prepared' ? p.stage !== 'applying' : p.stage !== record.phase)
    )
      throw invalid();
  } else if (
    (record.phase === 'completed' || record.phase === 'needs_attention') &&
    record.acknowledged !== 2
  )
    throw invalid();
}
function failure(cause: unknown): IntegrationApplicationReport['reason'] {
  const code = cause instanceof DomainError ? cause.code : '';
  if (
    code === 'WORKSPACE_COMMIT_CHANGED' ||
    code === 'RESTORE_FILES_CHANGED' ||
    code === 'RESTORE_TARGET_EXISTS'
  )
    return 'target_changed';
  if (code.includes('BUSY') || code.includes('WRITER_ACTIVE')) return 'workspace_busy';
  if (code.includes('UNSUPPORTED') || code.includes('HELPER')) return 'unsupported_snapshot';
  if (
    code.includes('SNAPSHOT') ||
    code.includes('RETENTION') ||
    code.includes('RESTORE_NOT_AVAILABLE')
  )
    return 'objects_unavailable';
  if (code === 'INTEGRATION_INTERRUPTED') return 'interrupted';
  return 'application_failed';
}

/** Credential replacement/deletion must hold the same process guard for the
 * entire action, including network waits, so a new application cannot slip in. */
export async function withSettledIntegrationEvidence<T>(
  home: string,
  action: () => Promise<T>,
): Promise<T> {
  const storage = new AgentStorage(join(home, 'integration-application'));
  try {
    const applicationsExist = storage.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='applications'")
      .get();
    const recoveriesExist = storage.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='integration_recoveries'")
      .get();
    if (
      !applicationsExist &&
      recoveriesExist &&
      storage.db.prepare('SELECT 1 FROM integration_recoveries LIMIT 1').get()
    )
      throw new DomainError('INTEGRATION_UNSETTLED', '结算记录缺少原应用证据；保留原凭证');
    if (applicationsExist) {
      const rows = storage.db.prepare('SELECT id,body FROM applications').all() as {
        id: string;
        body: string;
      }[];
      if (
        storage.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='integration_recoveries'").get()
      ) {
        const ids = new Set(
          rows.map((row) => parseLocalApplicationRecord(row.body, row.id).applicationId),
        );
        for (const recovery of storage.db
          .prepare('SELECT application_id FROM integration_recoveries')
          .all())
          if (!ids.has(recovery.application_id as string))
            throw new DomainError('INTEGRATION_UNSETTLED', '结算记录缺少原应用证据；保留原凭证');
      }
      for (const row of rows) {
        let r: LocalApplication;
        try {
          r = parseLocalApplicationRecord(row.body, row.id);
          if (r.integrationId !== row.id) throw new Error('Journal identity mismatch');
        } catch {
          throw new DomainError('INTEGRATION_UNSETTLED', '应用日志无效，不能删除原凭证');
        }
        const recovery = readLocalIntegrationRecovery(storage.db, r);
        if (recovery) {
          if (hasSettledIntegrationRecovery(storage.db, r)) continue;
          throw new DomainError(
            'INTEGRATION_UNSETTLED',
            '本机结算或原应用仍有未确认回执；保留原凭证',
          );
        }
        if (
          !r ||
          !Array.isArray(r.added) ||
          r.pending !== null ||
          r.intent !== null ||
          !!r.directoryIntent ||
          !['completed', 'failed'].includes(r.phase) ||
          (r.phase === 'completed'
            ? r.acknowledged !== 2 || !confirmedApplicationPaths(r).length
            : r.added.length > 0 ||
              !!r.directories?.length ||
              hasExistingIntegrationMaterial(r.existingChanges) ||
              ![0, 1, 2].includes(r.acknowledged))
        )
          throw new DomainError(
            'INTEGRATION_UNSETTLED',
            '仍有应用写入、未知现场或未确认回执；保留原节点凭证与日志，先在原节点核对整合结果',
            409,
          );
      }
    }
    return await action();
  } finally {
    storage.close();
  }
}

/** One explicitly confirmed attempt. A restart reconciles evidence only; it can
 * never resume writes. Filesystem uncertainty keeps the persistent writer claim. */
export async function applyIntegration(
  home: string,
  integrationId: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
  signal?: AbortSignal,
  options: { backup?: string } = {},
) {
  nodeId(integrationId);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '整合应用目前仅支持Linux普通Git目录');
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  if (
    c.directories.flatMap((w) => [w.root, w.gitDir]).some((p) => inside(home, p) || inside(p, home))
  )
    throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '节点私有状态不能与代码目录重叠');
  const bound = () => {
    if (
      restorePrivatePath(home, true) !== homeIdentity ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原本机身份或授权目录已变化');
  };
  const inspect = async () => {
    bound();
    const view = await nodeRequest<IntegrationView>(
      c.controlUrl,
      'integration-inspect',
      { integrationId },
      c.nodeToken,
    );
    bound();
    const o = view.operation,
      a = o?.application;
    if (
      o?.id !== integrationId ||
      o.projectId !== c.projectId ||
      o.spaceId !== c.spaceId ||
      o.target.checkpoint.request.nodeId !== c.nodeId ||
      !a ||
      !o.report?.plan ||
      o.inputHash !==
        hash({
          id: o.id,
          taskId: o.taskId,
          source: o.source,
          target: o.target,
          material: o.material,
        }) ||
      a.reportHash !== hash(o.report) ||
      a.inputHash !==
        hash({
          integrationId: o.id,
          applicationId: a.id,
          reportHash: a.reportHash,
          paths: a.paths,
          ...(a.candidate ? { candidate: a.candidate } : {}),
        }) ||
      !c.directories.some((w) => w.id === o.target.checkpoint.request.workspaceId)
    )
      throw new DomainError('INTEGRATION_SCOPE_CHANGED', '应用不属于本机固定来源、选择或目标');
    if (a.candidate) parseIntegrationApplicationCandidate(a.candidate);
    return view;
  };
  const journal = new AgentStorage(join(home, 'integration-application'));
  let lease: WorkspaceLease | undefined;
  let candidate: IntegrationApplicationCandidate | undefined;
  let backup: IntegrationApplicationBackup | undefined;
  try {
    journal.db.exec(
      'CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,body TEXT NOT NULL)',
    );
    const original = await inspect(),
      o = original.operation,
      a = o.application!,
      claim = `integration:${a.id}`;
    const w = c.directories.find((w) => w.id === o.target.checkpoint.request.workspaceId)!;
    const row = journal.db
      .prepare('SELECT body FROM applications WHERE id=?')
      .get(integrationId) as { body: string } | undefined;
    let record: LocalApplication | undefined = row
      ? parseLocalApplicationRecord(row.body, integrationId)
      : undefined;
    const save = () => {
      bound();
      parseLocalApplicationRecord(JSON.stringify(record), integrationId);
      journal.db
        .prepare(
          'INSERT INTO applications VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(integrationId, JSON.stringify(record));
    };
    const packet = (
      stage: IntegrationApplicationReport['stage'],
      why: IntegrationApplicationReport['reason'] = null,
      sequence: 1 | 2 = stage === 'applying' ? 1 : 2,
    ) =>
      parseIntegrationApplicationReport({
        integrationId,
        applicationId: a.id,
        inputHash: a.inputHash,
        sequence,
        stage,
        observedAt: new Date().toISOString(),
        appliedPaths: confirmedApplicationPaths(record!),
        reason: why,
        confirmPublication: true,
      });
    const publish = async () => {
      if (!record!.pending) return;
      const remote = await inspect();
      const p = record!.pending;
      const accepted = remote.operation.application!.reports.find((r) => r.sequence === p.sequence);
      if (accepted) {
        if (hash(accepted) !== hash(p))
          throw new DomainError('INVALID_RESPONSE', '原阶段报告指纹不同，保留本机证据');
        record!.acknowledged = p.sequence;
        record!.pending = null;
        save();
        return;
      }
      const receipt = await nodeRequest<{
        integrationId: string;
        applicationId: string;
        hash: string;
        sequence: number;
      }>(c.controlUrl, 'integration-apply-publish', p, c.nodeToken);
      if (
        receipt.integrationId !== integrationId ||
        receipt.applicationId !== a.id ||
        receipt.hash !== hash(p) ||
        receipt.sequence !== p.sequence
      )
        throw new DomainError('INVALID_RESPONSE', '应用回执不匹配；保留原报告，不重写文件');
      record!.acknowledged = p.sequence;
      record!.pending = null;
      save();
    };
    const releaseSettled = () => {
      if (record!.phase !== 'completed' && record!.phase !== 'failed') return;
      // A terminal local record is durable proof no writer will be replayed.
      // If the root moved, leave the old claim for explicit local handling.
      try {
        lease ??= new WorkspaceLease(record!.root, claim, true);
        lease.release();
      } catch {
        log('应用文件证据已保存，但原目录写锁需本机核对；没有自动清除其他占用。');
      }
    };
    if (record) {
      validateLocalApplication(record, o);
      if (record.recoveryContext) validateRecoveryContextBinding(record, c);
      if (
        record.binding !== binding ||
        record.applicationId !== a.id ||
        record.inputHash !== a.inputHash ||
        record.root !== w.root
      )
        throw new DomainError('INTEGRATION_SCOPE_CHANGED', '本机应用日志与原身份或目标不一致');
      log('只对账原应用证据；不会再次写入、续写、删除文件或自动回滚。');
      if (readLocalIntegrationRecovery(journal.db, record)) {
        // A recovery freezes original history separately. Reconcile only the
        // already-durable application packet; never synthesize new stages or
        // inspect/release any current workspace claim.
        await publish();
        return {
          integrationId,
          state: record.phase,
          appliedPaths: confirmedApplicationPaths(record),
        };
      }
      if (record.phase === 'prepared' || record.phase === 'applying') {
        // First reconcile the original start packet, then record the interruption.
        // If cancellation definitively won before start, no write ever began.
        if (o.state === 'cancelled' && !a.reports.length) {
          if (
            record.phase !== 'prepared' ||
            record.added.length ||
            record.directories?.length ||
            record.directoryIntent ||
            hasExistingIntegrationMaterial(record.existingChanges) ||
            record.intent !== null ||
            record.acknowledged !== 0
          )
            throw new DomainError(
              'INTEGRATION_EVIDENCE_MISMATCH',
              '服务端取消记录与本机写入证据不一致；保留现场和原写锁，不用旧服务记录判定未写入',
            );
          record.phase = 'failed';
          record.pending = null;
          save();
          releaseSettled();
          return { integrationId, state: 'cancelled', appliedPaths: [] };
        }
        if (record.phase === 'prepared' && !record.pending && !record.acknowledged) {
          record.phase = 'failed';
          record.pending = packet('failed', 'interrupted', 1);
        } else {
          await publish();
          record.phase = 'needs_attention';
          record.pending = packet('needs_attention', 'interrupted');
        }
        save();
      }
      releaseSettled();
      await publish();
      return {
        integrationId,
        state: record.phase,
        appliedPaths: confirmedApplicationPaths(record),
      };
    }
    if (
      journal.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='integration_recoveries'").get() &&
      journal.db.prepare('SELECT 1 FROM integration_recoveries WHERE application_id=?').get(a.id)
    )
      throw new DomainError(
        'INTEGRATION_RECOVERY_INVALID',
        '原结算存在但原应用记录缺失；不重新建立写入',
      );
    if (!original.available || o.state !== 'queued' || a.reports.length)
      throw new DomainError(
        'INTEGRATION_UNAVAILABLE',
        original.unavailableReason ?? '应用已关闭或已开始，不能建立第二次写入',
        409,
      );
    if (
      (!a.candidate && options.backup !== undefined) ||
      (a.candidate &&
        (!options.backup ||
          !isAbsolute(options.backup) ||
          resolve(options.backup) !== options.backup))
    )
      throw new DomainError(
        'INTEGRATION_BACKUP_REQUIRED',
        '固定候选写回须另外指定全新绝对路径 --backup；旧新增应用不接受扩大范围',
      );
    checkIntegrationAddHelper();
    checkRestoreHelper();
    if (a.candidate) checkIntegrationChangeHelper();
    log(
      `成果 ${terminalLabel(o.source.title)} · v${o.source.revision}\n来源 ${o.material.manifest.commit}\n目标 ${o.target.manifest.commit}\n恢复副本 ${o.target.retentionId}\n本机目标 ${terminalLabel(w.root)}\n选定文件：\n${a.paths.join('\n')}`,
    );
    log(
      a.candidate
        ? `固定候选 ${a.candidate.trialId}，差异指纹 ${a.candidate.reportHash}。替换/移出的原文件保留到全新私有目录 ${terminalLabel(options.backup!)}；候选目录不变。必须先停止本目录全部执行、编辑器自动保存与其他写入者；原子rename不能按内容条件阻止外部并发修改。只应用完整候选选择，保留未选文件、HEAD与索引；未知现场保留全部材料和写锁，不自动回滚或清理。确认同时共享应用阶段与已应用文件名。`
        : '只新增所选普通文件，必要且缺少的父目录会排他新建（最多256个）；不接管后来出现的目录。保留未选文件、HEAD与索引；不调用模型、不提交、不覆盖。确认同时共享应用阶段及已写文件名。中断/部分失败保留现场和写锁，不自动恢复。',
    );
    const confirmation = a.candidate ? `STOPPED_AND_APPLY ${a.id}` : `APPLY ${a.id}`;
    if ((await ask(`输入 ${confirmation}：`)) !== confirmation)
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认本机写入，原应用范围仍可在任务中取消');
    const stoppedWritersAt = new Date().toISOString();
    if (a.candidate) candidate = new IntegrationApplicationCandidate(home, binding, o);
    const current = async (state: 'queued' | 'applying', own = false) => {
      if (signal?.aborted) throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续写入');
      const v = await inspect();
      if (signal?.aborted) throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续写入');
      if (
        v.operation.application!.inputHash !== a.inputHash ||
        v.operation.state !== state ||
        !v.available
      )
        throw new DomainError(
          'INTEGRATION_UNAVAILABLE',
          '应用已关闭或当前权限、材料、目标发生变化',
          409,
        );
      assertCodeQuiescent(home, w.root, w.rootIdentity, own ? claim : undefined);
      if (own) lease!.assertHeld();
    };
    const materials = async <T>(
      visit: (s: RestoreMaterialSource, t: RestoreMaterialSource) => Promise<T>,
    ) =>
      withRestoreSource(home, o.target.retentionId, signal, async (t) => {
        const open = o.material.kind === 'transfer' ? withReceivedRestoreSource : withRestoreSource;
        return open(home, o.material.id, signal, async (s) => {
          if (
            canonicalJson(s.manifest) !== canonicalJson(o.material.manifest) ||
            canonicalJson(t.manifest) !== canonicalJson(o.target.manifest)
          )
            throw new DomainError('SNAPSHOT_INCOMPLETE', '完整副本与固定来源不一致');
          return visit(s, t);
        });
      });
    const snapshot = async (s: RestoreMaterialSource) => {
      const m = s.manifest,
        result = await s.snapshot((read) => verifySnapshot(m.objectFormat, m.commit, m.tree, read));
      if (
        result.snapshotHash !== m.snapshotHash ||
        canonicalJson(result.coverage) !== canonicalJson(m.coverage)
      )
        throw new DomainError('SNAPSHOT_INCOMPLETE', '副本完整对象与原指纹不一致');
      return result;
    };
    await current('queued');
    return await materials(async (source, target) => {
      const s = await snapshot(source),
        t = await snapshot(target),
        start = o.source.code.base;
      let base: Awaited<ReturnType<typeof verifySnapshot>> | undefined;
      const reference = await captureCommitReference(
        w,
        start.commit,
        c.clientId,
        home,
        async (read, _commit, tree) => {
          if (tree !== start.tree)
            throw new DomainError('SNAPSHOT_INCOMPLETE', '共同起点对象不一致');
          base = await verifySnapshot(start.objectFormat, start.commit, start.tree, read);
        },
      );
      if (reference.repositoryIdentity !== o.target.checkpoint.manifest.repositoryIdentity)
        throw new DomainError('WORKSPACE_COMMIT_CHANGED', '原目标仓库对象身份已变化');
      const plan = buildIntegrationPlan(
        start.objectFormat,
        { base: start.tree, source: o.material.manifest.tree, target: o.target.manifest.tree },
        { base: base!, source: s, target: t },
        w.root,
      );
      if (canonicalJson(plan) !== canonicalJson(o.report!.plan))
        throw new DomainError('INTEGRATION_SCOPE_CHANGED', '完整重算计划与原预检不一致');
      const trialPlan = candidate
        ? await buildIntegrationTrialPlan(
            start.objectFormat,
            { base: start.tree, source: o.material.manifest.tree, target: o.target.manifest.tree },
            { base: base!, source: s, target: t },
            plan,
            a.paths,
            w.root,
          )
        : undefined;
      if (trialPlan) candidate!.verify(trialPlan);
      const addPaths = a.candidate
        ? a.paths.filter((path) => plan.files.find((f) => f.path === path)?.action === 'add')
        : a.paths;
      const additionPlan = addPaths.length
        ? integrationAdditionPlan(
            start.objectFormat,
            o.target.manifest.tree,
            t,
            plan,
            addPaths,
            w.root,
          )
        : { files: [], directories: [], anchors: [] };
      const entry = (
        path: string,
        v: { objectId: string; mode: '100644' | '100755'; bytes: number },
      ): RestoreEntry => ({
        path,
        kind: 'file',
        objectId: v.objectId,
        gitMode: v.mode,
        bytes: v.bytes,
      });
      const changes = a.candidate
        ? a.paths.flatMap((path) => {
            const f = plan.files.find((f) => f.path === path)!;
            if (f.action === 'add') return [];
            if (!['modify', 'delete'].includes(f.action) || !f.target || f.conflict)
              throw new DomainError('INTEGRATION_UNSUPPORTED', '固定候选存在未支持的变更');
            return [
              {
                before: entry(path, f.target),
                after: f.source ? entry(path, f.source) : null,
                originalIdentity: inode(lstatSync(join(w.root, path), { bigint: true })),
                backupName: `hexu-change-${randomUUID()}`,
                observation: observeIntegrationChangeTarget(join(w.root, path)),
              },
            ];
          })
        : [];
      let existingChanges: ExistingIntegrationChanges | undefined;
      if (candidate) {
        const protectedPaths = [
          home,
          ...c.directories.flatMap((w) => [w.root, w.gitDir]),
          ...candidate.journal.storage.db
            .prepare('SELECT target FROM trials')
            .all()
            .map((row) => row.target as string),
        ];
        existingChanges = {
          backup: inspectRestoreTarget(options.backup!, protectedPaths),
          stageName: `.hexu-restore-${randomUUID()}`,
          stageIdentity: null,
          backupIdentity: null,
          directoryIntent: false,
          stoppedWritersAt,
          changes: [],
          intent: null,
        };
        backup = new IntegrationApplicationBackup(existingChanges, w.root);
      }
      const additions = additionPlan.files;
      const parents = new IntegrationAdditionParents(w.root, additionPlan.anchors, [
        home,
        w.gitDir,
      ]);
      await verifyCleanCommit(home, c, w, o.target.checkpoint.manifest);
      await current('queued');
      lease = new WorkspaceLease(w.root, claim);
      record = {
        binding,
        integrationId,
        applicationId: a.id,
        inputHash: a.inputHash,
        root: w.root,
        phase: 'prepared',
        added: [],
        intent: null,
        pending: null,
        acknowledged: 0,
        recoveryContext: freezeIntegrationRecoveryContext(o, c),
        directories: [],
        directoryIntent: null,
        ...(existingChanges ? { existingChanges } : {}),
      };
      try {
        save();
      } catch (e) {
        lease.release();
        throw e;
      }
      let assertObservedTarget: (() => void) | undefined;
      const verifyTarget = () =>
        verifyCleanCommit(
          home,
          c,
          w,
          o.target.checkpoint.manifest,
          record!.added,
          (observed) => {
            assertObservedTarget = observed;
          },
          record!.directories ?? [],
          (record!.existingChanges?.changes ?? []).map((change) => ({
            before: change.before,
            after: change.after ? { ...change.after, identity: change.targetIdentity! } : null,
          })),
        );
      const readyToWrite = () => {
        lease!.assertHeld();
        bound();
        source.stillBound();
        target.stillBound();
        if (signal?.aborted) throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续写入');
        if (trialPlan) candidate!.verify(trialPlan);
        if (record!.existingChanges?.backupIdentity) backup!.verify();
        candidate?.revalidate();
        assertObservedTarget?.();
        if (record!.existingChanges?.backupIdentity) backup!.revalidate();
        if (signal?.aborted) throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续写入');
        if ([source.manifest, target.manifest].some((m) => Date.parse(m.expiresAt) <= Date.now()))
          throw new DomainError('RETENTION_EXPIRED', '固定材料已经到期，停止后续写入并保留现场');
      };
      try {
        await current('queued', true);
        await verifyCleanCommit(home, c, w, o.target.checkpoint.manifest);
        await source.authorized();
        await target.authorized();
        record.pending = packet('applying');
        save();
        await publish();
        record.phase = 'applying';
        save();
        if (backup) {
          await current('applying', true);
          await source.authorized();
          await target.authorized();
          await verifyTarget();
          readyToWrite();
          backup.create(save, readyToWrite);
        }
        for (const path of additionPlan.directories) {
          await current('applying', true);
          await source.authorized();
          await target.authorized();
          await verifyTarget();
          const parent = parents.open(path, record.directories!);
          try {
            lease.assertHeld();
            bound();
            if (signal?.aborted)
              throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续写入');
            readyToWrite();
            record.intent = additions.find((entry) => entry.path.startsWith(path + '/'))!.path;
            record.directoryIntent = newIntegrationDirectoryIntent(path);
            save();
            const created = publishIntegrationDirectory(
              parent,
              record.directoryIntent,
              (identity) => {
                record!.directoryIntent!.stageIdentity = identity;
                save();
                lease!.assertHeld();
                bound();
                if (signal?.aborted)
                  throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续写入');
              },
            );
            record.directories!.push(created);
            record.directoryIntent = null;
            record.intent = null;
            save();
          } finally {
            parent.close();
          }
        }
        for (const entry of additions) {
          await current('applying', true);
          await source.authorized();
          await target.authorized();
          await verifyTarget();
          const parent = parents.open(entry.path, record.directories!);
          try {
            const object = s.objects.find((o) => o.id === entry.objectId);
            if (
              !object ||
              object.type !== 'blob' ||
              objectHash(start.objectFormat, 'blob', object.data) !== entry.objectId
            )
              throw new DomainError('SNAPSHOT_INCOMPLETE', '来源文件字节不匹配');
            lease.assertHeld();
            bound();
            if (signal?.aborted)
              throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续写入');
            readyToWrite();
            record.intent = entry.path;
            save();
            const identity = publishIntegrationAddition(parent, entry, object.data);
            if (!identity) {
              record.intent = null;
              save();
              throw new DomainError(
                'INTEGRATION_UNSUPPORTED',
                '文件未发布；目标已被占用或不支持排他新增',
              );
            }
            record.added.push({ ...entry, identity });
            record.intent = null;
            save();
          } finally {
            parent.close();
          }
        }
        for (const change of changes) {
          await current('applying', true);
          await source.authorized();
          await target.authorized();
          await verifyTarget();
          readyToWrite();
          const parent = new PinnedRestoreParent(change.observation);
          let slot: PinnedRestoreParent | undefined;
          try {
            slot = backup!.openSlot(change.backupName);
            const before = t.objects.find((object) => object.id === change.before.objectId),
              after = change.after
                ? s.objects.find((object) => object.id === change.after!.objectId)
                : null;
            if (
              !before ||
              before.type !== 'blob' ||
              (change.after && (!after || after.type !== 'blob'))
            )
              throw new DomainError('SNAPSHOT_INCOMPLETE', '固定文件对象缺失');
            const { observation: _observation, ...intent } = change;
            record.existingChanges!.intent = intent;
            record.intent = change.before.path;
            save();
            readyToWrite();
            const result = publishIntegrationFileChange(
              parent,
              slot,
              intent,
              before.data,
              after?.data ?? null,
            );
            if (!result) {
              record.existingChanges!.intent = null;
              record.intent = null;
              save();
              throw new DomainError(
                'INTEGRATION_CHANGE_UNSUPPORTED',
                '原文件未写回；保留已创建的私有备份现场',
              );
            }
            record.existingChanges!.changes.push({ ...intent, ...result });
            record.existingChanges!.intent = null;
            record.intent = null;
            save();
          } finally {
            parent.close();
            slot?.close();
          }
        }
        await current('applying', true);
        await source.authorized();
        await target.authorized();
        await verifyTarget();
        readyToWrite();
        record.phase = 'completed';
        record.pending = packet('completed');
        save();
      } catch (cause) {
        // A missing start ACK can mean the server accepted it. Reconcile only on
        // restart; never turn transport uncertainty into a second write attempt.
        if (record.pending?.sequence === 1) throw cause;
        if (record.acknowledged === 0) {
          record.phase = 'failed';
          record.pending = packet('failed', failure(cause), 1);
          save();
        } else {
          record.phase =
            record.added.length ||
            record.directories?.length ||
            record.intent ||
            record.directoryIntent ||
            hasExistingIntegrationMaterial(record.existingChanges)
              ? 'needs_attention'
              : 'failed';
          record.pending = packet(record.phase, failure(cause));
          save();
        }
      }
      releaseSettled();
      await publish();
      return {
        integrationId,
        state: record.phase,
        appliedPaths: confirmedApplicationPaths(record),
      };
    });
  } finally {
    backup?.close();
    candidate?.close();
    lease?.close(); // close never erases a possibly live/unknown claim.
    journal.close();
  }
}
