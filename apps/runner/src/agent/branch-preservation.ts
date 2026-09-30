import { randomUUID } from 'node:crypto';
import { basename, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { openSync, closeSync, fstatSync, lstatSync, constants as F } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import type {
  BranchPreservationView,
  BranchPreservationReport,
  BranchPreservationReceipt,
} from '../../../../packages/contracts/src/branch-preservation.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import {
  restorePrivatePath,
  restoreBinding,
  withRestoreSource,
} from './checkpoint-restore-preflight.js';
import { readBranchOrigin, boundBranchNode, branchOriginHash } from './branch-origin.js';
import { assertBranchEvidenceSettled } from './branch-workspace.js';
import { assertHandoffEvidenceSettled } from './handoff-acceptance.js';
import { assertGitWorkspaceSettled } from './handoff-workspace.js';
import { ExecutionJournal } from './execution-journal.js';
import { assertCodeQuiescent } from './result-code.js';
import { withSettledIntegrationEvidence } from './integration-application.js';
import { withSettledIntegrationTrials } from './integration-trial-journal.js';
import { inspectRestoreTarget } from './checkpoint-restore-plan.js';
import { PinnedRestoreParent, fdPath, identity } from './checkpoint-restore-files.js';
import { verifySnapshot } from './checkpoint-objects.js';
import { verifyCleanCommit } from './committed-workspace.js';
import { WorkspaceLease, workspaceClaimRegistryPath } from '../workspace-lease.js';
import { checkBranchPreserveHelper, preserveBranchDirectory } from './branch-preserve-files.js';
import {
  branchPreservedReleaseReceipt,
  releasePreservedBranchClaim,
} from './branch-preserve-lease.js';
import {
  branchPreservationHash,
  readBranchPreservation,
  saveBranchPreservation,
  type LocalBranchPreservation,
} from './branch-preservation-record.js';
import { terminalLabel } from './terminal-label.js';

const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
function assertDestinationUnoccupied(path: string, originalRoot: string) {
  let registry: string;
  try {
    registry = workspaceClaimRegistryPath(originalRoot);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  const db = new DatabaseSync(registry, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (
      (db.prepare('SELECT root FROM claims').all() as { root: string }[]).some(
        (c) => inside(c.root, path) || inside(path, c.root),
      )
    )
      throw new DomainError(
        'BRANCH_PRESERVE_TARGET_BUSY',
        '保留位置与其他受管或未知占用重叠，未移动',
        409,
      );
  } finally {
    db.close();
  }
}

/** One explicit whole-directory relocation. Existing records only reconcile
 * their fixed evidence/receipts; no restart can call the moving primitive. */
export async function preserveBranchWorkspace(
  home: string,
  id: string,
  target: string,
  ask: (prompt: string) => Promise<string>,
  log: (message: string) => void = console.log,
) {
  nodeId(id);
  if (process.platform !== 'linux')
    throw new DomainError(
      'PLATFORM_UNSUPPORTED',
      '完整目录移出保留目前仅支持Linux同文件系统普通Git目录',
    );
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  if (!isAbsolute(target) || resolve(target) !== target)
    throw new DomainError('INVALID_INPUT', '保留目标必须是规范的绝对新目录');
  if (
    c.directories
      .flatMap((w) => [w.root, w.gitDir])
      .some((path) => inside(home, path) || inside(path, home))
  )
    throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '节点私有状态不能与代码重叠');
  const storage = new AgentStorage(home);
  let lease: WorkspaceLease | undefined;
  try {
    const stillBound = () => {
      if (
        restorePrivatePath(home, true) !== homeIdentity ||
        restoreBinding(readCredentials(home)) !== binding
      )
        throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '原节点身份或授权目录已变化');
    };
    const inspect = async () => {
      stillBound();
      const v = await nodeRequest<BranchPreservationView>(
        c.controlUrl,
        'branch-preservation-inspect',
        { preservationId: id },
        c.nodeToken,
      );
      stillBound();
      const r = v?.request;
      if (
        !r ||
        r.id !== id ||
        r.version !== 1 ||
        r.kind !== 'preserve_complete_branch_directory' ||
        r.nodeId !== c.nodeId ||
        r.spaceId !== c.spaceId ||
        r.projectId !== c.projectId ||
        branchPreservationHash({ ...r, inputHash: '' }) !== r.inputHash ||
        !c.directories.some((w) => w.id === r.scope.branch.workingCopyId)
      )
        throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '原移出请求或本人节点范围不匹配');
      return v;
    };
    const original = await inspect(),
      request = original.request,
      w = c.directories.find((w) => w.id === request.scope.branch.workingCopyId)!;
    let p = readBranchPreservation(storage, id, request, c);
    const save = () => saveBranchPreservation(storage, p!);
    const deliver = async () => {
      if (!p!.pending) return;
      if (
        p!.pending.sequence === 2 &&
        p!.claimAcquired &&
        p!.outcome &&
        (!p!.releaseRequest ||
          canonicalJson(branchPreservedReleaseReceipt(p!.releaseRequest)) !==
            canonicalJson(p!.releaseReceipt))
      )
        throw new DomainError(
          'BRANCH_PRESERVE_ACK_UNKNOWN',
          '缺少精确原占用结算收据，未共享完成声明',
        );
      const packet = p!.pending,
        ack = await nodeRequest<BranchPreservationReceipt>(
          c.controlUrl,
          'branch-preservation-publish',
          packet,
          c.nodeToken,
        );
      if (
        ack?.preservationId !== id ||
        ack.acceptedSequence !== packet.sequence ||
        ack.reportHash !== branchPreservationHash(packet)
      )
        throw new DomainError(
          'BRANCH_PRESERVE_ACK_UNKNOWN',
          '原保留报告回执不匹配；只可核对原包，不能重复移动',
        );
      p!.acknowledged = packet.sequence;
      p!.acknowledgedHash = ack.reportHash;
      p!.pending = null;
      if (packet.sequence === 2 && p!.outcome) p!.phase = 'settled';
      save();
    };
    const makePacket = (
      stage: BranchPreservationReport['stage'],
      reason: BranchPreservationReport['reason'],
    ): BranchPreservationReport => ({
      version: 1,
      kind: 'branch_directory_preservation',
      preservationId: id,
      inputHash: request.inputHash,
      sequence: p!.acknowledged === 0 ? 1 : 2,
      stage,
      reason,
      evidenceHash: branchPreservationHash({
        request: request.inputHash,
        binding,
        source: p!.sourceObservation,
        destination: p!.destination,
        rootIdentity: p!.rootIdentity,
        gitIdentity: p!.gitIdentity,
        stoppedConfirmedAt: p!.stoppedConfirmedAt,
        helperOutcome: p!.helperOutcome,
        outcome: p!.outcome,
        intent: p!.intent,
        observedAt: p!.observedAt,
        releaseReceipt: p!.releaseReceipt,
      }),
      destinationRef: p!.destinationRef,
      observedAt: new Date().toISOString(),
      confirmPublication: true,
    });
    const settle = async () => {
      if (!p!.outcome || !p!.observedAt)
        throw new DomainError('BRANCH_PRESERVE_UNKNOWN', '未知移动不能自动结算');
      if (p!.claimAcquired) {
        if (!p!.releaseRequest) {
          p!.releaseRequest = {
            version: 1,
            kind: 'branch_directory_preservation_settlement',
            outcome: p!.outcome,
            preservationId: id,
            claimId: 'branch-preserve:' + id,
            root: p!.root,
            destination: p!.destination.path,
            rootIdentity: p!.rootIdentity,
            gitIdentity: p!.gitIdentity,
            evidenceHash: branchPreservationHash({
              request: request.inputHash,
              destination: p!.destination,
              root: p!.root,
              rootIdentity: p!.rootIdentity,
              gitIdentity: p!.gitIdentity,
              outcome: p!.outcome,
              observedAt: p!.observedAt,
              helperOutcome: p!.helperOutcome,
            }),
            stoppedConfirmedAt: p!.stoppedConfirmedAt,
            observedAt: p!.observedAt,
          };
          save();
        }
        if (!p!.releaseReceipt) {
          const recorded = branchPreservedReleaseReceipt(p!.releaseRequest);
          if (recorded) p!.releaseReceipt = recorded;
          else {
            const source = new PinnedRestoreParent(p!.sourceObservation);
            let destination: PinnedRestoreParent | null = null,
              root: number | undefined,
              git: number | undefined;
            try {
              const parent =
                p!.outcome === 'preserved'
                  ? (destination = new PinnedRestoreParent(p!.destination))
                  : source;
              root = parent.openStage(
                basename(p!.outcome === 'preserved' ? target : p!.root),
                p!.rootIdentity,
              );
              git = openSync(fdPath(root, '.git'), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
              p!.releaseReceipt = releasePreservedBranchClaim(
                p!.releaseRequest,
                source,
                destination,
                root,
                git,
              );
            } finally {
              if (git !== undefined) closeSync(git);
              if (root !== undefined) closeSync(root);
              destination?.close();
              source.close();
            }
          }
          save();
        }
      }
      if (!p!.pending && p!.acknowledged !== 2) {
        p!.pending = makePacket(
          p!.outcome === 'preserved' ? 'preserved' : 'failed',
          p!.outcome === 'preserved' ? 'directory_preserved' : 'move_refused',
        );
        save();
      }
      await deliver();
      return p!;
    };
    const noMove = async () => {
      p!.intent = false;
      p!.outcome = 'not_moved';
      p!.observedAt = new Date().toISOString();
      p!.phase = 'known_outcome';
      save();
      return settle();
    };
    const unknown = async (reason: 'interrupted' | 'move_unknown') => {
      p!.phase = 'needs_attention';
      p!.pending = makePacket('needs_attention', reason);
      save();
      await deliver();
      return p!;
    };
    if (p) {
      if (
        p.acknowledged &&
        original.reports.find((x) => x.report.sequence === p!.acknowledged)?.hash !==
          p.acknowledgedHash
      )
        throw new DomainError('BRANCH_PRESERVE_ACK_UNKNOWN', '原持久回执与服务不可变历史不一致');
      if (p.destination.path !== target)
        throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '原请求不能改投另一个保留位置');
      log('仅核对原移出记录与固定报告；本次不会重新移动、覆盖或删除任何目录。');
      if (p.phase === 'settled') return p;
      if (
        original.state === 'cancelled' &&
        p.phase === 'prepared' &&
        !p.intent &&
        !p.claimAcquired &&
        p.acknowledged === 0
      ) {
        p.pending = null;
        p.outcome = 'not_moved';
        p.observedAt = new Date().toISOString();
        p.cancelled = true;
        p.phase = 'settled';
        save();
        return p;
      }
      await deliver();
      if (p.outcome) return await settle();
      if (p.phase === 'needs_attention') return p;
      if (
        p.phase === 'prepared' ||
        p.helperOutcome === 'not_moved' ||
        (!p.intent && p.claimAcquired)
      )
        return await noMove();
      return await unknown('interrupted');
    }
    if (!original.canBegin || original.state !== 'requested')
      throw new DomainError(
        'BRANCH_PRESERVE_UNAVAILABLE',
        original.unavailableReason ?? '原请求不能开始移出',
        409,
      );
    const origin = readBranchOrigin(home, request.scope.originHash),
      bound = boundBranchNode(storage, c);
    if (
      !bound ||
      bound.branchId !== request.branchId ||
      origin.plan.target.path !== w.root ||
      w.gitDir !== join(w.root, '.git') ||
      branchOriginHash(origin) !== request.scope.originHash
    )
      throw new DomainError(
        'BRANCH_PRESERVE_SCOPE_CHANGED',
        '需要原已登记普通Git目录；linked worktree不支持',
      );
    assertBranchEvidenceSettled(home);
    assertHandoffEvidenceSettled(home);
    assertGitWorkspaceSettled(home);
    const destination = inspectRestoreTarget(target, [
      home,
      ...c.directories.flatMap((w) => [w.root, w.gitDir]),
      join(homedir(), '.hexu', 'workspace-leases'),
    ]);
    checkBranchPreserveHelper();
    return await withSettledIntegrationEvidence(home, () =>
      withSettledIntegrationTrials(home, async () => {
        const sourceParent = new PinnedRestoreParent(origin.plan.target);
        let root: number | undefined,
          git: number | undefined,
          allocatedTarget: PinnedRestoreParent | undefined;
        try {
          const targetParent = new PinnedRestoreParent(destination);
          allocatedTarget = targetParent;
          root = sourceParent.openStage(basename(w.root), origin.rootIdentity);
          git = openSync(fdPath(root, '.git'), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
          if (
            identity(fstatSync(git, { bigint: true })) !== origin.gitIdentity ||
            fstatSync(root).dev !== fstatSync(targetParent.fd).dev ||
            fstatSync(targetParent.fd).mode & 0o077
          )
            throw new DomainError(
              'BRANCH_PRESERVE_SCOPE_CHANGED',
              '需原Git身份与同文件系统的本人私有保留父目录，不改权限或跨盘复制',
            );
          log(
            `方案 ${terminalLabel(request.scope.branch.name)}\n原目录 ${terminalLabel(w.root)}\n新保留位置 ${terminalLabel(target)}\n固定提交 ${request.scope.material.checkpoint.manifest.commit}`,
          );
          log(
            '将整个原目录连同.git和所有内容移出并保留，不永久删除；原路径停止作为执行现场，新位置不会自动登记或共享。必须停止原节点、全部子进程/孤儿进程及其他写入者；未保存修改仍阻止移动。',
          );
          if (
            (await ask(`输入 STOPPED_AND_PRESERVE ${id}，确认全部写入者已停止：`)) !==
            `STOPPED_AND_PRESERVE ${id}`
          )
            throw new DomainError('CONFIRMATION_REQUIRED', '未确认全部写入者停止，没有移动');
          const stoppedConfirmedAt = new Date().toISOString();
          if (
            (await ask(`输入 PRESERVE ${id}，将上面的完整原目录移入已显示的新位置：`)) !==
            `PRESERVE ${id}`
          )
            throw new DomainError('CONFIRMATION_REQUIRED', '未同意本次完整目录移出保留');
          const execution = new ExecutionJournal(storage);
          const current = async () => {
            const v = await inspect();
            if (
              v.request.inputHash !== request.inputHash ||
              !v.canBegin ||
              !['requested', 'moving'].includes(v.state)
            )
              throw new DomainError(
                'BRANCH_PRESERVE_UNAVAILABLE',
                v.unavailableReason ?? '原请求或权限已变化',
                409,
              );
            execution.assertCanDisconnect();
            if (storage.pending())
              throw new DomainError('BRANCH_PRESERVE_PENDING', '先确认原节点摘要回执');
            stillBound();
            if (branchOriginHash(readBranchOrigin(home)) !== request.scope.originHash)
              throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '原登记证据已变化');
            assertCodeQuiescent(
              home,
              w.root,
              w.rootIdentity,
              lease ? 'branch-preserve:' + id : undefined,
            );
            assertDestinationUnoccupied(target, w.root);
            sourceParent.revalidate();
            targetParent.revalidate();
            targetParent.assertAbsent();
            if (
              identity(lstatSync(fdPath(sourceParent.fd, basename(w.root)), { bigint: true })) !==
                origin.rootIdentity ||
              identity(lstatSync(fdPath(root!, '.git'), { bigint: true })) !== origin.gitIdentity
            )
              throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '原根或Git目录已变化');
          };
          await withRestoreSource(
            home,
            request.selection.retentionId,
            undefined,
            async (source) => {
              if (
                canonicalJson(source.manifest) !==
                canonicalJson(request.scope.material.retention.manifest)
              )
                throw new DomainError('SNAPSHOT_INCOMPLETE', '原副本指纹已变化');
              const snapshot = await source.snapshot((read) =>
                verifySnapshot(
                  source.manifest.objectFormat,
                  source.manifest.commit,
                  source.manifest.tree,
                  read,
                ),
              );
              if (
                snapshot.snapshotHash !== source.manifest.snapshotHash ||
                canonicalJson(snapshot.coverage) !== canonicalJson(source.manifest.coverage)
              )
                throw new DomainError('SNAPSHOT_INCOMPLETE', '独立副本不完整');
              await verifyCleanCommit(home, c, w, request.scope.material.checkpoint.manifest);
              await current();
              p = {
                version: 1,
                kind: 'branch_directory_preservation',
                id,
                binding,
                request,
                root: w.root,
                sourceObservation: origin.plan.target,
                destination,
                rootIdentity: origin.rootIdentity,
                gitIdentity: origin.gitIdentity,
                destinationRef: randomUUID(),
                stoppedConfirmedAt,
                phase: 'prepared',
                intent: false,
                helperOutcome: null,
                claimAcquired: false,
                outcome: null,
                observedAt: null,
                releaseRequest: null,
                releaseReceipt: null,
                pending: null,
                acknowledged: 0,
                acknowledgedHash: null,
                cancelled: false,
              };
              p.pending = makePacket('moving', 'move_prepared');
              save();
              await deliver();
              p.phase = 'moving';
              save();
              try {
                lease = new WorkspaceLease(w.root, 'branch-preserve:' + id);
                p.claimAcquired = true;
                save();
              } catch (cause) {
                if (cause instanceof DomainError && cause.code === 'LOCAL_WORKSPACE_BUSY') {
                  await noMove();
                  return;
                }
                throw cause;
              }
              let unchanged = () => {};
              await verifyCleanCommit(
                home,
                c,
                w,
                request.scope.material.checkpoint.manifest,
                [],
                (check) => {
                  unchanged = check;
                },
              );
              await source.authorized();
              await current();
              lease.assertHeld();
              unchanged();
              p.intent = true;
              save();
              const outcome = preserveBranchDirectory(
                sourceParent,
                targetParent,
                root!,
                git!,
                origin.rootIdentity,
                origin.gitIdentity,
              );
              p.helperOutcome = outcome;
              save();
              if (outcome === 'not_moved') {
                await noMove();
                return;
              }
              if (outcome === 'unknown') {
                await unknown('move_unknown');
                return;
              }
              const relocated = { ...w, root: target, gitDir: join(target, '.git') };
              let unchangedAfterMove = () => {};
              await verifyCleanCommit(
                home,
                c,
                relocated,
                request.scope.material.checkpoint.manifest,
                [],
                (check) => {
                  unchangedAfterMove = check;
                },
              );
              await source.authorized();
              const latest = await inspect();
              if (latest.request.inputHash !== request.inputHash)
                throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '原请求身份发生变化');
              sourceParent.revalidate();
              targetParent.revalidate();
              if (
                identity(lstatSync(target, { bigint: true })) !== origin.rootIdentity ||
                identity(lstatSync(join(target, '.git'), { bigint: true })) !== origin.gitIdentity
              )
                throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '移出后的原目录身份未确认');
              unchangedAfterMove();
              p.intent = false;
              p.outcome = 'preserved';
              p.observedAt = new Date().toISOString();
              p.phase = 'known_outcome';
              save();
              await settle();
            },
          );
          return p!;
        } catch (cause) {
          if (p && p.acknowledged === 1 && !p.pending && !p.outcome) {
            try {
              if (!p.intent && p.claimAcquired) await noMove();
              else await unknown('move_unknown');
            } catch {
              /* retain exact intent/packet and claim */
            }
          }
          throw cause;
        } finally {
          if (git !== undefined) closeSync(git);
          if (root !== undefined) closeSync(root);
          allocatedTarget?.close();
          sourceParent.close();
        }
      }),
    );
  } finally {
    lease?.close();
    storage.close();
  }
}
