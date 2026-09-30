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
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  INTEGRATION_LIMITS,
  parseIntegrationReport,
  type IntegrationView,
} from '../../../../packages/contracts/src/integrations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import {
  restoreBinding,
  restorePrivatePath,
  withRestoreSource,
  type RestoreMaterialSource,
} from './checkpoint-restore-preflight.js';
import { withReceivedRestoreSource } from './checkpoint-received-source.js';
import { objectHash, verifySnapshot } from './checkpoint-objects.js';
import { captureCommitReference } from './checkpoints.js';
import { verifyCleanCommit } from './committed-workspace.js';
import { assertCodeQuiescent } from './result-code.js';
import { inspectRestoreTarget } from './checkpoint-restore-plan.js';
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
} from './checkpoint-restore-files.js';
import { buildIntegrationTrialPlan, type IntegrationTrialPlan } from './integration-trial-plan.js';
import {
  IntegrationTrialJournal,
  trialHash,
  type IntegrationTrialProgress,
  type IntegrationTrialRecord,
} from './integration-trial-journal.js';
import { terminalLabel } from './terminal-label.js';

export interface IntegrationTrialOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
  onProgress?: (progress: Readonly<IntegrationTrialProgress>) => void | Promise<void>;
}
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
export function integrationTrialSelection(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > INTEGRATION_LIMITS.files ||
    value.some(
      (p) =>
        typeof p !== 'string' ||
        !p ||
        p.length > 4095 ||
        /[\p{Cc}\p{Cf}\\]/u.test(p) ||
        isAbsolute(p) ||
        p
          .split('/')
          .some((s: string) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git'),
    ) ||
    new Set(value).size !== value.length ||
    Buffer.byteLength(JSON.stringify(value)) > INTEGRATION_LIMITS.reportBytes
  )
    throw new DomainError('INVALID_INPUT', '--files 必须是无重复的有界相对路径 JSON 数组');
  return [...value].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
function verifyTrialFiles(
  stage: number,
  plan: IntegrationTrialPlan,
  journal: IntegrationTrialJournal,
  record: IntegrationTrialRecord,
) {
  const owned = journal.entries(record.progress.id);
  checkOwnedTree(stage, owned);
  const root = fstatSync(stage, { bigint: true });
  if (
    identity(root) !== record.progress.stageIdentity ||
    (root.mode & 0o777n) !== 0o700n ||
    owned.size !== plan.entries.length
  )
    throw new DomainError('INTEGRATION_TRIAL_INCOMPLETE', '试应用目录与所有权清单不一致');
  for (const entry of plan.entries) {
    const row = owned.get(entry.path);
    if (!row || row.kind !== entry.kind)
      throw new DomainError('INTEGRATION_TRIAL_INCOMPLETE', '试应用文件缺失');
    withOwnedDirectory(
      stage,
      entry.kind === 'directory'
        ? entry.path
        : dirname(entry.path) === '.'
          ? ''
          : dirname(entry.path),
      owned,
      (fd) => {
        const s =
          entry.kind === 'directory'
            ? fstatSync(fd, { bigint: true })
            : lstatSync(fdPath(fd, basename(entry.path)), { bigint: true });
        if ((s.mode & 0o777n) !== (entry.gitMode === '100644' ? 0o600n : 0o700n))
          throw new DomainError('INTEGRATION_TRIAL_INCOMPLETE', '试应用文件模式不一致');
      },
    );
    if (entry.kind === 'file') {
      const data = readOwnedFile(stage, row, owned, entry.bytes);
      if (
        data.length !== entry.bytes ||
        objectHash(plan.objectFormat, 'blob', data) !== entry.objectId
      )
        throw new DomainError('INTEGRATION_TRIAL_INCOMPLETE', '试应用文件字节不一致');
    }
  }
  fsyncSync(stage);
}

/** One explicitly confirmed PRIVATE preview. Never writes the original target,
 * shared metadata, Git state, Task/Run/results, or replays an interrupted write. */
export async function localIntegrationTrial(
  home: string,
  integrationId: string,
  target: string,
  files: readonly string[],
  ask: (prompt: string) => Promise<string>,
  options: IntegrationTrialOptions = {},
) {
  nodeId(integrationId);
  const selectedPaths = integrationTrialSelection(files),
    log = options.log ?? console.log;
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '试应用仅支持 Linux 本人节点');
  if (!isAbsolute(target) || resolve(target) !== target)
    throw new DomainError('INVALID_INPUT', '试应用目标必须是规范的绝对路径');
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  const protectedPaths = [home, ...c.directories.flatMap((w) => [w.root, w.gitDir])];
  if (protectedPaths.slice(1).some((p) => inside(home, p) || inside(p, home)))
    throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '私有状态不能与代码目录重叠');
  const live = () => {
    if (options.signal?.aborted)
      throw new DomainError('INTEGRATION_TRIAL_INTERRUPTED', '已停止后续试应用写入，保留现场');
  };
  const bound = () => {
    live();
    if (
      restorePrivatePath(home, true) !== homeIdentity ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原本机身份或授权目录已变化');
  };
  const inspect = async () => {
    bound();
    const v = await nodeRequest<IntegrationView>(
      c.controlUrl,
      'integration-inspect',
      { integrationId },
      c.nodeToken,
      options.signal,
    );
    bound();
    const o = v.operation;
    if (
      !o ||
      o.id !== integrationId ||
      o.projectId !== c.projectId ||
      o.spaceId !== c.spaceId ||
      o.target.checkpoint.request.nodeId !== c.nodeId ||
      !c.directories.some((w) => w.id === o.target.checkpoint.request.workspaceId) ||
      o.inputHash !==
        trialHash({
          id: o.id,
          taskId: o.taskId,
          source: o.source,
          target: o.target,
          material: o.material,
        }) ||
      !o.report ||
      o.report.integrationId !== o.id ||
      o.report.inputHash !== o.inputHash ||
      v.reportHash !== trialHash(o.report)
    )
      throw new DomainError(
        'INTEGRATION_SCOPE_CHANGED',
        '试应用与固定来源、预检、目标或当前本人身份不一致',
      );
    parseIntegrationReport(o.report);
    return v;
  };
  // Current original-owner/task/node authority precedes even historical receipts.
  const original = await inspect(),
    o = original.operation,
    reportHash = trialHash(o.report);
  const w = c.directories.find((w) => w.id === o.target.checkpoint.request.workspaceId)!;
  const journal = new IntegrationTrialJournal(home);
  let parent: PinnedRestoreParent | undefined,
    stage: number | undefined,
    record: IntegrationTrialRecord | undefined;
  let stageAttempted = false,
    publicationAttempted = false;
  const update = async () => {
    journal.save(record!);
    await options.onProgress?.(structuredClone(record!.progress));
    await setImmediate();
    live();
  };
  const stageUnchanged = () => {
    const p = record!.progress;
    if (
      !p.stageIdentity ||
      identity(lstatSync(fdPath(parent!.fd, p.stageName), { bigint: true })) !== p.stageIdentity
    )
      throw new DomainError('RESTORE_FILES_CHANGED', '试应用暂存目录已移动或替换');
  };
  const current = async () => {
    const v = await inspect();
    if (
      !v.available ||
      !['awaiting_choice', 'conflict'].includes(v.operation.state) ||
      v.operation.application ||
      v.operation.inputHash !== o.inputHash ||
      trialHash(v.operation.report) !== reportHash
    )
      throw new DomainError('INTEGRATION_UNAVAILABLE', '试应用原权限、材料、预检或目标已变化');
    assertCodeQuiescent(home, w.root, w.rootIdentity);
  };
  const clean = () => verifyCleanCommit(home, c, w, o.target.checkpoint.manifest);
  try {
    const previous = journal.row(target);
    if (previous) {
      const p = previous.progress;
      if (
        previous.binding !== binding ||
        p.integrationId !== integrationId ||
        p.inputHash !== o.inputHash ||
        p.reportHash !== reportHash ||
        canonicalJson(p.selectedPaths) !== canonicalJson(selectedPaths)
      )
        throw new DomainError(
          'INTEGRATION_TRIAL_TARGET_CLAIMED',
          '目标已有不同原身份、操作或选择的试应用记录',
        );
      if (!['ready', 'failed', 'interrupted'].includes(p.state)) {
        p.state = 'interrupted';
        p.materialState = 'unknown';
        p.errorCode = 'INTEGRATION_TRIAL_INTERRUPTED';
        journal.save(previous);
      }
      log(
        '仅返回本机历史证据，不检查输出目录，不重新读取材料、写入或自动发布；当前材料可用性另列。',
      );
      return { ...p, historical: true, currentMaterialAvailable: original.available };
    }
    await current();
    checkRestoreHelper();
    const observation = inspectRestoreTarget(target, protectedPaths);
    // Reject unsupported parent before asking, but do not create any trial files.
    parent = new PinnedRestoreParent(
      observation,
      c.directories.flatMap((w) => [w.rootIdentity, w.gitIdentity]),
    );
    parent.assertAbsent();
    if (!o.report?.plan || o.report.plan.omittedFiles || o.report.reason)
      throw new DomainError('INTEGRATION_TRIAL_UNSUPPORTED', '试应用需要完整成功预检');
    for (const path of selectedPaths) {
      const entry = o.report.plan.files.find((e) => e.path === path);
      if (!entry || entry.conflict || !['add', 'modify', 'delete'].includes(entry.action))
        throw new DomainError(
          'INTEGRATION_TRIAL_UNSUPPORTED',
          '只能选择完整预检中的无冲突新增、修改或删除',
        );
    }
    log(
      `成果 ${terminalLabel(o.source.title)} · v${o.source.revision}\n共同起点 ${o.source.code.base.commit}\n来源 ${o.material.manifest.commit}\n原目标 ${o.target.manifest.commit}\n恢复副本 ${o.target.retentionId}\n原代码目录 ${terminalLabel(w.root)}\n新私有目录 ${terminalLabel(target)}\n选择：\n${selectedPaths.map(terminalLabel).join('\n')}`,
    );
    log(
      '只创建并排他发布新的独立试应用文件；不向原目标应用代码，不共享文件、字节或元数据，不创建 Git 状态，不运行脚本或模型。中断或结果未知时保留现场，不自动重写、回滚或清理。',
    );
    if ((await ask(`输入 TRIAL ${integrationId}：`)) !== `TRIAL ${integrationId}`)
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认，没有创建试应用目录');
    await current();
    await clean();
    if (canonicalJson(inspectRestoreTarget(target, protectedPaths)) !== canonicalJson(observation))
      throw new DomainError('RESTORE_TARGET_CHANGED', '确认期间目标父目录变化');
    const materials = async <T>(
      visit: (s: RestoreMaterialSource, t: RestoreMaterialSource) => Promise<T>,
    ) =>
      withRestoreSource(home, o.target.retentionId, options.signal, async (t) => {
        const open = o.material.kind === 'transfer' ? withReceivedRestoreSource : withRestoreSource;
        return open(home, o.material.id, options.signal, async (s) => {
          if (
            s.binding !== binding ||
            t.binding !== binding ||
            canonicalJson(s.manifest) !== canonicalJson(o.material.manifest) ||
            canonicalJson(t.manifest) !== canonicalJson(o.target.manifest)
          )
            throw new DomainError('SNAPSHOT_INCOMPLETE', '完整副本与固定来源不匹配');
          return visit(s, t);
        });
      });
    return await materials(async (source, targetSource) => {
      const snapshot = async (s: RestoreMaterialSource) => {
        const m = s.manifest,
          value = await s.snapshot((read) =>
            verifySnapshot(m.objectFormat, m.commit, m.tree, read),
          );
        if (
          value.snapshotHash !== m.snapshotHash ||
          canonicalJson(value.coverage) !== canonicalJson(m.coverage)
        )
          throw new DomainError('SNAPSHOT_INCOMPLETE', '完整对象与原核验指纹不一致');
        return value;
      };
      const unexpired = () => {
        if (
          [source.manifest, targetSource.manifest].some(
            (m) => Date.parse(m.expiresAt) <= Date.now(),
          )
        )
          throw new DomainError(
            'RESTORE_RETENTION_EXPIRED',
            '来源或目标副本已到期；不发布试应用目录',
          );
      };
      const build = async () => {
        await current();
        const s = await snapshot(source),
          t = await snapshot(targetSource),
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
          throw new DomainError('WORKSPACE_COMMIT_CHANGED', '原目标对象存储身份变化');
        const plan = await buildIntegrationTrialPlan(
          start.objectFormat,
          { base: start.tree, source: o.material.manifest.tree, target: o.target.manifest.tree },
          { base: base!, source: s, target: t },
          o.report!.plan!,
          selectedPaths,
          w.root,
        );
        // The hidden staging name is longer than many final destination names.
        for (const e of plan.entries)
          for (const root of [target, join(dirname(target), `.hexu-restore-${'0'.repeat(36)}`)])
            if (Buffer.byteLength(join(root, e.path)) > 4095)
              throw new DomainError('RESTORE_EXPANSION_LIMIT', '试应用目标完整路径过长');
        await clean();
        await current();
        await source.authorized();
        await targetSource.authorized();
        return plan;
      };
      const plan = await build();
      parent!.revalidate();
      parent!.assertAbsent();
      bound();
      source.stillBound();
      targetSource.stillBound();
      record = journal.begin({
        binding,
        observation,
        manifest: plan.manifest,
        integrationId,
        inputHash: o.inputHash,
        reportHash,
      });
      await update();
      const p = record.progress;
      stageAttempted = true;
      stage = parent!.createStage(p.stageName);
      p.stageIdentity = identity(fstatSync(stage, { bigint: true }));
      p.state = 'writing';
      p.materialState = 'staging';
      await update();
      const owned = journal.entries(p.id),
        deadline = Date.now() + 120000;
      for (const entry of plan.entries) {
        bound();
        source.stillBound();
        targetSource.stillBound();
        parent!.revalidate();
        stageUnchanged();
        if (Date.now() > deadline)
          throw new DomainError('INTEGRATION_TRIAL_LIMIT', '试应用写入超过时间边界');
        p.intent = entry.path;
        await update(); // Exact per-entry intent is durable before mkdir/open/write.
        bound();
        parent!.revalidate();
        stageUnchanged();
        withOwnedDirectory(
          stage!,
          dirname(entry.path) === '.' ? '' : dirname(entry.path),
          owned,
          (fd) => {
            const path = fdPath(fd, basename(entry.path));
            let child: number;
            if (entry.kind === 'directory') {
              mkdirSync(path, { mode: 0o700 });
              child = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
            } else child = openSync(path, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
            try {
              const initial = ownedEntry(entry.path, entry.kind, child);
              journal.track(p.id, initial);
              owned.set(entry.path, initial);
              if (entry.kind === 'file') {
                if (
                  entry.data.length !== entry.bytes ||
                  objectHash(plan.objectFormat, 'blob', entry.data) !== entry.objectId
                )
                  throw new DomainError('SNAPSHOT_INCOMPLETE', '试应用内存对象不匹配');
                let offset = 0;
                while (offset < entry.data.length) {
                  const n = writeSync(child, entry.data, offset, entry.data.length - offset);
                  if (!n) throw new Error('Short write');
                  offset += n;
                }
                fchmodSync(child, entry.gitMode === '100755' ? 0o700 : 0o600);
              }
              fsyncSync(child);
              fsyncSync(fd);
            } finally {
              try {
                const actual = ownedEntry(entry.path, entry.kind, child);
                journal.track(p.id, actual);
                owned.set(entry.path, actual);
              } finally {
                closeSync(child);
              }
            }
          },
        );
        if (entry.kind === 'file') {
          p.completedFiles++;
          p.writtenBytes += entry.bytes;
        }
        p.intent = null;
        await update();
      }
      stageUnchanged();
      verifyTrialFiles(stage!, plan, journal, record);
      p.state = 'verified';
      p.verifiedAt = new Date().toISOString();
      await update();
      p.state = 'publishing';
      await update();
      // The last observable progress hook precedes fresh durable-object hashing,
      // authority and full original-target checks. Never trust only bundle metadata.
      const fresh = await build();
      if (fresh.manifestHash !== plan.manifestHash)
        throw new DomainError('INTEGRATION_PLAN_CHANGED', '试应用原计划变化');
      // All authority awaits are complete. Capture the complete original target
      // last, then recheck its exact observation synchronously after stage hashing.
      let assertOriginalUnchanged: (() => void) | undefined;
      await verifyCleanCommit(home, c, w, o.target.checkpoint.manifest, [], (check) => {
        assertOriginalUnchanged = check;
      });
      bound();
      source.stillBound();
      targetSource.stillBound();
      parent!.revalidate();
      parent!.assertAbsent();
      stageUnchanged();
      verifyTrialFiles(stage!, plan, journal, record);
      assertOriginalUnchanged!();
      assertCodeQuiescent(home, w.root, w.rootIdentity);
      unexpired();
      publicationAttempted = true;
      const outcome = publishRestore(parent!, p.stageName, stage!);
      if (outcome === 'not_published') {
        publicationAttempted = false;
        throw new DomainError('RESTORE_PUBLISH_REFUSED', '排他发布拒绝，暂存保留，目标未覆盖');
      }
      if (outcome === 'unknown')
        throw new DomainError(
          'INTEGRATION_TRIAL_PUBLICATION_UNKNOWN',
          '发布或同步未确认；保留证据，不猜测或重试',
        );
      parent!.revalidate();
      if (
        identity(lstatSync(fdPath(parent!.fd, basename(target)), { bigint: true })) !==
        p.stageIdentity
      )
        throw new DomainError('INTEGRATION_TRIAL_PUBLICATION_UNKNOWN', '发布后目标身份变化');
      verifyTrialFiles(stage!, plan, journal, record);
      p.materialState = 'published';
      p.state = 'ready';
      p.publishedAt = new Date().toISOString();
      p.errorCode = null;
      journal.save(record);
      return { ...p, historical: false, currentMaterialAvailable: true };
    });
  } catch (cause) {
    if (!record) throw cause;
    const p = record.progress;
    p.state = publicationAttempted || options.signal?.aborted ? 'interrupted' : 'failed';
    p.errorCode = publicationAttempted
      ? 'INTEGRATION_TRIAL_PUBLICATION_UNKNOWN'
      : options.signal?.aborted
        ? 'INTEGRATION_TRIAL_INTERRUPTED'
        : cause instanceof DomainError
          ? cause.code
          : 'INTEGRATION_TRIAL_IO_FAILED';
    p.publishedAt = null;
    p.materialState =
      publicationAttempted || (stageAttempted && !p.stageIdentity)
        ? 'unknown'
        : stageAttempted
          ? 'staging'
          : 'none';
    journal.save(record); // If persistence fails, retain the earlier durable intent.
    return { ...p, historical: false, currentMaterialAvailable: null };
  } finally {
    if (stage !== undefined) closeSync(stage);
    parent?.close();
    journal.close();
  }
}
