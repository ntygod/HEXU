import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  parseIntegrationApplicationReport,
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
import { integrationAdditions } from './integration-application-plan.js';
import { inspectRestoreTarget, type RestoreEntry } from './checkpoint-restore-plan.js';
import { PinnedRestoreParent } from './checkpoint-restore-files.js';
import { checkIntegrationAddHelper, publishIntegrationAddition } from './integration-add-files.js';
import { WorkspaceLease } from '../workspace-lease.js';
import { terminalLabel } from './terminal-label.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
type Added = RestoreEntry & { identity: string };
interface LocalApplication {
  binding: string;
  integrationId: string;
  applicationId: string;
  inputHash: string;
  root: string;
  phase: 'prepared' | 'applying' | 'completed' | 'failed' | 'needs_attention';
  added: Added[];
  intent: string | null;
  pending: IntegrationApplicationReport | null;
  acknowledged: number;
}
function validateLocalShape(record: LocalApplication) {
  const invalid = () =>
    new DomainError('INTEGRATION_JOURNAL_INVALID', '本机应用证据不完整或不一致；保留原凭证和写锁');
  const path = (value: unknown) =>
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 4096 &&
    !/[\\\p{Cc}\p{Cf}]/u.test(value) &&
    !value.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git');
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.root !== 'string' ||
    !isAbsolute(record.root) ||
    resolve(record.root) !== record.root ||
    Buffer.byteLength(record.root) > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(record.root) ||
    typeof record.binding !== 'string' ||
    typeof record.inputHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.binding) ||
    !/^[a-f0-9]{64}$/.test(record.inputHash) ||
    !['prepared', 'applying', 'completed', 'failed', 'needs_attention'].includes(record.phase) ||
    !Array.isArray(record.added) ||
    record.added.length > 80 ||
    ![0, 1, 2].includes(record.acknowledged) ||
    (record.intent !== null && !path(record.intent))
  )
    throw invalid();
  try {
    nodeId(record.integrationId);
    nodeId(record.applicationId);
  } catch {
    throw invalid();
  }
  const seen = new Set<string>();
  for (const entry of record.added) {
    if (
      !entry ||
      !path(entry.path) ||
      seen.has(entry.path) ||
      entry.kind !== 'file' ||
      !['100644', '100755'].includes(entry.gitMode) ||
      typeof entry.objectId !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.objectId) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 8 * 1024 * 1024 ||
      typeof entry.identity !== 'string' ||
      !/^\d+:\d+$/.test(entry.identity)
    )
      throw invalid();
    seen.add(entry.path);
  }
  if (record.pending !== null) {
    try {
      parseIntegrationApplicationReport(record.pending);
    } catch {
      throw invalid();
    }
  }
}
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
  if (
    (record.phase === 'completed' &&
      (record.intent !== null || seen.size !== application.paths.length)) ||
    (record.phase === 'failed' && (record.intent !== null || record.added.length > 0)) ||
    (record.phase === 'prepared' && (record.intent !== null || record.added.length > 0))
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
    if (storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name='applications'").get()) {
      const rows = storage.db.prepare('SELECT id,body FROM applications').all() as {
        id: string;
        body: string;
      }[];
      for (const row of rows) {
        let r: LocalApplication;
        try {
          r = JSON.parse(row.body) as LocalApplication;
          validateLocalShape(r);
          if (r.integrationId !== row.id) throw new Error('Journal identity mismatch');
        } catch {
          throw new DomainError('INTEGRATION_UNSETTLED', '应用日志无效，不能删除原凭证');
        }
        if (
          !r ||
          !Array.isArray(r.added) ||
          r.pending !== null ||
          r.intent !== null ||
          !['completed', 'failed'].includes(r.phase) ||
          (r.phase === 'completed'
            ? r.acknowledged !== 2 || !r.added.length
            : r.added.length > 0 || ![0, 1, 2].includes(r.acknowledged))
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
        }) ||
      !c.directories.some((w) => w.id === o.target.checkpoint.request.workspaceId)
    )
      throw new DomainError('INTEGRATION_SCOPE_CHANGED', '应用不属于本机固定来源、选择或目标');
    return view;
  };
  const journal = new AgentStorage(join(home, 'integration-application'));
  let lease: WorkspaceLease | undefined;
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
      ? (JSON.parse(row.body) as LocalApplication)
      : undefined;
    const save = () => {
      bound();
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
        appliedPaths: record!.added.map((e) => e.path),
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
      if (
        record.binding !== binding ||
        record.applicationId !== a.id ||
        record.inputHash !== a.inputHash ||
        record.root !== w.root
      )
        throw new DomainError('INTEGRATION_SCOPE_CHANGED', '本机应用日志与原身份或目标不一致');
      log('只对账原应用证据；不会再次写入、续写、删除文件或自动回滚。');
      if (record.phase === 'prepared' || record.phase === 'applying') {
        // First reconcile the original start packet, then record the interruption.
        // If cancellation definitively won before start, no write ever began.
        if (o.state === 'cancelled' && !a.reports.length) {
          if (
            record.phase !== 'prepared' ||
            record.added.length ||
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
      return { integrationId, state: record.phase, appliedPaths: record.added.map((e) => e.path) };
    }
    if (!original.available || o.state !== 'queued' || a.reports.length)
      throw new DomainError(
        'INTEGRATION_UNAVAILABLE',
        original.unavailableReason ?? '应用已关闭或已开始，不能建立第二次写入',
        409,
      );
    checkIntegrationAddHelper();
    log(
      `成果 ${terminalLabel(o.source.title)} · v${o.source.revision}\n来源 ${o.material.manifest.commit}\n目标 ${o.target.manifest.commit}\n恢复副本 ${o.target.retentionId}\n本机目标 ${terminalLabel(w.root)}\n选定新增文件：\n${a.paths.join('\n')}`,
    );
    log(
      '只新增所选普通文件，父目录必须已存在。保留未选文件、HEAD与索引；不调用模型、不提交、不覆盖。确认同时共享应用阶段及已写文件名。中断/部分失败保留现场和写锁，不自动恢复。',
    );
    if ((await ask(`输入 APPLY ${a.id}：`)) !== `APPLY ${a.id}`)
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认本机写入，原应用范围仍可在任务中取消');
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
      const additions = integrationAdditions(
        start.objectFormat,
        o.target.manifest.tree,
        t,
        plan,
        a.paths,
        w.root,
      );
      const observations = additions.map((e) =>
        inspectRestoreTarget(join(w.root, e.path), [home, w.gitDir]),
      );
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
      };
      try {
        save();
      } catch (e) {
        lease.release();
        throw e;
      }
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
        for (const [index, entry] of additions.entries()) {
          await current('applying', true);
          await source.authorized();
          await target.authorized();
          await verifyCleanCommit(home, c, w, o.target.checkpoint.manifest, record.added);
          const parent = new PinnedRestoreParent(observations[index]!);
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
        await current('applying', true);
        await source.authorized();
        await target.authorized();
        await verifyCleanCommit(home, c, w, o.target.checkpoint.manifest, record.added);
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
          record.phase = record.added.length || record.intent ? 'needs_attention' : 'failed';
          record.pending = packet(record.phase, failure(cause));
          save();
        }
      }
      releaseSettled();
      await publish();
      return { integrationId, state: record.phase, appliedPaths: record.added.map((e) => e.path) };
    });
  } finally {
    lease?.close(); // close never erases a possibly live/unknown claim.
    journal.close();
  }
}
