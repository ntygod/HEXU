import { closeSync, fstatSync, lstatSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  parseIntegrationReport,
  type IntegrationPlan,
  type IntegrationView,
} from '../../../../packages/contracts/src/integrations.js';
import {
  INTEGRATION_TRIAL_DIFFERENCE_LIMITS as LIMIT,
  parseIntegrationTrialDifference,
  type IntegrationTrialDifferenceReport,
  type IntegrationTrialDifferenceReceipt,
} from '../../../../packages/contracts/src/integration-trial.js';
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
import { verifySnapshot } from './checkpoint-objects.js';
import { captureCommitReference } from './checkpoints.js';
import { verifyCleanCommit } from './committed-workspace.js';
import { assertCodeQuiescent } from './result-code.js';
import { buildCodeDifferenceSummary } from './result-code-diff.js';
import { buildIntegrationTrialPlan } from './integration-trial-plan.js';
import { verifyTrialFiles } from './integration-trial.js';
import { fdPath, identity, PinnedRestoreParent } from './checkpoint-restore-files.js';
import { IntegrationTrialJournal, trialHash } from './integration-trial-journal.js';
import { terminalLabel } from './terminal-label.js';

export type IntegrationTrialDifferenceMetadata = Omit<
  IntegrationTrialDifferenceReport,
  'difference'
>;
/** Pure display builder. No disk/Git readers, unselected paths or private manifest
 * fields are accepted. The caller has verified the fixed plan and blob maps. */
export function buildIntegrationTrialDifference(
  metadata: IntegrationTrialDifferenceMetadata,
  plan: IntegrationPlan,
  targetObjects: ReadonlyMap<string, Buffer>,
  sourceObjects: ReadonlyMap<string, Buffer>,
): IntegrationTrialDifferenceReport {
  const fixed = structuredClone(metadata);
  const changes = fixed.selectedPaths.map((path) => {
    const file = plan.files.find((file) => file.path === path);
    if (!file || file.conflict || !['add', 'modify', 'delete'].includes(file.action))
      throw new DomainError('INTEGRATION_PLAN_CHANGED', '候选选择与原完整预检不一致');
    return { path, before: file.target, after: file.source };
  });
  const difference = buildCodeDifferenceSummary(
    changes,
    targetObjects,
    sourceObjects,
    (value) =>
      Buffer.byteLength(JSON.stringify(value)) <= LIMIT.differenceBytes &&
      Buffer.byteLength(JSON.stringify({ ...fixed, difference: value })) <= LIMIT.reportBytes,
  );
  return parseIntegrationTrialDifference({ ...fixed, difference });
}

export interface IntegrationTrialDifferenceOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
}
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
const unavailable = () =>
  new DomainError(
    'INTEGRATION_TRIAL_DIFFERENCE_UNAVAILABLE',
    '候选原身份、权限、完整材料、预检或已发布目录不再满足只读核验条件',
  );

/** Verify an already-published PRIVATE candidate after explicit read consent, then
 * separately authorize one immutable shared report. Lost ACK replay only sends the
 * original durable packet under current authority; it never rereads any material. */
export async function shareIntegrationTrialDifference(
  home: string,
  integrationId: string,
  trialId: string,
  ask: (prompt: string) => Promise<string>,
  options: IntegrationTrialDifferenceOptions = {},
): Promise<IntegrationTrialDifferenceReceipt> {
  nodeId(integrationId);
  nodeId(trialId);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '候选差异只读核验仅支持 Linux 本人节点');
  home = resolve(home);
  const log = options.log ?? console.log,
    homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  if (
    c.directories.flatMap((w) => [w.root, w.gitDir]).some((p) => inside(home, p) || inside(p, home))
  )
    throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '节点私有状态不能与代码目录重叠');
  const bound = () => {
    if (options.signal?.aborted)
      throw new DomainError(
        'INTEGRATION_TRIAL_DIFFERENCE_INTERRUPTED',
        '已停止候选差异操作，保留原证据',
      );
    if (
      restorePrivatePath(home, true) !== homeIdentity ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError(
        'CHECKPOINT_SCOPE_CHANGED',
        '原节点身份或授权目录已变化，不能接管原候选',
      );
  };
  const inspect = async () => {
    bound();
    const view = await nodeRequest<IntegrationView>(
      c.controlUrl,
      'integration-inspect',
      { integrationId },
      c.nodeToken,
      options.signal,
    );
    bound();
    const o = view.operation;
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
      o.report.integrationId !== integrationId ||
      o.report.inputHash !== o.inputHash ||
      view.reportHash !== trialHash(o.report)
    )
      throw unavailable();
    parseIntegrationReport(o.report);
    return view;
  };
  const journal = new IntegrationTrialJournal(home);
  try {
    // Hold the original trial guard even during consent and network waits.
    const original = await inspect(),
      o = original.operation;
    const record = journal.byId(trialId);
    if (!record)
      throw new DomainError('INTEGRATION_TRIAL_NOT_FOUND', '原节点没有此候选的已持久记录');
    const p = record.progress;
    if (
      record.binding !== binding ||
      p.integrationId !== integrationId ||
      p.inputHash !== o.inputHash ||
      p.reportHash !== trialHash(o.report) ||
      p.state !== 'ready' ||
      p.materialState !== 'published' ||
      !p.publishedAt ||
      !p.stageIdentity
    )
      throw unavailable();
    let local = journal.difference(record);
    if (local?.receipt) {
      log(
        `仅返回已共享历史回执；原核验时间 ${local.report.comparedAt}，不重新读取对象或候选目录。`,
      );
      return local.receipt;
    }
    if (local?.state === 'pending') {
      log(
        `仅对账上次明确共享的固定报告；原核验时间 ${local.report.comparedAt}，不重新读取对象或候选目录。`,
      );
    } else {
      const w = c.directories.find((w) => w.id === o.target.checkpoint.request.workspaceId)!;
      const current = async () => {
        const view = await inspect();
        if (
          !view.available ||
          !['awaiting_choice', 'conflict'].includes(view.operation.state) ||
          view.operation.application ||
          view.operation.inputHash !== o.inputHash ||
          trialHash(view.operation.report) !== p.reportHash ||
          !o.report?.plan ||
          o.report.reason ||
          o.report.plan.omittedFiles
        )
          throw unavailable();
        assertCodeQuiescent(home, w.root, w.rootIdentity);
      };
      await current();
      log(
        `候选 ${trialId}\n整合 ${integrationId}\n已生成 ${p.publishedAt}\n私有目录 ${terminalLabel(p.target)}\n完整选择：\n${p.selectedPaths.map(terminalLabel).join('\n')}`,
      );
      log(
        '只读核验原固定完整对象、原目标与已发布候选的完整清单、所有权、模式和字节；不运行候选，不写回、不清理。之后另行确认才共享列出的文件名与有界正文。',
      );
      if ((await ask(`输入 DIFF_TRIAL ${trialId}：`)) !== `DIFF_TRIAL ${trialId}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '未确认候选差异读取');
      const verify = async () => {
        await current();
        return withRestoreSource(home, o.target.retentionId, options.signal, async (target) => {
          const open =
            o.material.kind === 'transfer' ? withReceivedRestoreSource : withRestoreSource;
          return open(home, o.material.id, options.signal, async (source) => {
            if (
              source.binding !== binding ||
              target.binding !== binding ||
              canonicalJson(source.manifest) !== canonicalJson(o.material.manifest) ||
              canonicalJson(target.manifest) !== canonicalJson(o.target.manifest)
            )
              throw unavailable();
            const snapshot = async (material: RestoreMaterialSource) => {
              const m = material.manifest;
              const value = await material.snapshot((read) =>
                verifySnapshot(m.objectFormat, m.commit, m.tree, read),
              );
              if (
                value.snapshotHash !== m.snapshotHash ||
                canonicalJson(value.coverage) !== canonicalJson(m.coverage)
              )
                throw new DomainError('SNAPSHOT_INCOMPLETE', '完整对象与原指纹不一致');
              return value;
            };
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
                if (tree !== start.tree) throw unavailable();
                base = await verifySnapshot(start.objectFormat, start.commit, start.tree, read);
              },
            );
            if (reference.repositoryIdentity !== o.target.checkpoint.manifest.repositoryIdentity)
              throw unavailable();
            const plan = await buildIntegrationTrialPlan(
              start.objectFormat,
              {
                base: start.tree,
                source: o.material.manifest.tree,
                target: o.target.manifest.tree,
              },
              { base: base!, source: s, target: t },
              o.report!.plan!,
              p.selectedPaths,
              w.root,
            );
            if (
              plan.manifestHash !== p.manifestHash ||
              canonicalJson(plan.manifest) !== canonicalJson(record.manifest)
            )
              throw new DomainError('INTEGRATION_PLAN_CHANGED', '候选完整清单与原持久证据不一致');
            await current();
            await source.authorized();
            await target.authorized();
            let assertOriginalUnchanged: (() => void) | undefined;
            await verifyCleanCommit(home, c, w, o.target.checkpoint.manifest, [], (check) => {
              assertOriginalUnchanged = check;
            });
            // All authority awaits precede exact synchronous candidate verification.
            const parent = new PinnedRestoreParent(
              record.observation,
              c.directories.flatMap((w) => [w.rootIdentity, w.gitIdentity]),
            );
            let candidate: number | undefined;
            try {
              parent.revalidate();
              candidate = parent.openStage(basename(p.target), p.stageIdentity!);
              verifyTrialFiles(candidate, plan, journal, record, false);
              if (
                identity(fstatSync(candidate, { bigint: true })) !== p.stageIdentity ||
                identity(lstatSync(fdPath(parent.fd, basename(p.target)), { bigint: true })) !==
                  p.stageIdentity
              )
                throw unavailable();
              parent.revalidate();
              assertOriginalUnchanged!();
              assertCodeQuiescent(home, w.root, w.rootIdentity);
              bound();
              source.stillBound();
              target.stillBound();
              if (
                [source.manifest, target.manifest].some(
                  (m) => Date.parse(m.expiresAt) <= Date.now(),
                )
              )
                throw new DomainError(
                  'RESTORE_RETENTION_EXPIRED',
                  '完整材料已到期，未生成或授权新差异',
                );
              return {
                source: new Map(s.objects.map((o) => [o.id, o.data])),
                target: new Map(t.objects.map((o) => [o.id, o.data])),
              };
            } finally {
              if (candidate !== undefined) closeSync(candidate);
              parent.close();
            }
          });
        });
      };
      const objects = await verify();
      const packet = buildIntegrationTrialDifference(
        {
          version: 1,
          kind: 'integration_trial_difference',
          integrationId,
          trialId,
          integrationInputHash: p.inputHash,
          preflightReportHash: p.reportHash,
          manifestHash: p.manifestHash,
          selection: 'apply_source',
          selectedPaths: [...p.selectedPaths],
          materializedAt: p.publishedAt,
          comparedAt: local?.report.comparedAt ?? new Date().toISOString(),
          trialOnly: true,
          applied: false,
          writeAuthorized: false,
          confirmPublication: true,
        },
        o.report!.plan!,
        objects.target,
        objects.source,
      );
      if (local && trialHash(packet) !== local.hash) throw unavailable();
      local = journal.freezeDifference(record, packet);
      log(`固定候选报告，原核验时间 ${packet.comparedAt}；本次已只读重验。`);
      log(JSON.stringify(packet, null, 2));
      log(
        '仅将上面完整选择、对象标识与有界正文共享给原任务当前有权限成员；无绝对路径、目录所有权或未选文件。候选不代表原目录已应用，不完成任务或创建成果。',
      );
      if ((await ask(`输入 SHARE_TRIAL_DIFF ${trialId}：`)) !== `SHARE_TRIAL_DIFF ${trialId}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '未共享；本机固定差异可保留，未授权写回');
      await verify();
      bound();
      local = journal.authorizeDifference(record, trialHash(packet));
    }
    await inspect(); // Current source/target/Task authority, but no disk/material recapture.
    const receipt = await nodeRequest<IntegrationTrialDifferenceReceipt>(
      c.controlUrl,
      'integration-trial-diff-publish',
      local.report,
      c.nodeToken,
      options.signal,
    );
    bound();
    return journal.acknowledgeDifference(record, receipt);
  } finally {
    journal.close();
  }
}
