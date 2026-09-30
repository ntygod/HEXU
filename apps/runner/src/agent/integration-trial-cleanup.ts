import { closeSync, fstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { readCredentials } from './storage.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import {
  checkOwnedTree,
  PinnedRestoreParent,
  removeOwnedStage,
} from './checkpoint-restore-files.js';
import {
  integrationTrialCleanupEvidence,
  IntegrationTrialJournal,
} from './integration-trial-journal.js';
import { terminalLabel } from './terminal-label.js';
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
const refused = () =>
  new DomainError(
    'INTEGRATION_TRIAL_CLEANUP_REFUSED',
    '仅可清理原身份下归属完整、未发布且没有未决意图的失败暂存；其他现场和原证据保持',
  );
/** Explicit disposal of a known private stage, not trial replay, target recovery,
 * material access or a workspace-claim release. No service/network/Git/model call. */
export async function cleanupIntegrationTrial(
  home: string,
  integrationId: string,
  trialId: string,
  ask: (prompt: string) => Promise<string>,
  log: (message: string) => void = console.log,
) {
  nodeId(integrationId);
  nodeId(trialId);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '暂存处置只支持 Linux 本人节点');
  home = resolve(home);
  // Never initialize a missing journal or adopt another node's records.
  const privatePaths = [
    home,
    join(home, 'integration-trials'),
    join(home, 'integration-trials', 'journal.sqlite'),
    join(home, 'credentials.json'),
  ];
  const identities = privatePaths.map((p, i) => restorePrivatePath(p, i < 2));
  const credentials = readCredentials(home),
    binding = restoreBinding(credentials);
  const protectedPaths = [home, ...credentials.directories.flatMap((w) => [w.root, w.gitDir])];
  if (protectedPaths.slice(1).some((p) => inside(home, p) || inside(p, home))) throw refused();
  const journal = new IntegrationTrialJournal(home);
  let parent: PinnedRestoreParent | undefined, stage: number | undefined;
  const bound = () => {
    journal.stillBound();
    if (
      privatePaths.some((p, i) => restorePrivatePath(p, i < 2) !== identities[i]) ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError(
        'INTEGRATION_TRIAL_SCOPE_CHANGED',
        '原本机身份、日志或目录登记变化，保留现场',
      );
  };
  try {
    bound();
    const record = journal.byId(trialId),
      p = record?.progress;
    if (!record || !p || record.binding !== binding || p.integrationId !== integrationId)
      throw refused();
    // A verified receipt is historical; don't touch a later occupant or require
    // the old stage to still exist. The original context/ledger remain intact.
    if (p.cleanup?.phase === 'cleaned')
      return { ...p, historical: true, currentMaterialAvailable: null };
    if (
      p.cleanup ||
      !['failed', 'interrupted'].includes(p.state) ||
      p.materialState !== 'staging' ||
      !p.stageIdentity ||
      p.intent !== null ||
      p.publishedAt !== null ||
      journal.difference(record)
    )
      throw refused();
    const stagePath = join(dirname(p.target), p.stageName);
    if (
      protectedPaths.some(
        (path) =>
          inside(path, p.target) ||
          inside(p.target, path) ||
          inside(path, stagePath) ||
          inside(stagePath, path),
      )
    )
      throw refused();
    const owned = journal.entries(p.id);
    parent = new PinnedRestoreParent(
      record.observation,
      credentials.directories.flatMap((w) => [w.rootIdentity, w.gitIdentity]),
    );
    parent.assertAbsent();
    stage = parent.openStage(p.stageName, p.stageIdentity);
    const verifyStage = () => {
      const root = fstatSync(stage!, { bigint: true });
      if (root.uid !== BigInt(process.getuid!()) || (root.mode & 0o777n) !== 0o700n)
        throw refused();
      checkOwnedTree(stage!, owned);
    };
    verifyStage();
    log(
      `试应用 ${p.id} · 原整合 ${p.integrationId}\n失败阶段 ${p.state} / ${p.materialState}\n本次未发布暂存 ${terminalLabel(stagePath)}\n原候选目标（不会删除）${terminalLabel(p.target)}\n精确归属 ${owned.size} 项，已记录 ${p.completedFiles} 个文件 / ${p.writtenBytes} 字节\n只永久删除这份归属已核对的未发布暂存，保留原日志、所有权记录、原代码、对象副本与已发布候选。`,
    );
    if (
      (await ask(
        `请确认原试应用及全部子进程、遗留孤儿进程和其他暂存写入者均已停止，并永久删除上述暂存。输入 STOPPED_AND_CLEAN ${p.id}：`,
      )) !== `STOPPED_AND_CLEAN ${p.id}`
    )
      throw new DomainError('CONFIRMATION_REQUIRED', '未明确确认停止与暂存删除，文件保持');
    bound();
    parent.revalidate();
    parent.assertAbsent();
    verifyStage();
    const evidence = integrationTrialCleanupEvidence(record);
    p.cleanup = {
      version: 1,
      kind: 'discard_known_unpublished_trial_stage',
      phase: 'cleaning',
      originalEvidenceHash: evidence,
      stoppedConfirmedAt: new Date().toISOString(),
      completedAt: null,
    };
    journal.save(record); // Durable intent before the first unlink; no automatic retry.
    try {
      bound();
      parent.revalidate();
      parent.assertAbsent();
      removeOwnedStage(parent, p.stageName, stage, p.stageIdentity, owned, () => {
        bound();
      });
      // Keep original state/material/counters/ownership as history. Only this
      // separately bound disposal receipt permits the current credential guard.
      p.cleanup.phase = 'cleaned';
      p.cleanup.completedAt = new Date().toISOString();
      journal.save(record);
      return { ...p, historical: false, currentMaterialAvailable: null };
    } catch (cause) {
      p.cleanup.phase = 'needs_attention';
      p.cleanup.completedAt = null;
      journal.save(record); // If this also fails, the earlier cleaning intent blocks credentials.
      throw cause;
    }
  } finally {
    if (stage !== undefined) closeSync(stage);
    parent?.close();
    journal.close();
  }
}
