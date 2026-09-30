import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import type { IntegrationView } from '../../../../packages/contracts/src/integrations.js';
import {
  parseIntegrationFileRestorationReport,
  type IntegrationFileRestorationReport,
  type IntegrationFileRestorationReceipt,
} from '../../../../packages/contracts/src/integration-restorations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import {
  integrationEvidenceHash as hash,
  freezeIntegrationRecoveryContext,
  validateRecoveryContextBinding,
} from './integration-recovery-context.js';
import { parseLocalApplicationRecord } from './integration-application-record.js';
import { planIntegrationFileRestoration } from './integration-restoration-plan.js';
import { OriginalIntegrationBackup } from './integration-original-backup.js';
import { IntegrationApplicationBackup } from './integration-application-backup.js';
import { IntegrationTrialJournal } from './integration-trial-journal.js';
import { checkRestoreHelper, PinnedRestoreParent } from './checkpoint-restore-files.js';
import { inspectRestoreTarget, type RestoreEntry } from './checkpoint-restore-plan.js';
import { checkIntegrationAddHelper, publishIntegrationAddition } from './integration-add-files.js';
import {
  checkIntegrationChangeHelper,
  observeIntegrationChangeTarget,
  publishIntegrationFileChange,
  readIntegrationChangeFile,
} from './integration-change-files.js';
import { verifyCleanCommit } from './committed-workspace.js';
import { assertCodeQuiescent } from './result-code.js';
import { WorkspaceLease } from '../workspace-lease.js';
import { terminalLabel } from './terminal-label.js';
import {
  confirmedRestorationPaths,
  parseLocalIntegrationRestoration,
  parseRestorationRequest,
  restorationHasMaterial,
  restorationKey,
  restorationWorkspaceOverlay,
  type LocalIntegrationRestoration,
} from './integration-restoration-record.js';

import { readRestorationRecovery } from './integration-restoration-recovery.js';

const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
const entry = (e: RestoreEntry): RestoreEntry => ({
  path: e.path,
  kind: e.kind,
  objectId: e.objectId,
  gitMode: e.gitMode,
  bytes: e.bytes,
});
function reason(cause: unknown): IntegrationFileRestorationReport['reason'] {
  const code = cause instanceof DomainError ? cause.code : '';
  if (code.includes('BACKUP')) return 'backup_unavailable';
  if (code.includes('BUSY') || code.includes('WRITER_ACTIVE')) return 'workspace_busy';
  if (code.includes('CHANGED') || code.includes('TARGET_EXISTS')) return 'target_changed';
  if (code.includes('UNSUPPORTED') || code.includes('HELPER')) return 'unsupported_snapshot';
  if (code === 'INTEGRATION_INTERRUPTED') return 'interrupted';
  return 'restoration_failed';
}
/** One whole-selection inverse of a completed application. No source material,
 * model, Git mutation, automatic rollback, cleanup or resumed writes. */
export async function restoreIntegrationFiles(
  home: string,
  integrationId: string,
  restorationId: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
  signal?: AbortSignal,
  options: { backup?: string } = {},
) {
  nodeId(integrationId);
  nodeId(restorationId);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '文件恢复仅支持Linux普通Git目录');
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c),
    key = restorationKey(restorationId),
    claim = `integration:${restorationId}`;
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
  const journal = new AgentStorage(join(home, 'integration-application'));
  let lease: WorkspaceLease | undefined,
    backup: IntegrationApplicationBackup | undefined,
    oldBackup: OriginalIntegrationBackup | undefined,
    trials: IntegrationTrialJournal | undefined;
  try {
    if (!journal.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='applications'").get())
      throw new DomainError('INTEGRATION_RECORD_NOT_FOUND', '必须保留原已完成应用的本机证据');
    const originalBody = journal.db
      .prepare('SELECT body FROM applications WHERE id=?')
      .get(integrationId)?.body;
    const original = parseLocalApplicationRecord(originalBody, integrationId),
      context = validateRecoveryContextBinding(original, c),
      plan = planIntegrationFileRestoration(originalBody, integrationId);
    const w = c.directories.find((w) => w.id === context.workspaceId)!;
    const inspect = async () => {
      bound();
      const view = await nodeRequest<IntegrationView>(
        c.controlUrl,
        'integration-restoration-inspect',
        { integrationId, restorationId },
        c.nodeToken,
      );
      bound();
      const r = view.restoration;
      if (
        !r ||
        r.id !== restorationId ||
        r.integrationId !== integrationId ||
        r.applicationId !== original.applicationId ||
        r.applicationInputHash !== original.inputHash ||
        hash(freezeIntegrationRecoveryContext(view.operation, c)) !== hash(context)
      )
        throw new DomainError(
          'INTEGRATION_SCOPE_CHANGED',
          '恢复请求与原应用、当前本机身份或固定目标不一致',
        );
      const {
        revision: _revision,
        state: _state,
        reports: _reports,
        recovery: _recovery,
        ...request
      } = r;
      parseRestorationRequest(request);
      if (
        canonicalJson(request.paths.slice().sort()) !==
          canonicalJson(context.selectedPaths.slice().sort()) ||
        r.completedReportHash !==
          hash(
            view.operation.application!.reports.find(
              (p) => p.sequence === 2 && p.stage === 'completed',
            ),
          )
      )
        throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原完成报告或全部文件选择已变化');
      return { ...view, request };
    };
    const first = await inspect(),
      request = first.request;
    const raw = journal.db.prepare('SELECT body FROM applications WHERE id=?').get(key);
    let record: LocalIntegrationRestoration | undefined = raw
      ? parseLocalIntegrationRestoration(raw.body, key, original)
      : undefined;
    const save = () => {
      bound();
      if (
        journal.db.prepare('SELECT body FROM applications WHERE id=?').get(integrationId)?.body !==
        originalBody
      )
        throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原应用证据已变化');
      parseLocalIntegrationRestoration(JSON.stringify(record), key, original);
      journal.db
        .prepare(
          'INSERT INTO applications VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(key, JSON.stringify(record));
    };
    const packet = (
      stage: IntegrationFileRestorationReport['stage'],
      why: IntegrationFileRestorationReport['reason'] = null,
      sequence: 1 | 2 = stage === 'restoring' ? 1 : 2,
    ) =>
      parseIntegrationFileRestorationReport({
        version: 1,
        kind: 'integration_file_restoration',
        integrationId,
        applicationId: original.applicationId,
        restorationId,
        inputHash: request.inputHash,
        originalApplicationEvidenceHash: plan.originalEvidenceHash,
        sequence,
        stage,
        observedAt: new Date().toISOString(),
        restoredPaths: confirmedRestorationPaths(record!),
        reason: why,
        confirmPublication: true,
      });
    const publish = async () => {
      if (!record!.pending) return;
      const view = await inspect(),
        p = record!.pending,
        accepted = view.restoration!.reports.find((r) => r.sequence === p.sequence);
      if (accepted) {
        if (hash(accepted) !== hash(p))
          throw new DomainError('INVALID_RESPONSE', '原恢复报告指纹不同，保留本机证据');
      } else {
        const receipt = await nodeRequest<IntegrationFileRestorationReceipt>(
          c.controlUrl,
          'integration-restoration-publish',
          p,
          c.nodeToken,
        );
        if (
          receipt.integrationId !== integrationId ||
          receipt.applicationId !== original.applicationId ||
          receipt.restorationId !== restorationId ||
          receipt.sequence !== p.sequence ||
          receipt.hash !== hash(p)
        )
          throw new DomainError('INVALID_RESPONSE', '恢复回执不匹配；保留原报告，不重写文件');
      }
      record!.acknowledged = p.sequence;
      record!.pending = null;
      save();
    };
    const releaseSettled = () => {
      if (!['completed', 'failed'].includes(record!.phase)) return;
      try {
        lease ??= new WorkspaceLease(w.root, claim, true);
        lease.release();
      } catch {
        log('本机恢复证据已保存，但原目录写锁仍需核对；没有清除其他占用。');
      }
    };
    const result = () => ({
      integrationId,
      restorationId,
      state: record!.phase,
      restoredPaths: confirmedRestorationPaths(record!),
      retainedDirectories: plan.retainedDirectories.map((e) => e.path),
    });
    if (record) {
      if (record.request.inputHash !== request.inputHash)
        throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原恢复请求已变化');
      log('只对账原文件恢复证据，不再次写入、续写、回滚或清理。');
      const settlement = readRestorationRecovery(journal.db, original, record);
      if (settlement || first.restoration!.recovery) {
        await publish();
        return result();
      }
      if (record.phase === 'prepared' || record.phase === 'restoring') {
        if (first.restoration!.state === 'cancelled' && !first.restoration!.reports.length) {
          if (
            record.phase !== 'prepared' ||
            restorationHasMaterial(record) ||
            record.acknowledged !== 0
          )
            throw new DomainError(
              'INTEGRATION_EVIDENCE_MISMATCH',
              '取消与本机恢复证据不一致；保留现场',
            );
          record.phase = 'failed';
          record.pending = null;
          save();
          releaseSettled();
          return { ...result(), state: 'cancelled' };
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
      return result();
    }
    if (
      journal.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name='integration_restoration_recoveries'")
        .get() &&
      journal.db
        .prepare('SELECT 1 FROM integration_restoration_recoveries WHERE restoration_id=?')
        .get(restorationId)
    )
      throw new DomainError(
        'INTEGRATION_RECOVERY_INVALID',
        '结算存在而原恢复记录缺失；不重新建立写入',
      );
    if (
      first.restoration!.state !== 'queued' ||
      first.restoration!.reports.length ||
      first.restoration!.recovery
    )
      throw new DomainError(
        'INTEGRATION_RESTORATION_UNAVAILABLE',
        '恢复已开始或关闭，不能建立第二次写入',
      );
    if (
      !options.backup ||
      !isAbsolute(options.backup) ||
      resolve(options.backup) !== options.backup
    )
      throw new DomainError(
        'INTEGRATION_BACKUP_REQUIRED',
        '另行指定 --backup 全新绝对路径，用于保留本次恢复移出的当前文件',
      );
    checkIntegrationAddHelper();
    checkIntegrationChangeHelper();
    checkRestoreHelper();
    log(
      `原应用 ${original.applicationId}\n恢复请求 ${restorationId}\n本机目标 ${terminalLabel(w.root)}\n全部文件：\n${request.paths.join('\n')}\n新保留目录 ${terminalLabel(options.backup)}`,
    );
    log(
      '从原应用已确认备份恢复全部选定文件内容与Git执行位，同时将当前新增/修改文件保留到另一个全新私有目录；原备份与候选不变，原新建空目录保留。必须先停止全部执行、编辑器自动保存及其他写入者。拒绝后续用户修改，不commit/reset或调用模型。未知现场保留两处材料与写锁，不自动回滚、清理或续写。确认同时共享恢复阶段和文件名。',
    );
    const confirmation = `STOPPED_AND_RESTORE ${restorationId}`;
    if ((await ask(`输入 ${confirmation}：`)) !== confirmation)
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认本机文件恢复');
    const stoppedWritersAt = new Date().toISOString();
    const current = async (state: 'queued' | 'restoring', own = false) => {
      if (signal?.aborted) throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续恢复');
      const view = await inspect();
      if (signal?.aborted) throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续恢复');
      if (
        view.restoration!.inputHash !== request.inputHash ||
        view.restoration!.state !== state ||
        view.restoration!.recovery
      )
        throw new DomainError(
          'INTEGRATION_RESTORATION_UNAVAILABLE',
          '恢复已关闭、结算或目标权限发生变化',
        );
      assertCodeQuiescent(home, w.root, w.rootIdentity, own ? claim : undefined);
      if (own) lease!.assertHeld();
    };
    await current('queued');
    // Hold trial metadata guard while protecting every previously selected output.
    trials = new IntegrationTrialJournal(home);
    const protectedPaths = [
      home,
      ...c.directories.flatMap((w) => [w.root, w.gitDir]),
      ...trials.storage.db
        .prepare('SELECT target FROM trials')
        .all()
        .map((r) => r.target as string),
    ];
    for (const row of journal.db.prepare('SELECT id,body FROM applications').all()) {
      const parsed = JSON.parse(row.body as string);
      if (typeof row.id !== 'string')
        throw new DomainError('INTEGRATION_JOURNAL_INVALID', '本机应用身份无效');
      if (row.id.startsWith('restoration:')) {
        const source = journal.db
          .prepare('SELECT body FROM applications WHERE id=?')
          .get(parsed.request?.integrationId);
        const old = parseLocalIntegrationRestoration(
          row.body,
          row.id,
          parseLocalApplicationRecord(source?.body, parsed.request?.integrationId),
        );
        protectedPaths.push(old.existingChanges.backup.path);
      } else {
        const old = parseLocalApplicationRecord(row.body, row.id);
        if (old.existingChanges) protectedPaths.push(old.existingChanges.backup.path);
      }
    }
    const existingChanges = {
      backup: inspectRestoreTarget(options.backup, protectedPaths),
      stageName: `.hexu-restore-${randomUUID()}`,
      stageIdentity: null,
      backupIdentity: null,
      directoryIntent: false,
      stoppedWritersAt,
      changes: [],
      intent: null,
    };
    backup = new IntegrationApplicationBackup(existingChanges, w.root);
    const observations = new Map(
      plan.files.map((f) => [f.path, observeIntegrationChangeTarget(join(w.root, f.path))]),
    );
    let originalBytes = new Map<string, Buffer>();
    if (plan.originalBackup) {
      oldBackup = new OriginalIntegrationBackup(originalBody, integrationId);
      originalBytes = oldBackup.read();
    }
    const manifest = first.operation.target.checkpoint.manifest;
    record = {
      version: 1,
      kind: 'local_integration_file_restoration',
      binding,
      request,
      originalApplicationEvidenceHash: plan.originalEvidenceHash,
      contextHash: context.contextHash,
      planHash: hash(plan),
      manifest: {
        commit: manifest.commit,
        tree: manifest.tree,
        objectFormat: manifest.objectFormat,
        repositoryIdentity: manifest.repositoryIdentity,
      },
      phase: 'prepared',
      added: [],
      intent: null,
      existingChanges,
      pending: null,
      acknowledged: 0,
    };
    let assertObservedTarget: (() => void) | undefined;
    const verifyTarget = async () => {
      const overlay = restorationWorkspaceOverlay(original, record!);
      await verifyCleanCommit(
        home,
        c,
        w,
        record!.manifest,
        overlay.additions,
        (observed) => {
          assertObservedTarget = observed;
        },
        overlay.directories,
        overlay.changes,
      );
    };
    await verifyTarget();
    await current('queued');
    // Evidence precedes claim acquisition. A crash here cannot leave an unseen
    // restoration writer to an older runner's credential guard.
    save();
    const ready = () => {
      lease!.assertHeld();
      bound();
      trials!.stillBound();
      oldBackup?.assertUnchanged();
      if (record!.existingChanges.backupIdentity) backup!.verify();
      assertObservedTarget?.();
      oldBackup?.assertUnchanged();
      if (record!.existingChanges.backupIdentity) backup!.revalidate();
      if (signal?.aborted) throw new DomainError('INTEGRATION_INTERRUPTED', '本机已停止后续恢复');
    };
    try {
      lease = new WorkspaceLease(w.root, claim);
      await current('queued', true);
      await verifyTarget();
      ready();
      record.pending = packet('restoring');
      save();
      await publish();
      record.phase = 'restoring';
      save();
      await current('restoring', true);
      await verifyTarget();
      ready();
      backup.create(save, ready);
      for (const file of plan.files) {
        await current('restoring', true);
        await verifyTarget();
        ready();
        const parent = new PinnedRestoreParent(observations.get(file.path)!);
        let slot: PinnedRestoreParent | undefined;
        try {
          if (file.before) {
            const before = readIntegrationChangeFile(
              parent.fd,
              basename(file.path),
              file.before,
              file.before.identity,
            );
            const change = {
              before: entry(file.before),
              after: file.after ? entry(file.after) : null,
              originalIdentity: file.before.identity,
              backupName: `hexu-change-${randomUUID()}`,
            };
            slot = backup.openSlot(change.backupName);
            record.intent = file.path;
            record.existingChanges.intent = change;
            save();
            ready();
            const outcome = publishIntegrationFileChange(
              parent,
              slot,
              change,
              before.bytes,
              file.after ? originalBytes.get(file.path)! : null,
            );
            if (!outcome) {
              record.intent = null;
              record.existingChanges.intent = null;
              save();
              throw new DomainError('INTEGRATION_CHANGE_UNSUPPORTED', '本文件未恢复，保留当前材料');
            }
            record.existingChanges.changes.push({ ...change, ...outcome });
            record.existingChanges.intent = null;
          } else {
            const after = entry(file.after!);
            record.intent = file.path;
            save();
            ready();
            const identity = publishIntegrationAddition(
              parent,
              after,
              originalBytes.get(file.path)!,
              (oldBackup!.permissions(file.path) & 0o077) === 0,
            );
            if (!identity) {
              record.intent = null;
              save();
              throw new DomainError(
                'INTEGRATION_CHANGE_UNSUPPORTED',
                '原删除路径已被占用或不支持排他恢复，保留现场',
              );
            }
            const verified = readIntegrationChangeFile(
              parent.fd,
              basename(file.path),
              after,
              identity,
            );
            if (verified.permissions !== oldBackup!.permissions(file.path))
              throw new DomainError(
                'INTEGRATION_WRITE_UNKNOWN',
                '恢复文件的字节或可见权限未经确认；保留意图和写锁',
              );
            record.added.push({ ...after, identity });
          }
          record.intent = null;
          save();
        } finally {
          parent.close();
          slot?.close();
        }
      }
      await current('restoring', true);
      await verifyTarget();
      ready();
      record.phase = 'completed';
      record.pending = packet('completed');
      save();
    } catch (cause) {
      if (record.pending?.sequence === 1) throw cause;
      record.phase = restorationHasMaterial(record) ? 'needs_attention' : 'failed';
      record.pending = packet(record.phase, reason(cause), record.acknowledged === 0 ? 1 : 2);
      save();
    }
    releaseSettled();
    await publish();
    return result();
  } finally {
    oldBackup?.close();
    backup?.close();
    trials?.close();
    lease?.close();
    journal.close();
  }
}
