import {
  constants as F,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  writeSync,
  fsyncSync,
  lstatSync,
} from 'node:fs';
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { RETENTION_LIMITS } from '../../../../packages/contracts/src/checkpoint-retention.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { readCredentials } from './storage.js';
import { buildRestorePlan, inspectRestoreTarget } from './checkpoint-restore-plan.js';
import {
  withRestoreSource,
  restoreBinding,
  restorePrivatePath,
  type RestoreMaterialSource,
} from './checkpoint-restore-preflight.js';
import { objectHash } from './checkpoint-objects.js';
import {
  fdPath,
  identity,
  PinnedRestoreParent,
  checkRestoreHelper,
  ownedEntry,
  withOwnedDirectory,
  checkOwnedTree,
  readOwnedFile,
  publishRestore,
  removeOwnedStage,
} from './checkpoint-restore-files.js';
import {
  RestoreJournal,
  restoreProgressFromRow,
  type RestoreProgress,
  type RestorePlan,
} from './checkpoint-restore-journal.js';

type Ask = (prompt: string) => Promise<string>;
export interface RestoreOptions {
  sourceKind?: 'retention' | 'transfer';
  signal?: AbortSignal;
  log?: (message: string) => void;
  onProgress?: (progress: Readonly<RestoreProgress>) => void | Promise<void>;
}
const within = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
};
function outsideSources(home: string, roots: string[]) {
  if (roots.some((p) => within(home, p) || within(p, home)))
    throw new DomainError(
      'RESTORE_TARGET_OVERLAP',
      '节点状态目录与原授权来源重叠，不能写入恢复日志',
    );
}
export function verifyRestoreFiles(
  stage: number,
  plan: RestorePlan,
  journal: RestoreJournal,
  progress: RestoreProgress,
  gitMetadata?: { name: '.git'; identity: string },
) {
  const owned = journal.entries(progress.id);
  checkOwnedTree(stage, owned, gitMetadata);
  if (owned.size !== plan.entries.length)
    throw new DomainError('RESTORE_INCOMPLETE', '暂存清单与计划不一致');
  for (const e of plan.entries) {
    const row = owned.get(e.path);
    if (!row || row.kind !== e.kind) throw new DomainError('RESTORE_INCOMPLETE', '暂存文件缺失');
    if (e.kind === 'file') {
      const data = readOwnedFile(stage, row, owned, e.bytes);
      if (
        data.length !== e.bytes ||
        objectHash(plan.source.manifest.objectFormat, 'blob', data) !== e.objectId
      )
        throw new DomainError('RESTORE_INCOMPLETE', '暂存文件字节与原始对象不一致');
    }
  }
  fsyncSync(stage);
}

/** A local filesystem operation only. It does not create a Task/Run, grant model
 * execution, upload filenames, or accept a Handoff. Repeated target => evidence only. */
export async function localRestoreCheckpoint(
  home: string,
  id: string,
  target: string,
  ask: Ask,
  options: RestoreOptions = {},
): Promise<RestoreProgress> {
  const log = options.log ?? console.log;
  const openSource =
    options.sourceKind === 'transfer'
      ? (await import('./checkpoint-received-source.js')).withReceivedRestoreSource
      : withRestoreSource;
  return openSource(home, id, options.signal, async (source: RestoreMaterialSource) => {
    await source.authorized();
    outsideSources(source.home, source.protectedPaths.slice(1));
    checkRestoreHelper();
    const journal = new RestoreJournal(source.home);
    let parent: PinnedRestoreParent | undefined;
    let stage: number | undefined;
    let progress: RestoreProgress | undefined;
    let publicationAttempted = false;
    let stageCreationAttempted = false;
    const stageUnchanged = () => {
      if (
        parent &&
        progress?.stageIdentity &&
        identity(lstatSync(fdPath(parent.fd, progress.stageName), { bigint: true })) !==
          progress.stageIdentity
      )
        throw new DomainError('RESTORE_FILES_CHANGED', '暂存目录已被移动或替换，未继续写入');
    };
    const update = async () => {
      journal.save(progress!);
      await options.onProgress?.({ ...progress! });
      await setImmediate(); // Permit SIGINT/TERM between bounded disk writes.
    };
    try {
      const existing = journal.row(target);
      if (existing) {
        if (
          existing.binding !== source.binding ||
          restoreProgressFromRow(existing).requestId !== id ||
          (JSON.parse(existing.plan) as RestorePlan).source.kind !== source.planSource.kind
        )
          throw new DomainError(
            'RESTORE_TARGET_CLAIMED',
            '目标已属于另一份本机恢复记录，未重新写入',
          );
        log('此目标已有恢复记录，只返回最后记录，不重新执行或确认新的发布。');
        return restoreProgressFromRow(existing);
      }
      const observation = inspectRestoreTarget(target, source.protectedPaths);
      log(
        `${source.planSource.kind === 'transfer' ? '接收传输' : '保留请求'} ${id} · 提交 ${source.manifest.commit} · 到期 ${source.manifest.expiresAt}`,
      );
      log(`目标 ${target}`);
      log(
        '将写入私有暂存目录，核验后还需单独确认发布；只恢复该提交的普通文件/目录，可能包含已提交的敏感内容。失败/取消保留暂存供明确清理，不修改源仓库，不运行脚本/模型。',
      );
      if ((await ask(`输入 RESTORE ${id}：`)) !== `RESTORE ${id}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '未同意本次写入，没有创建恢复目录');
      const build = () =>
        source.snapshot((read) =>
          buildRestorePlan(source.planSource, read, target, source.protectedPaths, options.signal),
        );
      const plan = await build();
      if (canonicalJson(plan.target) !== canonicalJson(observation))
        throw new DomainError('RESTORE_TARGET_CHANGED', '确认期间父目录发生变化，未写入');
      parent = new PinnedRestoreParent(plan.target, source.protectedIdentities);
      await source.authorized();
      parent.revalidate();
      parent.assertAbsent();
      progress = journal.begin(plan, source.binding);
      await options.onProgress?.({ ...progress });
      source.stillBound();
      // Journal the intent before mkdir. A crash in the following gap remains unknown.
      stageCreationAttempted = true;
      stage = parent.createStage(progress.stageName);
      progress.stageIdentity = identity(fstatSync(stage, { bigint: true }));
      progress.state = 'writing';
      progress.materialState = 'staging';
      progress.cleanup = 'retained';
      await update();
      const owned = journal.entries(progress.id);
      const deadline = Date.now() + 120000;
      await source.snapshot(async (read) => {
        for (const e of plan.entries) {
          source.stillBound();
          parent!.revalidate();
          stageUnchanged();
          if (Date.now() > deadline)
            throw new DomainError('RESTORE_LIMIT', '本次写入超过时间边界，暂存未发布');
          let data: Buffer | undefined;
          if (e.kind === 'file') {
            data = await read(e.objectId, 'blob', RETENTION_LIMITS.blob);
            if (
              data.length !== e.bytes ||
              objectHash(source.manifest.objectFormat, 'blob', data) !== e.objectId
            )
              throw new DomainError('SNAPSHOT_INCOMPLETE', '持久文件对象损坏，不回源修补');
          }
          withOwnedDirectory(
            stage!,
            dirname(e.path) === '.' ? '' : dirname(e.path),
            owned,
            (fd) => {
              let child: number;
              const path = fdPath(fd, basename(e.path));
              if (e.kind === 'directory') {
                mkdirSync(path, { mode: 0o700 });
                child = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
              } else
                child = openSync(path, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
              try {
                const initial = ownedEntry(e.path, e.kind, child);
                journal.track(progress!.id, initial);
                owned.set(e.path, initial);
                if (data) {
                  let offset = 0;
                  while (offset < data.length) {
                    const written = writeSync(child, data, offset, data.length - offset);
                    if (!written) throw new Error('Short write');
                    offset += written;
                  }
                  fchmodSync(child, e.gitMode === '100755' ? 0o700 : 0o600);
                }
                fsyncSync(child);
                fsyncSync(fd);
              } finally {
                // Preserve actual partial-write metadata too. If journalling fails,
                // cleanup will refuse the unmatched object rather than guessing ownership.
                try {
                  const actual = ownedEntry(e.path, e.kind, child);
                  journal.track(progress!.id, actual);
                  owned.set(e.path, actual);
                } finally {
                  closeSync(child);
                }
              }
            },
          );
          if (e.kind === 'file') {
            progress!.completedFiles++;
            progress!.writtenBytes += e.bytes;
          }
          await update();
        }
      });
      stageUnchanged();
      verifyRestoreFiles(stage, plan, journal, progress);
      progress.state = 'verified';
      progress.verifiedAt = new Date().toISOString();
      await update();
      log(
        `暂存已核验：${progress.completedFiles} 个文件 / ${progress.writtenBytes} 字节；目标尚未创建。计划 ${plan.planHash}`,
      );
      if ((await ask(`输入 PUBLISH ${progress.id}：`)) !== `PUBLISH ${progress.id}`)
        throw new DomainError('RESTORE_CANCELLED', '未确认发布，已保留本次暂存');
      // Release all SQLite read transactions during the prompt, then independently
      // re-read/hash durable source objects and compare the exact original plan.
      const latest = await build();
      if (latest.planHash !== plan.planHash)
        throw new DomainError('RESTORE_PLAN_CHANGED', '原恢复计划已变化，未发布');
      await source.authorized();
      parent.revalidate();
      parent.assertAbsent();
      stageUnchanged();
      verifyRestoreFiles(stage, plan, journal, progress);
      progress.state = 'publishing';
      await update();
      // This final hook-free authorization/path check precedes the single native
      // no-replace rename. No filesystem-mutating retries or copy fallback.
      await source.authorized();
      parent.revalidate();
      parent.assertAbsent();
      source.stillBound();
      stageUnchanged();
      verifyRestoreFiles(stage, plan, journal, progress);
      publicationAttempted = true;
      const result = publishRestore(parent, progress.stageName, stage);
      if (result === 'not_published') {
        publicationAttempted = false;
        throw new DomainError(
          'RESTORE_PUBLISH_REFUSED',
          '排他发布被拒绝，目标没有被覆盖；暂存保留',
        );
      }
      if (result === 'unknown')
        throw new DomainError(
          'RESTORE_PUBLICATION_UNKNOWN',
          '发布或磁盘同步结果未确认，保留证据，不重试或删除目标',
        );
      progress.materialState = 'published';
      progress.cleanup = 'not_needed';
      // Confirm the named directory is still the pinned stage. A changed ancestor
      // or replaced target is not a successfully delivered path.
      parent.revalidate();
      if (
        identity(lstatSync(fdPath(parent.fd, basename(target)), { bigint: true })) !==
        progress.stageIdentity
      )
        throw new DomainError('RESTORE_PUBLICATION_UNKNOWN', '发布后的目标身份发生变化');
      progress.state = 'restored';
      progress.errorCode = null;
      journal.save(progress);
      return progress;
    } catch (cause) {
      if (!progress) throw cause;
      const cancelled =
        options.signal?.aborted ||
        (cause instanceof DomainError &&
          ['RESTORE_CANCELLED', 'RESTORE_PLAN_CANCELLED'].includes(cause.code));
      progress.state = publicationAttempted ? 'interrupted' : cancelled ? 'cancelled' : 'failed';
      progress.errorCode = publicationAttempted
        ? 'RESTORE_PUBLICATION_UNKNOWN'
        : cancelled
          ? 'RESTORE_CANCELLED'
          : cause instanceof DomainError
            ? cause.code
            : 'RESTORE_IO_FAILED';
      if (!stageCreationAttempted) {
        progress.materialState = 'none';
        progress.cleanup = 'not_needed';
      } else if (publicationAttempted || !progress.stageIdentity) {
        progress.materialState = 'unknown';
        progress.cleanup = 'needs_attention';
      }
      journal.save(progress); // If storage itself fails, leave the prior durable intent.
      return progress;
    } finally {
      if (stage !== undefined) closeSync(stage);
      parent?.close();
      journal.close();
    }
  });
}

/** Explicit local cleanup can run after expiry/revocation/offline: it is disposal,
 * not renewed source access. Only the original credential binding can use it. */
export async function cleanupRestoreCheckpoint(
  home: string,
  target: string,
  ask: Ask,
): Promise<RestoreProgress> {
  home = resolve(home);
  restorePrivatePath(home, true);
  const c = readCredentials(home),
    binding = restoreBinding(c);
  outsideSources(
    home,
    c.directories.flatMap((w) => [w.root, w.gitDir]),
  );
  restorePrivatePath(join(home, 'checkpoint-restores'), true); // Never initialize a missing record.
  restorePrivatePath(join(home, 'checkpoint-restores', 'journal.sqlite'), false);
  const journal = new RestoreJournal(home);
  let parent: PinnedRestoreParent | undefined, stage: number | undefined;
  try {
    const row = journal.row(target);
    if (!row || row.binding !== binding)
      throw new DomainError('RESTORE_NOT_AVAILABLE', '没有属于当前原身份的恢复记录');
    const progress = restoreProgressFromRow(row);
    if (progress.cleanup === 'cleaned') return progress;
    if (
      progress.state === 'restored' ||
      progress.materialState === 'published' ||
      !progress.stageIdentity
    )
      throw new DomainError('RESTORE_CLEANUP_REFUSED', '已发布或暂存归属未确认，不能清理目标');
    if (
      (await ask(`仅删除本次暂存，不删除目标；输入 CLEAN ${progress.id}：`)) !==
      `CLEAN ${progress.id}`
    )
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认清理，文件保持不变');
    if (restoreBinding(readCredentials(home)) !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '本机身份变化，未清理');
    const plan = JSON.parse(row.plan) as RestorePlan;
    parent = new PinnedRestoreParent(
      plan.target,
      c.directories.flatMap((w) => [w.rootIdentity, w.gitIdentity]),
    );
    stage = parent.openStage(progress.stageName, progress.stageIdentity);
    progress.cleanup = 'cleaning';
    journal.save(progress);
    try {
      removeOwnedStage(
        parent,
        progress.stageName,
        stage,
        progress.stageIdentity,
        journal.entries(progress.id),
        (path) => journal.untrack(progress.id, path),
      );
      progress.materialState = 'none';
      progress.cleanup = 'cleaned';
      journal.save(progress);
      return progress;
    } catch (cause) {
      progress.cleanup = 'needs_attention';
      journal.save(progress);
      throw cause;
    }
  } finally {
    if (stage !== undefined) closeSync(stage);
    parent?.close();
    journal.close();
  }
}
