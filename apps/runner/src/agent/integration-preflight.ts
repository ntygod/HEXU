import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  parseIntegrationReport,
  type IntegrationView,
  type IntegrationReport,
  type IntegrationReason,
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
import { verifySnapshot } from './checkpoint-objects.js';
import { captureCommitReference } from './checkpoints.js';
import { verifyCleanCommit } from './committed-workspace.js';
import { assertCodeQuiescent } from './result-code.js';
import { buildIntegrationPlan } from './integration-plan.js';
import { terminalLabel } from './terminal-label.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
function reason(cause: unknown): IntegrationReason {
  const code = cause instanceof DomainError ? cause.code : '';
  if (code === 'WORKSPACE_COMMIT_CHANGED') return 'target_changed';
  if (code.includes('WRITER_ACTIVE')) return 'workspace_busy';
  if (code.includes('LIMIT') || code.includes('BUDGET')) return 'budget_exceeded';
  if (code.includes('UNSUPPORTED') || code === 'RESTORE_PATH_UNSUPPORTED')
    return 'unsupported_snapshot';
  if (
    code.includes('SNAPSHOT') ||
    code.includes('RETENTION') ||
    code.includes('RESTORE_NOT_AVAILABLE') ||
    ['ENOENT', 'SQLITE_ERROR'].includes((cause as NodeJS.ErrnoException)?.code ?? '')
  )
    return 'objects_unavailable';
  return 'preflight_failed';
}

/** Explicit local read & bounded metadata sharing. Never touches target HEAD/index/files,
 * creates a model command, or confuses a preflight with application permission. */
export async function preflightIntegration(
  home: string,
  integrationId: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
) {
  nodeId(integrationId);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '整合预检目前仅支持Linux本人节点');
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  if (
    c.directories.flatMap((w) => [w.root, w.gitDir]).some((p) => inside(home, p) || inside(p, home))
  )
    throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '节点私有状态不能与代码目录重叠');
  const stillBound = () => {
    if (
      restorePrivatePath(home, true) !== homeIdentity ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '本机节点身份或授权目录已变化');
  };
  const inspect = async () => {
    stillBound();
    const view = await nodeRequest<IntegrationView>(
      c.controlUrl,
      'integration-inspect',
      { integrationId },
      c.nodeToken,
    );
    stillBound();
    const o = view.operation,
      t = o?.target.checkpoint;
    if (
      o?.id !== integrationId ||
      o.projectId !== c.projectId ||
      o.spaceId !== c.spaceId ||
      t?.request.nodeId !== c.nodeId ||
      o.inputHash !==
        hash({
          id: o.id,
          taskId: o.taskId,
          source: o.source,
          target: o.target,
          material: o.material,
        }) ||
      !c.directories.some((w) => w.id === t.request.workspaceId)
    )
      throw new DomainError('INTEGRATION_SCOPE_CHANGED', '预检与本机固定来源、目标或身份不一致');
    return view;
  };
  const journal = new AgentStorage(join(home, 'integration-preflight'));
  try {
    journal.db.exec(
      'CREATE TABLE IF NOT EXISTS publication(id INTEGER PRIMARY KEY CHECK(id=1),operation_id TEXT NOT NULL,binding TEXT NOT NULL,body TEXT NOT NULL)',
    );
    const pending = journal.db.prepare('SELECT * FROM publication WHERE id=1').get() as
      | { operation_id: string; binding: string; body: string }
      | undefined;
    if (pending && (pending.operation_id !== integrationId || pending.binding !== binding))
      throw new DomainError('INTEGRATION_PENDING', '先用原身份确认原预检回执，不能替换待发包', 409);
    const original = await inspect(),
      o = original.operation;
    let packet: IntegrationReport;
    if (pending) {
      if (o.state === 'cancelled' && !o.report) {
        // Definitive server cancellation settles an uncommitted local report. It
        // cannot become another operation's packet or block later explicit work.
        journal.db.prepare('DELETE FROM publication WHERE id=1').run();
        return { integrationId, state: 'cancelled', publication: 'not_published' };
      }
      packet = parseIntegrationReport(JSON.parse(pending.body));
      log('仅确认原预检报告的回执；不会重新读取目录或对象，也不会应用代码。');
    } else if (o.report) {
      return { integrationId, hash: hash(o.report), state: o.state, revision: o.revision };
    } else {
      if (o.state !== 'queued')
        throw new DomainError('INTEGRATION_CLOSED', '预检已取消或关闭', 409);
      if (!original.available)
        throw new DomainError(
          'INTEGRATION_UNAVAILABLE',
          original.unavailableReason ?? '当前材料不可用',
          409,
        );
      const w = c.directories.find((w) => w.id === o.target.checkpoint.request.workspaceId)!;
      const current = async () => {
        const v = await inspect();
        if (v.operation.inputHash !== o.inputHash || v.operation.state !== 'queued' || !v.available)
          throw new DomainError(
            'INTEGRATION_UNAVAILABLE',
            '预检已取消、目标被占用或当前材料权限已变化',
            409,
          );
        assertCodeQuiescent(home, w.root, w.rootIdentity);
      };
      log(
        `成果 ${terminalLabel(o.source.title)} · v${o.source.revision}\n共同起点 ${o.source.code.base.commit}\n来源 ${o.material.manifest.commit}\n目标 ${o.target.manifest.commit}\n恢复副本 ${o.target.retentionId}\n本机目标 ${terminalLabel(w.root)}`,
      );
      log(
        '只读取完整提交对象并核对目标HEAD、索引和文件。双方修改同一文件会列为冲突，不自动合并文本，不改动目录或调用模型。',
      );
      if ((await ask(`输入 PREFLIGHT ${integrationId}：`)) !== `PREFLIGHT ${integrationId}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '已取消本机预检，记录仍可在任务中关闭');
      await current();
      const readMaterials = async <T>(
        visit: (s: RestoreMaterialSource, t: RestoreMaterialSource) => Promise<T>,
      ) =>
        withRestoreSource(home, o.target.retentionId, undefined, async (target) => {
          const open =
            o.material.kind === 'transfer' ? withReceivedRestoreSource : withRestoreSource;
          return open(home, o.material.id, undefined, async (source) => {
            if (
              canonicalJson(source.manifest) !== canonicalJson(o.material.manifest) ||
              canonicalJson(target.manifest) !== canonicalJson(o.target.manifest)
            )
              throw new DomainError('SNAPSHOT_INCOMPLETE', '本机对象副本与固定清单不匹配');
            return visit(source, target);
          });
        });
      const snapshot = async (s: RestoreMaterialSource) => {
        const m = s.manifest;
        const value = await s.snapshot((read) =>
          verifySnapshot(m.objectFormat, m.commit, m.tree, read),
        );
        if (
          value.snapshotHash !== m.snapshotHash ||
          canonicalJson(value.coverage) !== canonicalJson(m.coverage)
        )
          throw new DomainError('SNAPSHOT_INCOMPLETE', '独立副本与原核验指纹不一致');
        return value;
      };
      const clean = () => verifyCleanCommit(home, c, w, o.target.checkpoint.manifest);
      let plan: IntegrationReport['plan'] = null,
        failure: IntegrationReason | null = null;
      try {
        plan = await readMaterials(async (source, target) => {
          const s = await snapshot(source),
            t = await snapshot(target);
          let base: Awaited<ReturnType<typeof verifySnapshot>> | undefined;
          const start = o.source.code.base;
          const reference = await captureCommitReference(
            w,
            start.commit,
            c.clientId,
            home,
            async (read, _commit, tree) => {
              if (tree !== start.tree)
                throw new DomainError('SNAPSHOT_INCOMPLETE', '共同起点对象不匹配');
              base = await verifySnapshot(start.objectFormat, start.commit, start.tree, read);
            },
          );
          if (reference.repositoryIdentity !== o.target.checkpoint.manifest.repositoryIdentity)
            throw new DomainError('WORKSPACE_COMMIT_CHANGED', '目标对象存储身份变化');
          const result = buildIntegrationPlan(
            start.objectFormat,
            { base: start.tree, source: o.material.manifest.tree, target: o.target.manifest.tree },
            { base: base!, source: s, target: t },
            w.root,
          );
          await clean();
          await current();
          await source.authorized();
          await target.authorized();
          return result;
        });
      } catch (e) {
        failure = reason(e);
      }
      // Current authority before exposing even locally computed filenames.
      const after = await inspect();
      if (after.operation.state !== 'queued')
        throw new DomainError('INTEGRATION_CLOSED', '预检已关闭，未共享结果', 409);
      packet = parseIntegrationReport({
        integrationId,
        inputHash: o.inputHash,
        observedAt: new Date().toISOString(),
        plan,
        reason: failure,
        confirmPublication: true,
      });
      log(JSON.stringify(packet, null, 2));
      log(
        '这份文件名、对象标识和冲突结论将共享给本任务成员。没有文件正文；预检记录不授权后续写入。',
      );
      if (
        (await ask(`确认共享，输入 SHARE_PREFLIGHT ${integrationId}：`)) !==
        `SHARE_PREFLIGHT ${integrationId}`
      )
        throw new DomainError('CONFIRMATION_REQUIRED', '未共享预检清单');
      if (packet.plan) {
        await current();
        await readMaterials(async (s, t) => {
          await snapshot(s);
          await snapshot(t);
          await clean();
        });
        await current();
      } else {
        const v = await inspect();
        if (v.operation.state !== 'queued')
          throw new DomainError('INTEGRATION_CLOSED', '预检已关闭', 409);
      }
      journal.db
        .prepare('INSERT INTO publication VALUES(1,?,?,?)')
        .run(integrationId, binding, JSON.stringify(packet));
    }
    await inspect(); // No object recapture or newer body on a lost acknowledgement.
    const receipt = await nodeRequest<{
      integrationId: string;
      hash: string;
      state: string;
      revision: number;
    }>(c.controlUrl, 'integration-publish', packet, c.nodeToken);
    if (receipt.integrationId !== integrationId || receipt.hash !== hash(packet))
      throw new DomainError('INVALID_RESPONSE', '预检回执不匹配，保留原待发包');
    journal.db.prepare('DELETE FROM publication WHERE id=1').run();
    return receipt;
  } finally {
    journal.close();
  }
}
