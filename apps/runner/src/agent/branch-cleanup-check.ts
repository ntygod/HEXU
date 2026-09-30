import { basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { openSync, closeSync, fstatSync, constants as F } from 'node:fs';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  parseBranchCleanupSelection,
  type BranchCleanupInspection,
} from '../../../../packages/contracts/src/branch-cleanup-check.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import {
  restoreBinding,
  restorePrivatePath,
  withRestoreSource,
} from './checkpoint-restore-preflight.js';
import { boundBranchNode, readBranchOrigin, branchOriginHash } from './branch-origin.js';
import { assertBranchEvidenceSettled } from './branch-workspace.js';
import { ExecutionJournal } from './execution-journal.js';
import { assertCodeQuiescent } from './result-code.js';
import { verifyCleanCommit } from './committed-workspace.js';
import { verifySnapshot } from './checkpoint-objects.js';
import { terminalLabel } from './terminal-label.js';
import { PinnedRestoreParent, fdPath, identity } from './checkpoint-restore-files.js';

/** A bounded local observation. Uses the existing node process guard, but creates
 * no cleanup journal, request, lease, publication or deletion permission. */
export async function checkBranchCleanup(
  home: string,
  input: unknown,
  ask: (prompt: string) => Promise<string>,
  log: (message: string) => void = console.log,
) {
  const selection = parseBranchCleanupSelection(input);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '方案清理前核对当前仅支持 Linux 本人节点');
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  const inside = (a: string, b: string) => {
    const r = relative(a, b);
    return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
  };
  if (c.directories.some((w) => [w.root, w.gitDir].some((p) => inside(p, home) || inside(home, p))))
    throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '节点私有状态与代码目录重叠，未检查');
  const storage = new AgentStorage(home);
  try {
    const origin = readBranchOrigin(home),
      bound = boundBranchNode(storage, c);
    if (
      !bound ||
      bound.branchId !== selection.branchId ||
      bound.originHash !== branchOriginHash(origin)
    )
      throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '原方案登记证据不匹配');
    const w = c.directories.find((w) => w.root === origin.plan.target.path);
    if (
      !w ||
      w.rootIdentity !== origin.rootIdentity.split(':').slice(0, 2).join(':') ||
      w.gitIdentity !== origin.gitIdentity.split(':').slice(0, 2).join(':')
    )
      throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '原方案代码目录与本机授权不匹配');
    const verifyIdentity = () => {
      const parent = new PinnedRestoreParent(origin.plan.target);
      let root: number | undefined, git: number | undefined;
      try {
        root = parent.openStage(basename(w.root), origin.rootIdentity);
        git = openSync(fdPath(root, '.git'), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
        if (identity(fstatSync(git, { bigint: true })) !== origin.gitIdentity)
          throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '原Git目录身份已变化');
        parent.revalidate();
      } finally {
        if (git !== undefined) closeSync(git);
        if (root !== undefined) closeSync(root);
        parent.close();
      }
    };
    const stillBound = () => {
      if (
        restorePrivatePath(home, true) !== homeIdentity ||
        restoreBinding(readCredentials(home)) !== binding ||
        branchOriginHash(readBranchOrigin(home)) !== bound.originHash
      )
        throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '原节点、目录或登记证据已变化');
    };
    const inspect = async () => {
      stillBound();
      const view = await nodeRequest<BranchCleanupInspection>(
        c.controlUrl,
        'branch-cleanup-inspect',
        selection,
        c.nodeToken,
      );
      stillBound();
      const r = view?.material?.checkpoint?.request;
      if (
        view?.deletionAuthorized !== false ||
        view.branch?.id !== selection.branchId ||
        view.branch.state !== 'discarded' ||
        view.branch.revision !== selection.expectedRevision ||
        view.taskRevision !== selection.expectedTaskRevision ||
        view.originHash !== bound.originHash ||
        view.nodeId !== c.nodeId ||
        view.branch.workingCopyId !== w.id ||
        view.branch.taskId !== origin.ticket.taskId ||
        view.branch.groupId !== origin.ticket.groupId ||
        r?.nodeId !== c.nodeId ||
        r.workspaceId !== w.id ||
        r.projectId !== c.projectId ||
        r.spaceId !== c.spaceId ||
        view.material.retention.request.id !== selection.retentionId
      )
        throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '当前核对不属于固定方案、目录或副本');
      return view;
    };
    const original = await inspect();
    log(
      `方案 ${terminalLabel(original.branch.name)}\n原工作区 ${terminalLabel(w.root)}\n固定提交 ${original.material.checkpoint.manifest.commit}\n独立副本 ${selection.retentionId}`,
    );
    log(
      '只核对当前完整代码与所选提交、副本、受管占用和本机执行回执。未跟踪/忽略/暂存文件或其他用户修改均阻止通过；不删除文件、不清锁、不解绑，也不证明其他非受管进程已停止。副本不包含Git祖先历史、其他引用或未提交内容。',
    );
    if (
      (await ask(`输入 CHECK_BRANCH ${selection.branchId}：`)) !==
      `CHECK_BRANCH ${selection.branchId}`
    )
      throw new DomainError('CONFIRMATION_REQUIRED', '已取消核对，保留现场');
    const pending = new ExecutionJournal(storage);
    const current = async () => {
      if (canonicalJson(await inspect()) !== canonicalJson(original))
        throw new DomainError(
          'BRANCH_CLEANUP_SCOPE_CHANGED',
          '核对期间方案或副本观察已变化，请重新选择',
        );
      pending.assertCanDisconnect();
      if (storage.pending())
        throw new DomainError(
          'BRANCH_CLEANUP_PENDING',
          '节点仍有待发摘要，请先通过原start确认回执',
        );
      assertBranchEvidenceSettled(home);
      assertCodeQuiescent(home, w.root, w.rootIdentity);
      stillBound();
      verifyIdentity();
    };
    await current();
    await withRestoreSource(home, selection.retentionId, undefined, async (source) => {
      if (
        canonicalJson(source.manifest) !== canonicalJson(original.material.retention.manifest) ||
        canonicalJson(source.ticket) !== canonicalJson(original.material.retention.request)
      )
        throw new DomainError(
          'BRANCH_CLEANUP_MATERIAL_UNAVAILABLE',
          '原本机副本与当前所选材料不一致',
        );
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
        throw new DomainError('SNAPSHOT_INCOMPLETE', '副本完整性不匹配，不能作为保留起点');
      let unchanged = () => {};
      await verifyCleanCommit(home, c, w, original.material.checkpoint.manifest, [], (check) => {
        unchanged = check;
      });
      await source.authorized();
      await current();
      unchanged();
    });
    return {
      kind: 'branch_cleanup_observation' as const,
      branchId: selection.branchId,
      branchRevision: selection.expectedRevision,
      taskRevision: selection.expectedTaskRevision,
      workingCopyId: w.id,
      checkpointId: original.material.checkpoint.id,
      retentionId: selection.retentionId,
      commit: original.material.checkpoint.manifest.commit,
      snapshotHash: original.material.retention.manifest!.snapshotHash,
      observedAt: new Date().toISOString(),
      cleanSnapshotVerified: true,
      retainedSnapshotVerified: true,
      executionAndBindingReceiptsSettled: true,
      managedWorkspaceClaimObserved: false,
      deletionAuthorized: false,
      directoryDeleted: false,
      bindingReleased: false,
      workspaceReserved: false,
      unmanagedProcessesStopped: false,
      scope: 'selected_commit_snapshot_only_not_git_history_or_user_data' as const,
    };
  } finally {
    storage.close();
  }
}
